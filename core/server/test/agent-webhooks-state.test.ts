import { randomUUID } from "node:crypto";
import {
	type AgentWakeEvent,
	agentWebhookUrlProblem,
	isClaudeRoutineUrl,
} from "@autonomo.us/common";
import { describe, expect, it } from "vitest";
import {
	post,
	retryAfterMs,
	signature,
	type WebhookTransport,
	wakeText,
} from "../src/agent-webhooks/delivery.js";
import type { StoredAgentWebhook } from "../src/agent-webhooks/repository.js";
import {
	claimed,
	enqueued,
	finished,
	publicWebhook,
	switched,
	type WebhookTiming,
} from "../src/agent-webhooks/state.js";

const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const timing: WebhookTiming = {
	gapMs: 5_000,
	leaseMs: 60_000,
	retryDelaysMs: [10_000, 60_000],
	failuresBeforeDisable: 2,
	minRetryAfterMs: 10_000,
	maxRetryAfterMs: 3_600_000,
	eventsPerDelivery: 3,
};
const iso = (ms: number) => new Date(ms).toISOString();

function stored(extra: Partial<StoredAgentWebhook> = {}): StoredAgentWebhook {
	return {
		agentId: randomUUID(),
		workspaceId: randomUUID(),
		url: "https://hooks.example.com/agent",
		secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmU=",
		authKey: null,
		headers: [],
		events: ["mentions", "messages", "proposals"],
		status: "active",
		disabledReason: null,
		consecutiveFailures: 0,
		lastDeliveryAt: null,
		lastFailureAt: null,
		lastError: null,
		createdAt: iso(NOW),
		createdBy: "Founder",
		updatedAt: iso(NOW),
		queue: [],
		omitted: 0,
		delivery: null,
		dueAt: null,
		leaseId: null,
		leaseUntil: null,
		recentKeys: [],
		channelSeqs: {},
		version: 1,
		...extra,
	};
}
const message = (
	seq: number,
	type: AgentWakeEvent["type"] = "channel.message",
) =>
	({
		type,
		at: iso(NOW),
		channelId: "c1",
		channel: "general",
		messageId: `m${seq}`,
		seq,
		threadId: null,
		author: { kind: "user", id: "u1", name: "Ada" },
	}) as AgentWakeEvent;

describe("webhook state", () => {
	it("opens a POST one gap after the first event and folds later ones in", () => {
		let webhook = stored();
		webhook = enqueued(webhook, message(1), "k1", NOW, timing) ?? webhook;
		expect(webhook.dueAt).toBe(iso(NOW + 5_000));
		webhook =
			enqueued(webhook, message(2), "k2", NOW + 3_000, timing) ?? webhook;
		expect(webhook.dueAt).toBe(iso(NOW + 5_000));
		expect(webhook.queue).toHaveLength(2);
		// The same event again changes nothing.
		expect(enqueued(webhook, message(2), "k2", NOW, timing)).toBeNull();
		expect(
			enqueued(switched(webhook, false), message(3), "k3", NOW, timing),
		).toBeNull();
	});

	it("recognizes a retried post however much happened since", () => {
		const wide = { ...timing, eventsPerDelivery: 1000 };
		const add = (
			webhook: StoredAgentWebhook,
			event: AgentWakeEvent,
			key: string,
			replay = false,
		) => enqueued(webhook, event, key, NOW, wide, replay);
		const inChannel = (channelId: string, seq: number) =>
			({
				...message(seq),
				channelId,
				messageId: `${channelId}-${seq}`,
			}) as AgentWakeEvent;
		let webhook = add(stored(), inChannel("quiet", 7), "channel:quiet:7");
		if (!webhook) throw new Error("not enqueued");
		// 250 events elsewhere, in a busy channel and as decisions, push the
		// quiet channel's key out of the recent keys.
		for (let seq = 1; seq <= 200; seq++)
			webhook =
				add(webhook, inChannel("busy", seq), `channel:busy:${seq}`) ?? webhook;
		for (let n = 1; n <= 50; n++)
			webhook =
				add(
					webhook,
					{
						type: "proposal.decided",
						at: iso(NOW),
						proposalId: `p${n}`,
						action: "update",
						title: "Note",
						status: "approved",
						decidedBy: "Jared",
					},
					`proposal:p${n}`,
				) ?? webhook;
		expect(webhook.recentKeys).not.toContain("channel:quiet:7");
		expect(webhook.channelSeqs.quiet).toEqual([7]);
		expect(webhook.channelSeqs.busy).toHaveLength(50);
		// The quiet channel's post, retried, is still known.
		expect(
			add(webhook, inChannel("quiet", 7), "channel:quiet:7", true),
		).toBeNull();
		// So is a busy channel's retried post older than every one it remembers.
		expect(
			add(webhook, inChannel("busy", 3), "channel:busy:3b", true),
		).toBeNull();
		// A first report that old is late, not a retry: it is never dropped.
		expect(
			add(webhook, inChannel("busy", 3), "channel:busy:3b"),
		).not.toBeNull();
		// A post reported late, behind newer ones, is still new.
		const quiet = add(webhook, inChannel("quiet", 150), "channel:quiet:150");
		expect(
			add(quiet ?? webhook, inChannel("quiet", 30), "channel:quiet:30"),
		).not.toBeNull();
		expect(
			add(webhook, inChannel("busy", 190), "channel:busy:190b"),
		).toBeNull();
		expect(
			add(
				{ ...webhook, recentKeys: [] },
				inChannel("busy", 201),
				"channel:busy:201",
			),
		).not.toBeNull();
	});

	it("keeps mentions when the queue is full, counting what it drops", () => {
		let webhook = stored();
		for (const seq of [1, 2, 3])
			webhook =
				enqueued(webhook, message(seq), `k${seq}`, NOW, timing) ?? webhook;
		webhook = enqueued(webhook, message(4), "k4", NOW, timing) ?? webhook;
		expect(webhook.queue.map((event) => "seq" in event && event.seq)).toEqual([
			1, 2, 3,
		]);
		webhook =
			enqueued(webhook, message(5, "channel.mention"), "k5", NOW, timing) ??
			webhook;
		expect(webhook.queue.map((event) => event.type)).toEqual([
			"channel.message",
			"channel.message",
			"channel.mention",
		]);
		expect(webhook.omitted).toBe(2);
		expect(publicWebhook(webhook).pendingEvents).toBe(5);
	});

	it("claims under a lease, retries with backoff, and gives up after the last attempt", () => {
		const queued =
			enqueued(stored(), message(1), "k1", NOW, timing) ?? stored();
		expect(claimed(queued, "early", NOW, timing)).toBeNull();
		const first = claimed(queued, "a", NOW + 5_000, timing);
		expect(first?.delivery).toMatchObject({ attempts: 1, omitted: 0 });
		expect(first?.webhook).toMatchObject({
			queue: [],
			leaseId: "a",
			dueAt: iso(NOW + 65_000),
		});
		// Nobody else takes it while the lease holds, and a stale holder cannot finish it.
		expect(
			claimed(first?.webhook as StoredAgentWebhook, "b", NOW + 6_000, timing),
		).toBeNull();
		expect(
			finished(
				first?.webhook as StoredAgentWebhook,
				"b",
				{ kind: "ok" },
				NOW,
				timing,
			),
		).toBeNull();

		const failed = finished(
			first?.webhook as StoredAgentWebhook,
			"a",
			{ kind: "failed", error: "http_500" },
			NOW + 6_000,
			timing,
		) as StoredAgentWebhook;
		expect(failed).toMatchObject({
			dueAt: iso(NOW + 16_000),
			lastError: "http_500",
			leaseId: null,
		});
		const second = claimed(failed, "c", NOW + 16_000, timing);
		expect(second?.delivery?.id).toBe(first?.delivery?.id);
		expect(second?.delivery?.attempts).toBe(2);
		const third = claimed(
			finished(
				second?.webhook as StoredAgentWebhook,
				"c",
				{ kind: "failed", error: "timeout" },
				NOW + 17_000,
				timing,
			) as StoredAgentWebhook,
			"d",
			NOW + 77_000,
			timing,
		);
		expect(third?.delivery?.attempts).toBe(3);
		const gaveUp = finished(
			third?.webhook as StoredAgentWebhook,
			"d",
			{ kind: "failed", error: "network" },
			NOW + 78_000,
			timing,
		);
		expect(gaveUp).toMatchObject({
			delivery: null,
			dueAt: null,
			consecutiveFailures: 1,
			status: "active",
		});
	});

	it("keeps the agent's name from the first attempt for every retry", () => {
		const queued = enqueued(stored(), message(1), "k1", NOW, timing);
		if (!queued) throw new Error("not enqueued");
		const first = claimed(queued, "a", NOW + 5_000, timing, "Scout");
		expect(first?.delivery?.agentName).toBe("Scout");
		const failed = finished(
			first?.webhook as StoredAgentWebhook,
			"a",
			{ kind: "failed", error: "http_500" },
			NOW + 6_000,
			timing,
		) as StoredAgentWebhook;
		const retry = claimed(failed, "b", NOW + 16_000, timing, "Renamed");
		expect(retry?.delivery).toMatchObject({ agentName: "Scout", attempts: 2 });
	});

	it("gives up on a delivery whose last attempt crashed, and disables after repeated failures", () => {
		const crashed = stored({
			consecutiveFailures: 1,
			delivery: {
				id: "msg_1",
				createdAt: iso(NOW),
				events: [message(1)],
				omitted: 0,
				attempts: 3,
			},
			leaseId: "gone",
			leaseUntil: iso(NOW - 1),
			dueAt: iso(NOW - 1),
		});
		const claim = claimed(crashed, "new", NOW, timing);
		expect(claim?.delivery).toBeNull();
		expect(claim?.webhook).toMatchObject({
			status: "disabled",
			disabledReason: "failures",
			lastError: "interrupted",
			consecutiveFailures: 2,
		});
	});

	it("waits as a 429 asks, hands back a POST stopped for shutdown, and stops on 410", () => {
		const queued = enqueued(
			stored(),
			message(1),
			"k1",
			NOW,
			timing,
		) as StoredAgentWebhook;
		const claim = claimed(queued, "a", NOW + 5_000, timing);
		const held = claim?.webhook as StoredAgentWebhook;
		const throttled = finished(
			held,
			"a",
			{ kind: "throttled", retryAfterMs: 120_000 },
			NOW + 6_000,
			timing,
		);
		expect(throttled).toMatchObject({
			dueAt: iso(NOW + 126_000),
			lastError: "http_429",
			delivery: { attempts: 0 },
		});
		const capped = finished(
			held,
			"a",
			{ kind: "throttled", retryAfterMs: 99_999_999 },
			NOW,
			timing,
		);
		expect(capped?.dueAt).toBe(iso(NOW + 3_600_000));
		const released = finished(
			held,
			"a",
			{ kind: "released" },
			NOW + 7_000,
			timing,
		);
		expect(released).toMatchObject({
			dueAt: iso(NOW + 7_000),
			delivery: { attempts: 0 },
			leaseId: null,
		});
		expect(finished(held, "a", { kind: "gone" }, NOW, timing)).toMatchObject({
			status: "disabled",
			disabledReason: "gone",
			delivery: null,
		});
		expect(finished(held, "a", { kind: "revoked" }, NOW, timing)).toMatchObject(
			{ status: "disabled", disabledReason: "agent-revoked" },
		);
		// Paused while the POST was out: nothing is rescheduled.
		expect(
			finished(switched(held, false), "a", { kind: "ok" }, NOW, timing),
		).toMatchObject({ status: "paused", dueAt: null, delivery: null });
	});
});

describe("webhook delivery", () => {
	it("refuses a host that resolves to a private address before sending", async () => {
		let sent = 0;
		const transport: WebhookTransport = Object.assign(
			async () => {
				sent++;
				return { status: 200, retryAfter: null };
			},
			{ pinsAddress: true as const },
		);
		const target = {
			url: "https://hooks.example.com/x",
			secret: "whsec_c2VjcmV0",
			authKey: null,
			headers: [],
		};
		const options = { transport, timeoutMs: 1000, now: () => NOW };
		expect(
			await post(target, "msg_1", "{}", {
				...options,
				resolver: async () => [{ address: "10.0.0.5", family: 4 }],
			}),
		).toMatchObject({ kind: "failed", error: "blocked" });
		expect(
			await post(target, "msg_1", "{}", {
				...options,
				resolver: async () => [
					{ address: "93.184.215.14", family: 4 },
					{ address: "169.254.169.254", family: 4 },
				],
			}),
		).toMatchObject({ kind: "failed", error: "blocked" });
		expect(sent).toBe(0);
		expect(
			await post(target, "msg_1", "{}", {
				...options,
				resolver: async () => [{ address: "93.184.215.14", family: 4 }],
			}),
		).toMatchObject({ kind: "ok" });
		expect(sent).toBe(1);
	});

	it("classifies answers and failures without reading the body", async () => {
		const answering = (status: number, retryAfter: string | null = null) =>
			Object.assign(async () => ({ status, retryAfter }), {
				pinsAddress: false as const,
			});
		const target = {
			url: "https://hooks.example.com/x",
			secret: "whsec_c2VjcmV0",
			authKey: null,
			headers: [],
		};
		const send = (transport: WebhookTransport) =>
			post(target, "msg_1", "{}", { transport, timeoutMs: 50, now: () => NOW });
		expect(await send(answering(204))).toMatchObject({ kind: "ok" });
		expect(await send(answering(410))).toMatchObject({ kind: "gone" });
		expect(await send(answering(429, "30"))).toMatchObject({
			kind: "throttled",
			retryAfterMs: 30_000,
		});
		expect(await send(answering(302))).toMatchObject({ error: "redirect" });
		expect(await send(answering(503))).toMatchObject({ error: "http_503" });
		const hangs = Object.assign(
			(request: { signal: AbortSignal }) =>
				new Promise<never>((_resolve, reject) =>
					request.signal.addEventListener("abort", () =>
						reject(request.signal.reason),
					),
				),
			{ pinsAddress: false as const },
		);
		expect(await send(hangs)).toMatchObject({ error: "timeout" });
		const refuses = Object.assign(
			async () => {
				throw Object.assign(new Error("connect ECONNREFUSED"), {
					code: "ECONNREFUSED",
				});
			},
			{ pinsAddress: false as const },
		);
		expect(await send(refuses)).toMatchObject({ error: "network" });
	});

	it("reads retry-after as seconds or a date", () => {
		expect(retryAfterMs("120", NOW)).toBe(120_000);
		expect(retryAfterMs(new Date(NOW + 30_000).toUTCString(), NOW)).toBe(
			30_000,
		);
		expect(retryAfterMs("soon", NOW)).toBeNull();
		expect(retryAfterMs(null, NOW)).toBeNull();
	});

	it("signs as Standard Webhooks specifies", () => {
		// The example from the Standard Webhooks specification's test vectors.
		expect(
			signature(
				"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
				"msg_p5jXN8AQM9LWM0D4loKWxJek",
				"1614265330",
				'{"test": 2432232314}',
			),
		).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
	});

	it("words a wake as names and places, one line each", () => {
		const text = wakeText(
			"Scout",
			[
				message(41, "channel.mention"),
				{ ...message(42), author: { kind: "api-token", id: "t", name: "CI" } },
				message(43),
				{
					type: "proposal.decided",
					at: iso(NOW),
					proposalId: "p1",
					action: "update",
					title: "Ada\nLovelace",
					status: "rejected",
					decidedBy: "Jared",
				},
			],
			2,
		);
		expect(text).toBe(
			[
				"autonomo.us woke Scout with 6 updates:",
				"- Ada (person) mentioned you in #general, message 41.",
				'- Jared rejected your proposal to update "Ada Lovelace" in the shared Synapse.',
				"- 2 new messages in #general (messages 42–43) from CI and Ada.",
				"- 2 more updates did not fit here; your channels and proposals show them.",
				"",
				"Read each channel above with channels_read: it starts at your read mark, so it shows everything you have not handled. Mark what you handled with channels_mark_read.",
				"Call synapse_proposals to see each decision and its reason, and follow up on rejected ones.",
			].join("\n"),
		);
	});
});

describe("webhook URLs", () => {
	it("accepts public https URLs and recognizes a Claude Code routine", () => {
		const routine =
			"https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEF/fire";
		expect(agentWebhookUrlProblem(routine)).toBeNull();
		expect(
			agentWebhookUrlProblem("https://hooks.example.com/a?b=c"),
		).toBeNull();
		expect(isClaudeRoutineUrl(routine)).toBe(true);
		expect(isClaudeRoutineUrl("https://hooks.example.com/fire")).toBe(false);
		expect(agentWebhookUrlProblem("https://0x7f.1/x")).toContain("IP address");
		expect(agentWebhookUrlProblem("ftp://hooks.example.com")).toContain(
			"https",
		);
		expect(
			agentWebhookUrlProblem(`https://a.example/${"x".repeat(2000)}`),
		).toContain("at most");
	});
});

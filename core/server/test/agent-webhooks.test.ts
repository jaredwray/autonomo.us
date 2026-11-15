import { createHmac } from "node:crypto";
import type {
	AgentTokenSettings,
	AgentWakePayload,
	AgentWebhook,
	AgentWebhookDetails,
	AgentWebhookSecret,
	AgentWebhookTestResult,
	BotDetails,
} from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import type {
	WebhookRequest,
	WebhookResponse,
	WebhookTransport,
} from "../src/agent-webhooks/delivery.js";
import { settleBackgroundWork } from "../src/server.js";
import { startChannels } from "./channel-helpers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

type Received = {
	url: string;
	headers: Record<string, string>;
	raw: string;
	body: AgentWakePayload;
};
type Answer = number | WebhookResponse;

/**
 * A receiver for every webhook of a test gateway. It records each POST and
 * answers with the next queued status, or 200 when none is queued.
 */
function receiver() {
	const received: Received[] = [];
	const answers: Answer[] = [];
	const transport: WebhookTransport = Object.assign(
		async (request: WebhookRequest): Promise<WebhookResponse> => {
			received.push({
				url: request.url.toString(),
				headers: request.headers,
				raw: request.body,
				body: JSON.parse(request.body) as AgentWakePayload,
			});
			const answer = answers.shift() ?? 200;
			return typeof answer === "number"
				? { status: answer, retryAfter: null }
				: answer;
		},
		{ pinsAddress: false as const },
	);
	return {
		transport,
		received,
		/** Queues the statuses the next POSTs get. */
		answer: (...next: Answer[]) => answers.push(...next),
		for: (url: string) => received.filter((post) => post.url === url),
	};
}

/** A gateway with short webhook timings and a receiver that records every POST. */
async function start(timing: Record<string, unknown> = {}) {
	const hooks = receiver();
	const gateway = await startChannels(
		cleanups,
		{},
		{
			agentWebhooks: {
				transport: hooks.transport,
				timing: {
					gapMs: 40,
					retryDelaysMs: [30, 30, 30, 30],
					minRetryAfterMs: 30,
					...timing,
				},
			},
		},
	);
	/** Waits until every timer and POST the gateway started has finished. */
	const settle = () => settleBackgroundWork(gateway.server);
	const hook = (agentId: string, body: object, token?: string) =>
		gateway.ok<AgentWebhookSecret>(
			"POST",
			`/v1/agents/${agentId}/webhook`,
			{ body, token },
			201,
		);
	return { ...gateway, hooks, settle, hook };
}

const verify = (secret: string, post: Received) => {
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const expected = createHmac("sha256", key)
		.update(
			`${post.headers["webhook-id"]}.${post.headers["webhook-timestamp"]}.${post.raw}`,
		)
		.digest("base64");
	return post.headers["webhook-signature"] === `v1,${expected}`;
};

describe("agent webhook settings", () => {
	it("lets a workspace admin set one up, change it, and read it without secrets", async () => {
		const { agent, ok, hook, refused } = await start();
		const scout = await agent("Scout");
		const created = await hook(scout.id, {
			url: "https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire",
			authKey: "sk-ant-oat01-routine",
			headers: [{ name: "anthropic-version", value: "2023-06-01" }],
		});
		expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		expect(created.webhook).toMatchObject({
			agentId: scout.id,
			status: "active",
			events: ["mentions", "messages", "proposals"],
			hasAuthKey: true,
			headerNames: ["anthropic-version"],
			secretPrefix: `${created.secret.slice(0, 10)}…`,
			pendingEvents: 0,
		});
		const read = await ok<AgentWebhookDetails>(
			"GET",
			`/v1/agents/${scout.id}/webhook`,
		);
		expect(read.webhook).toEqual(created.webhook);
		expect(JSON.stringify(read)).not.toContain("sk-ant-oat01-routine");
		expect(JSON.stringify(read)).not.toContain(created.secret);
		expect(
			await refused("POST", `/v1/agents/${scout.id}/webhook`, {
				body: { url: "https://hooks.example.com/again" },
			}),
		).toMatchObject({ status: 409 });

		const changed = await ok<AgentWebhook>(
			"PATCH",
			`/v1/agents/${scout.id}/webhook`,
			{ body: { events: ["mentions"], authKey: null, enabled: false } },
		);
		expect(changed).toMatchObject({
			events: ["mentions"],
			hasAuthKey: false,
			headerNames: ["anthropic-version"],
			status: "paused",
		});
		const rotated = await ok<AgentWebhookSecret>(
			"POST",
			`/v1/agents/${scout.id}/webhook/secret`,
		);
		expect(rotated.secret).not.toBe(created.secret);

		// Every change is in the agent's history, without any secret.
		const history = (
			await ok<AgentTokenSettings>("GET", "/v1/agent-tokens")
		).actions
			.filter((action) => action.tokenId === scout.id)
			.map((action) => action.detail);
		expect(history).toEqual(
			expect.arrayContaining([
				"Webhook added: POSTs to api.anthropic.com on mentions and replies, new messages, proposal decisions.",
				"Webhook changed: wakes on mentions and replies; auth key removed; paused.",
				"Webhook signing secret replaced. The old one no longer verifies.",
			]),
		);
		expect(history.join(" ")).not.toContain("routines/trig_01ABC");

		await ok("DELETE", `/v1/agents/${scout.id}/webhook`, {}, 204);
		expect(
			(await ok<AgentWebhookDetails>("GET", `/v1/agents/${scout.id}/webhook`))
				.webhook,
		).toBeNull();
	});

	it("refuses URLs, headers, and keys that could reach the wrong place", async () => {
		const { agent, refused } = await start();
		const scout = await agent("Scout");
		const create = (body: object) =>
			refused("POST", `/v1/agents/${scout.id}/webhook`, { body });
		const cases: Array<[object, string]> = [
			[{ url: "http://hooks.example.com/x" }, "must use https"],
			[{ url: "https://localhost/x" }, "full host name"],
			[{ url: "https://hooks.internal/x" }, "public host name"],
			[{ url: "https://10.0.0.8/x" }, "not an IP address"],
			[{ url: "https://[::1]/x" }, "not an IP address"],
			[{ url: "https://hooks.example.com:8443/x" }, "default https port"],
			[{ url: "https://user:pw@hooks.example.com/x" }, "user name"],
			[{ url: "https://hooks.example.com/x#frag" }, "fragment"],
			[
				{
					url: "https://hooks.example.com/x",
					headers: [{ name: "Host", value: "evil.example" }],
				},
				"sets Host itself",
			],
			[
				{
					url: "https://hooks.example.com/x",
					headers: [{ name: "Webhook-Signature", value: "v1,forged" }],
				},
				"sets Webhook-Signature itself",
			],
			[
				{
					url: "https://hooks.example.com/x",
					authKey: "key",
					headers: [{ name: "Authorization", value: "Bearer other" }],
				},
				"not both",
			],
			[
				{
					url: "https://hooks.example.com/x",
					headers: [{ name: "X-Note", value: "line\r\nX-Injected: 1" }],
				},
				"one line",
			],
			[
				{
					url: "https://hooks.example.com/x",
					headers: [
						{ name: "X-Key", value: "a" },
						{ name: "x-key", value: "b" },
					],
				},
				"set twice",
			],
			[{ url: "https://hooks.example.com/x", authKey: "has space" }, "spaces"],
		];
		for (const [body, message] of cases) {
			const result = await create(body);
			expect(result.status, JSON.stringify(body)).toBe(400);
			expect(result.message, JSON.stringify(body)).toContain(message);
		}
		expect(
			await create({ url: "https://hooks.example.com/x", events: [] }),
		).toMatchObject({ status: 400 });
	});

	it("is for workspace admins, and only for agents that use MCP", async () => {
		const { agent, ok, refused, join, apiToken, hook } = await start();
		const scout = await agent("Scout");
		const member = await join("member@example.com");
		expect(
			await refused("GET", `/v1/agents/${scout.id}/webhook`, {
				token: member.token,
			}),
		).toMatchObject({ status: 403 });
		expect(
			await refused("POST", `/v1/agents/${scout.id}/webhook`, {
				token: member.token,
				body: { url: "https://hooks.example.com/x" },
			}),
		).toMatchObject({ status: 403 });
		const token = await apiToken(["channels:read", "channels:edit"]);
		expect(
			(
				await refused("GET", `/v1/agents/${scout.id}/webhook`, {
					token,
				})
			).status,
		).toBeGreaterThanOrEqual(401);
		// An agent's own credential reaches no REST route.
		expect(
			await refused("GET", `/v1/agents/${scout.id}/webhook`, {
				token: scout.secret,
			}),
		).toMatchObject({ status: 401 });

		const bot = await ok<BotDetails>(
			"POST",
			"/v1/bots",
			{ body: { name: "Helper", instructions: "Help.", model: "auto" } },
			201,
		);
		expect(
			await refused("POST", `/v1/agents/${bot.id}/webhook`, {
				body: { url: "https://hooks.example.com/x" },
			}),
		).toMatchObject({
			status: 409,
			message: expect.stringContaining("no webhook"),
		});
		expect(
			await refused(
				"POST",
				"/v1/agents/00000000-0000-4000-8000-000000000001/webhook",
				{ body: { url: "https://hooks.example.com/x" } },
			),
		).toMatchObject({ status: 404 });

		// Revoking an agent deletes its webhook and the receiver's credentials.
		await hook(scout.id, { url: "https://hooks.example.com/x", authKey: "k" });
		await ok("DELETE", `/v1/agent-tokens/${scout.id}`);
		expect(
			(await ok<AgentWebhookDetails>("GET", `/v1/agents/${scout.id}/webhook`))
				.webhook,
		).toBeNull();
		expect(
			await refused("POST", `/v1/agents/${scout.id}/webhook`, {
				body: { url: "https://hooks.example.com/x" },
			}),
		).toMatchObject({ status: 409, message: "This agent has been revoked." });
	});
});

describe("what wakes an agent", () => {
	it("wakes only the mentioned agent, with a signed notice and no message text", async () => {
		const { agent, addAgent, createChannel, post, hook, hooks, settle } =
			await start();
		const scout = await agent("Scout");
		const quill = await agent("Quill");
		const channel = await createChannel("film-qc");
		await addAgent(channel.id, scout.id);
		await addAgent(channel.id, quill.id);
		const scoutHook = await hook(scout.id, {
			url: "https://hooks.example.com/scout",
			events: ["mentions"],
			authKey: "routine-token",
			headers: [{ name: "anthropic-version", value: "2023-06-01" }],
		});
		await hook(quill.id, {
			url: "https://hooks.example.com/quill",
			events: ["mentions"],
		});

		const message = await post(
			channel.id,
			`<@agent:${scout.id}> the cut at 01:12 is soft — please check`,
		);
		await settle();
		expect(hooks.for("https://hooks.example.com/quill")).toEqual([]);
		const [wake, ...rest] = hooks.for("https://hooks.example.com/scout");
		expect(rest).toEqual([]);
		expect(wake.headers).toMatchObject({
			authorization: "Bearer routine-token",
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			"user-agent": "autonomo.us-webhooks/1",
		});
		expect(wake.headers["webhook-id"]).toMatch(/^msg_[0-9a-f]{32}$/);
		expect(verify(scoutHook.secret, wake)).toBe(true);
		expect(wake.body).toMatchObject({
			type: "agent.wake",
			data: {
				agent: { id: scout.id, name: "Scout" },
				omitted: 0,
				events: [
					{
						type: "channel.mention",
						channelId: channel.id,
						channel: "film-qc",
						messageId: message.id,
						seq: message.seq,
						threadId: null,
						author: { kind: "user", name: "Founder" },
					},
				],
			},
		});
		expect(wake.body.text).toContain(
			`Founder (person) mentioned you in #film-qc, message ${message.seq}.`,
		);
		expect(wake.body.text).toContain("channels_read");
		// A notice only: the message itself is read over MCP.
		expect(wake.raw).not.toContain("01:12");
	});

	it("wakes post-access members on new posts, and skips read-only agents and agents' own chatter", async () => {
		const { agent, addAgent, createChannel, post, tool, hook, hooks, settle } =
			await start();
		const scout = await agent("Scout");
		const reader = await agent("Reader");
		const quill = await agent("Quill");
		const channel = await createChannel("leads");
		await addAgent(channel.id, scout.id, "post");
		await addAgent(channel.id, reader.id, "read");
		await addAgent(channel.id, quill.id, "post");
		for (const [who, path] of [
			[scout, "scout"],
			[reader, "reader"],
			[quill, "quill"],
		] as const)
			await hook(who.id, { url: `https://hooks.example.com/${path}` });

		await post(channel.id, "New lead from Acme");
		await settle();
		expect(hooks.for("https://hooks.example.com/reader")).toEqual([]);
		expect(
			hooks
				.for("https://hooks.example.com/scout")
				.flatMap((wake) => wake.body.data.events.map((event) => event.type)),
		).toEqual(["channel.message"]);
		expect(hooks.for("https://hooks.example.com/quill")).toHaveLength(1);

		// An agent's own post never wakes it, and another agent's post wakes
		// nobody unless it mentions them: two agents cannot loop.
		hooks.received.length = 0;
		await tool(scout.secret, "channels_post", {
			channel: channel.id,
			text: "On it.",
		});
		await settle();
		expect(hooks.received).toEqual([]);
		await tool(scout.secret, "channels_post", {
			channel: channel.id,
			text: `<@agent:${quill.id}> can you draft the reply?`,
		});
		await settle();
		expect(hooks.received.map((wake) => wake.url)).toEqual([
			"https://hooks.example.com/quill",
		]);
		expect(hooks.received[0].body.data.events[0]).toMatchObject({
			type: "channel.mention",
			author: { kind: "agent", id: scout.id, name: "Scout" },
		});
	});

	it("wakes an agent for replies in a thread it started", async () => {
		const { agent, addAgent, createChannel, post, tool, hook, hooks, settle } =
			await start();
		const scout = await agent("Scout");
		const channel = await createChannel("general");
		await addAgent(channel.id, scout.id);
		await hook(scout.id, {
			url: "https://hooks.example.com/scout",
			events: ["mentions"],
		});
		const asked = await tool<{ id: string }>(scout.secret, "channels_post", {
			channel: channel.id,
			text: "Which cut should I review first?",
		});
		const root = await post(channel.id, "Unrelated thread starter");
		await post(channel.id, "The second one.", {
			threadId: asked.data.id,
		});
		await post(channel.id, "Not about Scout", { threadId: root.id });
		await settle();
		const events = hooks.received.flatMap((wake) => wake.body.data.events);
		expect(events).toEqual([
			expect.objectContaining({
				type: "channel.reply",
				threadId: asked.data.id,
			}),
		]);
		expect(hooks.received[0].body.text).toContain(
			"replied in a thread you started in #general",
		);
	});

	it("tells the proposing agent when a workspace admin decides", async () => {
		const { agent, tool, ok, hook, hooks, settle } = await start();
		const scout = await agent("Scout");
		await hook(scout.id, {
			url: "https://hooks.example.com/scout",
			events: ["proposals"],
		});
		const propose = async (title: string) =>
			(
				await tool<{ id: string }>(scout.secret, "synapse_propose", {
					action: "create",
					title,
					body: "Fix the [[link]].",
					reason: "Broken links.",
				})
			).data.id;
		const kept = await propose("Ada Lovelace");
		const dropped = await propose("Charles Babbage");
		await ok("POST", `/v1/synapse/proposals/${kept}/decide`, {
			body: { decision: "approve" },
		});
		await ok("POST", `/v1/synapse/proposals/${dropped}/decide`, {
			body: { decision: "reject", reason: "Duplicate." },
		});
		await settle();
		// Two decisions in quick succession wake the agent once.
		expect(hooks.received).toHaveLength(1);
		expect(hooks.received[0].body.data.events).toEqual([
			expect.objectContaining({
				type: "proposal.decided",
				proposalId: kept,
				action: "create",
				title: "Ada Lovelace",
				status: "approved",
				decidedBy: "Founder",
			}),
			expect.objectContaining({ proposalId: dropped, status: "rejected" }),
		]);
		const text = hooks.received[0].body.text;
		expect(text).toContain(
			'Founder approved your proposal to create "Ada Lovelace"',
		);
		expect(text).toContain("synapse_proposals");
		expect(text).not.toContain("Duplicate.");
	});

	it("folds a burst into one POST and never reports a retried post twice", async () => {
		const { agent, addAgent, createChannel, post, hook, hooks, settle } =
			await start({ gapMs: 150 });
		const scout = await agent("Scout");
		const channel = await createChannel("general");
		await addAgent(channel.id, scout.id);
		await hook(scout.id, { url: "https://hooks.example.com/scout" });
		const first = await post(channel.id, "one", { nonce: "n-1" });
		await post(channel.id, "two");
		await post(channel.id, `<@agent:${scout.id}> three`);
		// The same post again, as a client retry: it settles but adds nothing.
		await post(channel.id, "one", { nonce: "n-1" }).catch(() => {});
		await settle();
		expect(hooks.received).toHaveLength(1);
		const events = hooks.received[0].body.data.events;
		expect(events.map((event) => event.type)).toEqual([
			"channel.message",
			"channel.message",
			"channel.mention",
		]);
		expect(events[0]).toMatchObject({ seq: first.seq });
		expect(hooks.received[0].body.text).toContain("2 new messages in #general");
	});
});

describe("delivery", () => {
	it("retries a failed POST with the same id, then records the success", async () => {
		const { agent, addAgent, createChannel, post, ok, hook, hooks, settle } =
			await start();
		const scout = await agent("Scout");
		const channel = await createChannel("general");
		await addAgent(channel.id, scout.id);
		await hook(scout.id, { url: "https://hooks.example.com/scout" });
		hooks.answer(500, 503);
		await post(channel.id, "hello");
		await settle();
		expect(hooks.received).toHaveLength(3);
		const ids = new Set(
			hooks.received.map((wake) => wake.headers["webhook-id"]),
		);
		expect(ids.size).toBe(1);
		expect(new Set(hooks.received.map((wake) => wake.raw)).size).toBe(1);
		const { webhook } = await ok<AgentWebhookDetails>(
			"GET",
			`/v1/agents/${scout.id}/webhook`,
		);
		expect(webhook).toMatchObject({
			status: "active",
			consecutiveFailures: 0,
			lastError: null,
			pendingEvents: 0,
			nextAttemptAt: null,
		});
		expect(webhook?.lastDeliveryAt).not.toBeNull();
		expect(webhook?.lastFailureAt).not.toBeNull();
	});

	it("waits as a 429 asks without using up attempts, and stops on 410", async () => {
		const { agent, addAgent, createChannel, post, ok, hook, hooks, settle } =
			await start({ retryDelaysMs: [] });
		const scout = await agent("Scout");
		const channel = await createChannel("general");
		await addAgent(channel.id, scout.id);
		await hook(scout.id, { url: "https://hooks.example.com/scout" });
		// One attempt per delivery, yet three 429s in a row still deliver.
		hooks.answer(429, { status: 429, retryAfter: "0" }, 429);
		await post(channel.id, "busy receiver");
		await settle();
		expect(hooks.received).toHaveLength(4);
		let { webhook } = await ok<AgentWebhookDetails>(
			"GET",
			`/v1/agents/${scout.id}/webhook`,
		);
		expect(webhook).toMatchObject({ status: "active", lastError: null });

		hooks.answer(410);
		await post(channel.id, "receiver gone");
		await settle();
		({ webhook } = await ok<AgentWebhookDetails>(
			"GET",
			`/v1/agents/${scout.id}/webhook`,
		));
		expect(webhook).toMatchObject({
			status: "disabled",
			disabledReason: "gone",
			lastError: "http_410",
		});
		const before = hooks.received.length;
		await post(channel.id, "nobody listens");
		await settle();
		expect(hooks.received).toHaveLength(before);

		// Starting it again clears the failure.
		await ok("PATCH", `/v1/agents/${scout.id}/webhook`, {
			body: { enabled: true },
		});
		await post(channel.id, "back again");
		await settle();
		expect(hooks.received).toHaveLength(before + 1);
	});

	it("switches a webhook off after five deliveries in a row fail", async () => {
		const { agent, addAgent, createChannel, post, ok, hook, hooks, settle } =
			await start({ retryDelaysMs: [] });
		const scout = await agent("Scout");
		const channel = await createChannel("general");
		await addAgent(channel.id, scout.id);
		await hook(scout.id, { url: "https://hooks.example.com/scout" });
		hooks.answer(500, 500, 500, 500, 401);
		for (let round = 1; round <= 5; round++) {
			await post(channel.id, `attempt ${round}`);
			await settle();
		}
		expect(hooks.received).toHaveLength(5);
		const { webhook } = await ok<AgentWebhookDetails>(
			"GET",
			`/v1/agents/${scout.id}/webhook`,
		);
		expect(webhook).toMatchObject({
			status: "disabled",
			disabledReason: "failures",
			consecutiveFailures: 5,
			lastError: "http_401",
		});
	});

	it("sends nothing while paused, and a test POST reports the receiver's answer", async () => {
		const { agent, addAgent, createChannel, post, ok, hook, hooks, settle } =
			await start();
		const scout = await agent("Scout");
		const channel = await createChannel("general");
		await addAgent(channel.id, scout.id);
		const created = await hook(scout.id, {
			url: "https://hooks.example.com/scout",
		});
		await ok("PATCH", `/v1/agents/${scout.id}/webhook`, {
			body: { enabled: false },
		});
		await post(channel.id, "while paused");
		await settle();
		expect(hooks.received).toEqual([]);

		const passed = await ok<AgentWebhookTestResult>(
			"POST",
			`/v1/agents/${scout.id}/webhook/test`,
		);
		expect(passed).toMatchObject({ ok: true, status: 200, error: null });
		expect(hooks.received[0].body.data.events).toEqual([
			expect.objectContaining({ type: "webhook.test", requestedBy: "Founder" }),
		]);
		expect(hooks.received[0].body.text).toContain("nothing to do");
		expect(verify(created.secret, hooks.received[0])).toBe(true);

		hooks.answer(401);
		expect(
			await ok<AgentWebhookTestResult>(
				"POST",
				`/v1/agents/${scout.id}/webhook/test`,
			),
		).toMatchObject({ ok: false, status: 401, error: "http_401" });
		// A test changes nothing about the webhook's record.
		const { webhook } = await ok<AgentWebhookDetails>(
			"GET",
			`/v1/agents/${scout.id}/webhook`,
		);
		expect(webhook).toMatchObject({
			status: "paused",
			consecutiveFailures: 0,
			lastError: null,
		});
	});
});

import type { VideoKind } from "@autonomo.us/common";
import { describe, expect, it } from "vitest";
import { BudgetService } from "../src/budgets/service.js";
import { BudgetStore } from "../src/budgets/store.js";
import { ServiceError } from "../src/service-error.js";
import type { VideoTelemetry } from "../src/telemetry/telemetry.js";
import { VideoJobStore } from "../src/video/jobs.js";
import { VideoService } from "../src/video/service.js";
import { VideoStore } from "../src/video/store.js";
import type {
	VideoAdapter,
	VideoCall,
	VideoConfig,
	VideoContent,
	VideoCreateResult,
	VideoPollResult,
} from "../src/video/types.js";

const WS = { id: "00000000-0000-4000-8000-000000000002", isDefault: false };
const ORIGIN = "https://gateway.example.com";
const CONTEXT = { origin: ORIGIN };
const AGENT = { id: "agent:a1", name: "Agent One", kind: "agent" as const };
const OTHER_AGENT = {
	id: "agent:a2",
	name: "Agent Two",
	kind: "agent" as const,
};
const SIGNED = "https://cdn.example.com/video.mp4?sig=1";

type Script = {
	create?: (call: VideoCall, config: VideoConfig) => VideoCreateResult;
	poll?: () => VideoPollResult;
	content?: () => VideoContent;
	cost?: number;
	cancel?: boolean;
	resultTtlMs?: number;
};

/** An adapter that answers as the script says and records what it was asked. */
function scripted(kind: VideoKind, script: Script = {}) {
	const seen = {
		creates: [] as VideoCall[],
		polls: 0,
		cancels: 0,
		contents: 0,
	};
	let counter = 0;
	const adapter: VideoAdapter = {
		kind,
		resultTtlMs: script.resultTtlMs ?? 24 * 3_600_000,
		estimateCostUsd: () => script.cost ?? 1,
		async create(config, call) {
			seen.creates.push(call);
			return (
				script.create?.(call, config) ?? {
					outcome: "accepted",
					providerJobId: `${kind}-${++counter}`,
					status: "queued",
				}
			);
		},
		async poll() {
			seen.polls += 1;
			return script.poll?.() ?? { state: "running", progress: 10 };
		},
		...(script.cancel === false
			? {}
			: {
					async cancel() {
						seen.cancels += 1;
					},
				}),
		async content() {
			seen.contents += 1;
			return (
				script.content?.() ?? {
					kind: "ok",
					bytes: new Uint8Array([1, 2, 3]),
					contentType: "video/mp4",
				}
			);
		},
	};
	return { adapter, seen };
}

async function setup(
	adapters: Partial<Record<VideoKind, VideoAdapter>>,
	connections: Array<
		Partial<VideoConfig> & { name: string; kind: VideoKind }
	> = [{ name: "runway", kind: "runway" }],
	options: { disabled?: boolean } = {},
) {
	let now = Date.parse("2026-11-19T12:00:00Z");
	const clock = () => now;
	const store = new VideoStore([], undefined, () => new Date(now));
	const jobs = new VideoJobStore(undefined, () => new Date(now));
	for (const connection of connections)
		await store.create(WS, { apiKey: "key-123", ...connection } as never);
	const events: VideoTelemetry[] = [];
	const budgets = new BudgetService(
		new BudgetStore(undefined, {
			now: () => new Date(now),
			seed: (workspaceId) => store.budgetSeed(workspaceId),
		}),
		{ now: () => new Date(now) },
	);
	const service = new VideoService({
		store,
		jobs,
		adapters,
		budgets,
		now: clock,
		sleep: async (ms) => {
			now += ms;
		},
		telemetry: {
			recordVideo: (event) => {
				events.push(event);
				return event as never;
			},
		},
		...options,
	});
	return {
		service,
		store,
		jobs,
		budgets,
		events,
		advance: (ms: number) => {
			now += ms;
		},
		now: clock,
	};
}

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ServiceError)
			return { status: error.statusCode, message: error.message };
		throw error;
	}
	throw new Error("Expected a refusal.");
}

describe("starting a video", () => {
	it("uses the first usable connection in the policy's order and returns at once", async () => {
		const runway = scripted("runway");
		const luma = scripted("luma");
		const { service, store, events } = await setup(
			{ runway: runway.adapter, luma: luma.adapter },
			[
				{ name: "runway", kind: "runway" },
				{ name: "luma", kind: "luma" },
				{ name: "off", kind: "google", enabled: false },
			],
		);
		await store.updatePolicy(WS, {
			order: ["luma"],
			callerVideosPerDay: 10,
			maxDurationSeconds: 10,
			revision: 0,
		});
		const job = await service.generate(
			WS,
			AGENT,
			{ prompt: "  a fox  " },
			CONTEXT,
		);
		expect(job).toMatchObject({
			status: "queued",
			provider: "luma",
			kind: "luma",
			model: "ray-3.2",
			prompt: "a fox",
			durationSeconds: 5,
			aspectRatio: "16:9",
			resolution: "720p",
			costUsd: 1,
			video: null,
			attempts: [{ provider: "luma", model: "ray-3.2", outcome: "accepted" }],
			createdBy: AGENT,
		});
		expect(job.id).toMatch(/^vid_[0-9a-f-]{36}$/);
		expect(JSON.stringify(job)).not.toContain("luma-1");
		expect(runway.seen.creates).toHaveLength(0);
		expect(events).toEqual([
			expect.objectContaining({
				phase: "started",
				jobId: job.id,
				status: "queued",
			}),
		]);
		expect(JSON.stringify(events)).not.toContain("a fox");
		expect((await store.spend(WS)).spentUsd).toBe(1);
	});

	it("writes the job before calling the provider", async () => {
		let { jobs, service } = {
			jobs: undefined as never,
			service: undefined as never,
		} as {
			jobs: VideoJobStore;
			service: VideoService;
		};
		let seenDuringCreate: unknown = "not called";
		const runway = scripted("runway", {
			create: () => {
				seenDuringCreate = "pending";
				return { outcome: "accepted", providerJobId: "r1", status: "running" };
			},
		});
		({ jobs, service } = await setup({ runway: runway.adapter }));
		const insert = jobs.insert.bind(jobs);
		const order: string[] = [];
		jobs.insert = async (record) => {
			order.push("insert");
			return insert(record);
		};
		const create = runway.adapter.create.bind(runway.adapter);
		runway.adapter.create = async (...args) => {
			order.push("create");
			return create(...args);
		};
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(order).toEqual(["insert", "create"]);
		expect(seenDuringCreate).toBe("pending");
		expect(job.status).toBe("running");
	});

	it("honours a named provider and model, and explains what cannot be made", async () => {
		const runway = scripted("runway");
		const luma = scripted("luma");
		const { service } = await setup(
			{ runway: runway.adapter, luma: luma.adapter },
			[
				{ name: "runway", kind: "runway" },
				{ name: "luma", kind: "luma" },
			],
		);
		const job = await service.generate(
			WS,
			AGENT,
			{
				prompt: "x",
				provider: "runway",
				model: "gen4.5",
				durationSeconds: 8,
				aspectRatio: "9:16",
			},
			CONTEXT,
		);
		expect(job).toMatchObject({
			provider: "runway",
			model: "gen4.5",
			durationSeconds: 8,
		});
		expect(runway.seen.creates[0]).toMatchObject({
			model: "gen4.5",
			durationSeconds: 8,
			aspectRatio: "9:16",
			resolution: "720p",
		});
		expect(
			await refusal(
				service.generate(WS, AGENT, { prompt: "x", provider: "nope" }, CONTEXT),
			),
		).toMatchObject({
			status: 400,
			message: expect.stringContaining("runway, luma"),
		});
		expect(
			await refusal(
				service.generate(
					WS,
					AGENT,
					{ prompt: "x", provider: "luma", durationSeconds: 7 },
					CONTEXT,
				),
			),
		).toMatchObject({
			status: 400,
			message: expect.stringContaining("5 or 10 seconds"),
		});
		expect(
			await refusal(
				service.generate(WS, AGENT, { prompt: "x", model: "sora-2" }, CONTEXT),
			),
		).toMatchObject({
			status: 400,
			message: expect.stringContaining("has no model sora-2"),
		});
		// Only Luma makes 540p, so the request goes there without naming it.
		const routed = await service.generate(
			WS,
			AGENT,
			{ prompt: "x", resolution: "540p" },
			CONTEXT,
		);
		expect(routed.provider).toBe("luma");
	});

	it("checks the request before anything is written", async () => {
		const { service, jobs } = await setup({
			runway: scripted("runway").adapter,
		});
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ prompt: "   " }, "Describe the video"],
			[{ prompt: "x".repeat(4001) }, "at most 4000"],
			[{ prompt: "x", durationSeconds: 4.5 }, "whole number"],
			[{ prompt: "x", durationSeconds: 20 }, "up to 10 seconds"],
			[{ prompt: "x", aspectRatio: "4:3" }, "aspectRatio is one of"],
			[{ prompt: "x", resolution: "4k" }, "resolution is one of"],
			[{ prompt: "x", imageUrl: "http://images.example.com/a.png" }, "https"],
			[{ prompt: "x", imageUrl: "https://10.0.0.5/a.png" }, "private"],
			[
				{ prompt: "x", imageUrl: "https://minio.internal/a.png" },
				"private network",
			],
		];
		for (const [request, message] of cases)
			expect(
				await refusal(service.generate(WS, AGENT, request as never, CONTEXT)),
			).toMatchObject({
				status: 400,
				message: expect.stringContaining(message),
			});
		expect((await jobs.list(WS.id, { limit: 10 })).records).toHaveLength(0);
	});

	it("needs a usable connection", async () => {
		const { service } = await setup({}, [
			{ name: "luma", kind: "luma", enabled: false },
		]);
		expect(
			await refusal(service.generate(WS, AGENT, { prompt: "x" }, CONTEXT)),
		).toMatchObject({
			status: 409,
			message: expect.stringContaining("not set up"),
		});
	});

	it("fails over on an error that cost nothing, and gives that hold back", async () => {
		const runway = scripted("runway", {
			create: () => ({
				outcome: "provider-error",
				detail: "runway: the API key was refused",
				billed: false,
				problem: "key",
			}),
		});
		const luma = scripted("luma");
		const { service, store } = await setup(
			{ runway: runway.adapter, luma: luma.adapter },
			[
				{ name: "runway", kind: "runway" },
				{ name: "luma", kind: "luma" },
			],
		);
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(job.provider).toBe("luma");
		expect(job.attempts).toEqual([
			{
				provider: "runway",
				model: "seedance2_5",
				outcome: "provider-error",
				detail: "runway: the API key was refused",
			},
			{ provider: "luma", model: "ray-3.2", outcome: "accepted" },
		]);
		expect((await store.spend(WS)).spentUsd).toBe(1);
		const [runwayConnection] = await store.list(WS);
		expect(runwayConnection.problem).toMatchObject({ kind: "key" });
		// The connection with a problem is passed over for a while.
		await service.generate(WS, AGENT, { prompt: "again" }, CONTEXT);
		expect(runway.seen.creates).toHaveLength(1);
	});

	it.each([
		["refused", "moderated", false],
		["invalid", "invalid_input", false],
		["timeout", "timeout", true],
	] as const)("stops at %s and records the job as failed", async (outcome, code, keepsHold) => {
		const runway = scripted("runway", {
			create: () => ({ outcome, detail: `runway: ${outcome}`, billed: false }),
		});
		const luma = scripted("luma");
		const { service, store, events } = await setup(
			{ runway: runway.adapter, luma: luma.adapter },
			[
				{ name: "runway", kind: "runway" },
				{ name: "luma", kind: "luma" },
			],
		);
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(job).toMatchObject({
			status: "failed",
			error: { code, message: `runway: ${outcome}` },
		});
		expect(luma.seen.creates).toHaveLength(0);
		expect((await store.spend(WS)).spentUsd).toBe(keepsHold ? 1 : 0);
		expect(job.costUsd).toBe(keepsHold ? 1 : 0);
		expect(events.at(-1)).toMatchObject({ phase: "finished", errorCode: code });
	});

	it("keeps the hold when a create throws, since the provider may have taken it", async () => {
		const runway = scripted("runway");
		runway.adapter.create = async () => {
			throw new Error("bug");
		};
		const { service, store } = await setup({ runway: runway.adapter });
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(job.error?.code).toBe("timeout");
		expect((await store.spend(WS)).spentUsd).toBe(1);
	});

	it("waits out a provider's rate limit before trying it again", async () => {
		let calls = 0;
		const runway = scripted("runway", {
			create: () =>
				++calls === 1
					? {
							outcome: "provider-error",
							detail: "slow down",
							billed: false,
							retryAfterMs: 60_000,
						}
					: { outcome: "accepted", providerJobId: "r", status: "queued" },
		});
		const { service, advance } = await setup({ runway: runway.adapter });
		expect(
			(await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT)).status,
		).toBe("failed");
		const skipped = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(skipped.attempts).toEqual([
			expect.objectContaining({
				outcome: "skipped",
				detail: expect.stringContaining("slow down"),
			}),
		]);
		expect(skipped.costUsd).toBe(0);
		advance(61_000);
		expect(
			(await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT)).status,
		).toBe("queued");
	});

	it("refuses once a budget or the caller's day is used up", async () => {
		const { service, store, budgets } = await setup({
			runway: scripted("runway", { cost: 2 }).adapter,
		});
		await store.updatePolicy(WS, {
			order: [],
			callerVideosPerDay: 2,
			maxDurationSeconds: 10,
			revision: 0,
		});
		await budgets.create(WS, {
			appliesTo: { kind: "everyone" },
			covers: { kind: "video" },
			limitUsd: 7,
			period: "month",
		});
		await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(
			await refusal(service.generate(WS, AGENT, { prompt: "x" }, CONTEXT)),
		).toMatchObject({
			status: 429,
			message: expect.stringContaining("today"),
		});
		// The refused caller's hold was given back to the budget.
		await service.generate(WS, OTHER_AGENT, { prompt: "x" }, CONTEXT);
		expect(
			await refusal(
				service.generate(WS, OTHER_AGENT, { prompt: "x" }, CONTEXT),
			),
		).toMatchObject({
			status: 429,
			message: expect.stringContaining(
				'The budget "Everyone · All video models · $7.00 a month" has $1.00 left',
			),
		});
		// Every covering budget counted the three videos made.
		const { policies } = await budgets.list(WS);
		expect(policies.map((policy) => policy.usage.spentUsd)).toEqual([6, 6]);
	});

	it("holds against an agent's budget and a model's, and gives both back on a refusal", async () => {
		const { service, budgets } = await setup({
			runway: scripted("runway", {
				cost: 3,
				create: () => ({
					outcome: "refused",
					detail: "Runway refused the prompt",
					billed: false,
				}),
			}).adapter,
		});
		await budgets.create(WS, {
			appliesTo: { kind: "agents", agentIds: ["a1"] },
			covers: { kind: "video-model", model: "seedance2_5" },
			limitUsd: 5,
			period: "day",
		});
		const failed = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(failed.status).toBe("failed");
		const { policies } = await budgets.list(WS);
		// The provider charged nothing, so nothing stays counted.
		expect(policies.map((policy) => policy.usage.spentUsd)).toEqual([0, 0]);
	});

	it("passes over a model a used-up budget covers, and refuses when budgets cover every one", async () => {
		const runway = scripted("runway");
		const luma = scripted("luma");
		const { service, budgets } = await setup(
			{ runway: runway.adapter, luma: luma.adapter },
			[
				{ name: "runway", kind: "runway" },
				{ name: "luma", kind: "luma" },
			],
		);
		await budgets.create(WS, {
			appliesTo: { kind: "everyone" },
			covers: { kind: "video-model", model: "seedance2_5" },
			limitUsd: 0,
			period: "month",
		});
		// Runway's default model is covered by a $0 budget; Luma is not.
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(job).toMatchObject({
			provider: "luma",
			attempts: [
				{
					provider: "runway",
					outcome: "skipped",
					detail: expect.stringContaining("is used up"),
				},
				{ provider: "luma", outcome: "accepted" },
			],
		});
		expect(runway.seen.creates).toHaveLength(0);
		await budgets.create(WS, {
			appliesTo: { kind: "everyone" },
			covers: { kind: "video-model", model: "ray-3.2" },
			limitUsd: 0,
			period: "month",
		});
		expect(
			await refusal(service.generate(WS, AGENT, { prompt: "x" }, CONTEXT)),
		).toMatchObject({
			status: 429,
			message: expect.stringContaining("Seedance 2.5"),
		});
	});

	it("records a failed job, not a budget refusal, when another provider was skipped for its own reason", async () => {
		const { service, store, budgets } = await setup(
			{ runway: scripted("runway").adapter, luma: scripted("luma").adapter },
			[
				{ name: "runway", kind: "runway" },
				{ name: "luma", kind: "luma" },
			],
		);
		await budgets.create(WS, {
			appliesTo: { kind: "everyone" },
			covers: { kind: "video-model", model: "seedance2_5" },
			limitUsd: 0,
			period: "month",
		});
		await store.setProblem(WS, "luma", {
			kind: "key",
			detail: "Luma: the API key was refused",
			at: "2026-11-19T11:59:00.000Z",
		});
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(job.status).toBe("failed");
		expect(job.attempts).toMatchObject([
			{ provider: "runway", detail: expect.stringContaining("is used up") },
			{ provider: "luma", detail: expect.stringContaining("problem to fix") },
		]);
	});

	it("starts nothing when a budget the agent shares has no room", async () => {
		const runway = scripted("runway", { cost: 3 });
		const { service, budgets } = await setup({ runway: runway.adapter });
		await budgets.create(WS, {
			appliesTo: { kind: "agents", agentIds: ["a1", "a2"] },
			covers: { kind: "all" },
			limitUsd: 5,
			period: "day",
		});
		await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		expect(
			await refusal(
				service.generate(WS, OTHER_AGENT, { prompt: "x" }, CONTEXT),
			),
		).toMatchObject({
			status: 429,
			message: expect.stringContaining("2 agents"),
		});
		expect(runway.seen.creates).toHaveLength(1);
		// Someone the budget does not name is not limited by it.
		const person = { id: "user:u1", name: "Founder", kind: "user" as const };
		expect(
			(await service.generate(WS, person, { prompt: "x" }, CONTEXT)).status,
		).toBe("queued");
	});
});

describe("following a video", () => {
	it("polls when due, finishes once, and links through the gateway", async () => {
		let state: VideoPollResult = { state: "running", progress: 40 };
		const runway = scripted("runway", { poll: () => state });
		const { service, events, advance } = await setup({
			runway: runway.adapter,
		});
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		// Polled at most every five seconds, whoever asks.
		expect((await service.status(WS, {}, job.id, {}, CONTEXT)).status).toBe(
			"queued",
		);
		expect(runway.seen.polls).toBe(0);
		advance(5000);
		expect(await service.status(WS, {}, job.id, {}, CONTEXT)).toMatchObject({
			status: "running",
			progress: 40,
		});
		expect(runway.seen.polls).toBe(1);
		state = {
			state: "succeeded",
			delivery: { kind: "url", url: SIGNED, ttlMs: 3_600_000 },
		};
		advance(5000);
		const done = await service.status(WS, {}, job.id, {}, CONTEXT);
		expect(done).toMatchObject({
			status: "succeeded",
			progress: 100,
			video: {
				url: expect.stringMatching(
					/^https:\/\/gateway\.example\.com\/video\/downloads\/[A-Za-z0-9_-]{43}$/,
				),
				contentType: "video/mp4",
				expiresAt: "2026-11-20T12:00:10.000Z",
			},
		});
		expect(JSON.stringify(done)).not.toContain("cdn.example.com");
		advance(60_000);
		await service.status(WS, {}, job.id, {}, CONTEXT);
		expect(runway.seen.polls).toBe(2);
		expect(events.map((event) => event.phase)).toEqual(["started", "finished"]);
	});

	it("gives the hold back when a failure cost nothing, and only once", async () => {
		const runway = scripted("runway", {
			poll: () => ({
				state: "failed",
				code: "provider_error",
				detail: "broke",
				billed: false,
			}),
		});
		const { service, store, budgets, advance } = await setup({
			runway: runway.adapter,
		});
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		advance(5000);
		const results = await Promise.all([
			service.status(WS, {}, job.id, {}, CONTEXT),
			service.status(WS, {}, job.id, {}, CONTEXT),
		]);
		// Both found the check due; only one of them asked the provider.
		expect(runway.seen.polls).toBe(1);
		expect(results.map((result) => result.status)).toContain("failed");
		const done = await service.status(WS, {}, job.id, {}, CONTEXT);
		expect(done).toMatchObject({ status: "failed", costUsd: 0 });
		expect((await store.spend(WS)).spentUsd).toBe(0);
		// The budget it was held against got it back too, once.
		expect((await budgets.list(WS)).policies[0].usage.spentUsd).toBe(0);
	});

	it("keeps the hold when a failure was billed, and notes a connection problem", async () => {
		const runway = scripted("runway", {
			poll: () => ({
				state: "failed",
				code: "provider_error",
				detail: "out of credits",
				billed: true,
				problem: "credits",
			}),
		});
		const { service, store, budgets, advance } = await setup({
			runway: runway.adapter,
		});
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		advance(5000);
		expect(
			(await service.status(WS, {}, job.id, {}, CONTEXT)).error?.message,
		).toBe("out of credits");
		expect((await store.spend(WS)).spentUsd).toBe(1);
		expect((await budgets.list(WS)).policies[0].usage.spentUsd).toBe(1);
		expect((await store.list(WS))[0].problem).toMatchObject({
			kind: "credits",
		});
	});

	it("maps canceled, gone, and unknown polls", async () => {
		let state: VideoPollResult = {
			state: "unknown",
			detail: "x",
			retryAfterMs: 30_000,
			problem: "key",
		};
		const runway = scripted("runway", { poll: () => state });
		const { service, store, advance } = await setup({ runway: runway.adapter });
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		const second = await service.generate(WS, AGENT, { prompt: "y" }, CONTEXT);
		advance(5000);
		expect((await service.status(WS, {}, job.id, {}, CONTEXT)).status).toBe(
			"queued",
		);
		expect((await store.list(WS))[0].problem).toMatchObject({ kind: "key" });
		// The rate limit pushes the next poll out.
		advance(10_000);
		await service.status(WS, {}, job.id, {}, CONTEXT);
		expect(runway.seen.polls).toBe(1);
		advance(25_000);
		state = { state: "gone" };
		expect(await service.status(WS, {}, job.id, {}, CONTEXT)).toMatchObject({
			status: "failed",
			error: {
				code: "provider_error",
				message: "Runway no longer has this job.",
			},
		});
		state = { state: "canceled" };
		expect((await service.status(WS, {}, second.id, {}, CONTEXT)).status).toBe(
			"canceled",
		);
	});

	it("waits for the job, and stops at the deadline or when the caller leaves", async () => {
		let polls = 0;
		const runway = scripted("runway", {
			poll: () =>
				++polls >= 3
					? { state: "succeeded", delivery: { kind: "bytes" } }
					: { state: "running", progress: null },
		});
		const { service, now } = await setup({ runway: runway.adapter });
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		const done = await service.status(
			WS,
			{},
			job.id,
			{ waitSeconds: 60 },
			CONTEXT,
		);
		expect(done.status).toBe("succeeded");
		expect(polls).toBe(3);

		polls = -100;
		const slow = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		const started = now();
		const cut = await service.status(
			WS,
			{},
			slow.id,
			{ waitSeconds: 60 },
			{
				...CONTEXT,
				deadline: started + 12_000,
			},
		);
		expect(cut.status).toBe("running");
		expect(now() - started).toBeLessThanOrEqual(12_000);

		const controller = new AbortController();
		controller.abort();
		const before = polls;
		await service.status(
			WS,
			{},
			slow.id,
			{ waitSeconds: 60 },
			{
				...CONTEXT,
				signal: controller.signal,
			},
		);
		expect(polls - before).toBeLessThanOrEqual(1);
	});

	it("marks a job that never got a provider id as failed after two minutes", async () => {
		const runway = scripted("runway");
		const { service, jobs, store, advance } = await setup({
			runway: runway.adapter,
		});
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		await jobs.update(WS.id, job.id, { providerJobId: null });
		advance(60_000);
		expect((await service.status(WS, {}, job.id, {}, CONTEXT)).status).toBe(
			"queued",
		);
		advance(61_000);
		expect(await service.status(WS, {}, job.id, {}, CONTEXT)).toMatchObject({
			status: "failed",
			error: { code: "not_started" },
		});
		expect((await store.spend(WS)).spentUsd).toBe(1);
	});

	it("leaves a job alone when its connection was removed", async () => {
		const runway = scripted("runway");
		const { service, store, advance } = await setup({ runway: runway.adapter });
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		await store.remove(WS, "runway");
		advance(10_000);
		expect((await service.status(WS, {}, job.id, {}, CONTEXT)).status).toBe(
			"queued",
		);
		expect(runway.seen.polls).toBe(0);
	});

	it("shows an agent only its own jobs", async () => {
		const { service, advance } = await setup({
			runway: scripted("runway").adapter,
		});
		const mine = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		advance(1000);
		const theirs = await service.generate(
			WS,
			OTHER_AGENT,
			{ prompt: "y" },
			CONTEXT,
		);
		const own = { ownOnly: AGENT.id };
		expect((await service.status(WS, own, mine.id, {}, CONTEXT)).id).toBe(
			mine.id,
		);
		expect(
			await refusal(service.status(WS, own, theirs.id, {}, CONTEXT)),
		).toEqual({
			status: 404,
			message: "Video job not found.",
		});
		expect(
			await refusal(service.cancel(WS, own, theirs.id, CONTEXT)),
		).toMatchObject({
			status: 404,
		});
		expect(
			await refusal(
				service.status(
					{ ...WS, id: "00000000-0000-4000-8000-000000000009" },
					{},
					mine.id,
					{},
					CONTEXT,
				),
			),
		).toMatchObject({ status: 404 });
		expect(
			(await service.list(WS, own, {}, CONTEXT)).jobs.map((job) => job.id),
		).toEqual([mine.id]);
		const everyone = await service.list(WS, {}, { limit: 1 }, CONTEXT);
		expect(everyone.jobs.map((job) => job.id)).toEqual([theirs.id]);
		expect(everyone.nextBefore).toBe(theirs.id);
		expect(
			(await service.list(WS, {}, { before: theirs.id }, CONTEXT)).jobs.map(
				(job) => job.id,
			),
		).toEqual([mine.id]);
	});

	it("cancels at the provider, keeps the estimated cost, and leaves finished jobs alone", async () => {
		const runway = scripted("runway");
		const luma = scripted("luma", { cancel: false });
		const { service, store, events } = await setup(
			{ runway: runway.adapter, luma: luma.adapter },
			[
				{ name: "runway", kind: "runway" },
				{ name: "luma", kind: "luma" },
			],
		);
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		const canceled = await service.cancel(WS, {}, job.id, CONTEXT);
		expect(canceled.status).toBe("canceled");
		expect(runway.seen.cancels).toBe(1);
		expect(events.at(-1)).toMatchObject({
			phase: "finished",
			status: "canceled",
		});
		expect((await service.cancel(WS, {}, job.id, CONTEXT)).status).toBe(
			"canceled",
		);
		expect(runway.seen.cancels).toBe(1);
		expect((await store.spend(WS)).spentUsd).toBe(1);
		const onLuma = await service.generate(
			WS,
			AGENT,
			{ prompt: "x", provider: "luma" },
			CONTEXT,
		);
		expect((await service.cancel(WS, {}, onLuma.id, CONTEXT)).status).toBe(
			"canceled",
		);
	});
});

describe("review fixes", () => {
	it("does not cancel a job that already finished at the provider", async () => {
		const runway = scripted("runway", {
			poll: () => ({
				state: "succeeded",
				delivery: { kind: "url", url: SIGNED, ttlMs: 3_600_000 },
			}),
		});
		const { service } = await setup({ runway: runway.adapter });
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		// Within the poll interval: cancel checks with the provider anyway.
		const result = await service.cancel(WS, {}, job.id, CONTEXT);
		expect(result.status).toBe("succeeded");
		expect(runway.seen.polls).toBe(1);
		expect(runway.seen.cancels).toBe(0);
	});

	it("waits calmly on a job whose connection was removed", async () => {
		const runway = scripted("runway");
		const { service, store } = await setup({ runway: runway.adapter });
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		await store.remove(WS, "runway");
		let lookups = 0;
		const connection = store.connection.bind(store);
		store.connection = async (...args) => {
			lookups += 1;
			return connection(...args);
		};
		const waited = await service.status(
			WS,
			{},
			job.id,
			{ waitSeconds: 60 },
			CONTEXT,
		);
		expect(waited.status).toBe("queued");
		expect(lookups).toBeLessThanOrEqual(13);
	});

	it("starts nothing more when the job is canceled between attempts", async () => {
		let jobs: VideoJobStore | undefined;
		const runway = scripted("runway", {
			create: () => ({
				outcome: "provider-error",
				detail: "runway: outage",
				billed: false,
			}),
		});
		const luma = scripted("luma");
		const context = await setup(
			{ runway: runway.adapter, luma: luma.adapter },
			[
				{ name: "runway", kind: "runway" },
				{ name: "luma", kind: "luma" },
			],
		);
		jobs = context.jobs;
		const create = runway.adapter.create.bind(runway.adapter);
		runway.adapter.create = async (...args) => {
			const [listed] = (await jobs?.list(WS.id, { limit: 1 }))?.records ?? [];
			if (listed) await jobs?.update(WS.id, listed._id, { status: "canceled" });
			return create(...args);
		};
		const job = await context.service.generate(
			WS,
			AGENT,
			{ prompt: "x" },
			CONTEXT,
		);
		expect(job.status).toBe("canceled");
		expect(luma.seen.creates).toHaveLength(0);
		expect((await context.store.spend(WS)).spentUsd).toBe(0);
	});

	it("measures a job that never started from its last attempt", async () => {
		const { service, jobs, advance } = await setup({
			runway: scripted("runway").adapter,
		});
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		await jobs.update(WS.id, job.id, { providerJobId: null });
		advance(100_000);
		// Another failover attempt touches the record.
		await jobs.update(WS.id, job.id, { attempts: [] });
		advance(30_000);
		expect((await service.status(WS, {}, job.id, {}, CONTEXT)).status).toBe(
			"queued",
		);
		advance(91_000);
		expect((await service.status(WS, {}, job.id, {}, CONTEXT)).status).toBe(
			"failed",
		);
	});
});

describe("download links", () => {
	async function finished(script: Script, kind: VideoKind = "runway") {
		const adapter = scripted(kind, script);
		const context = await setup({ [kind]: adapter.adapter }, [
			{ name: kind, kind },
		]);
		const job = await context.service.generate(
			WS,
			AGENT,
			{ prompt: "x" },
			CONTEXT,
		);
		context.advance(5000);
		const done = await context.service.status(WS, {}, job.id, {}, CONTEXT);
		const token = done.video?.url.split("/").at(-1) ?? "";
		return { ...context, ...adapter, job: done, token };
	}

	it("redirects to a provider link", async () => {
		const { service, token, seen } = await finished({
			poll: () => ({
				state: "succeeded",
				delivery: { kind: "url", url: SIGNED, ttlMs: 3_600_000 },
			}),
		});
		expect(await service.download(token)).toEqual({
			kind: "redirect",
			url: SIGNED,
		});
		expect(seen.polls).toBe(1);
		expect(await service.download("x".repeat(43))).toBeNull();
		expect(await service.download("short")).toBeNull();
	});

	it("fetches a fresh link when the saved one is about to expire", async () => {
		let link = SIGNED;
		const { service, token, advance, seen } = await finished(
			{
				poll: () => ({
					state: "succeeded",
					delivery: { kind: "url", url: link, ttlMs: 55 * 60_000 },
				}),
			},
			"luma",
		);
		advance(51 * 60_000);
		link = "https://cdn.example.com/video.mp4?sig=2";
		// Several downloads at once: one renews the link, the rest use the saved one.
		const results = await Promise.all([
			service.download(token),
			service.download(token),
			service.download(token),
		]);
		expect(seen.polls).toBe(2);
		expect(results).toContainEqual({ kind: "redirect", url: link });
		expect(await service.download(token)).toEqual({
			kind: "redirect",
			url: link,
		});
		expect(seen.polls).toBe(2);
	});

	it("streams bytes only the key can fetch", async () => {
		const { service, token, job } = await finished(
			{ poll: () => ({ state: "succeeded", delivery: { kind: "bytes" } }) },
			"google",
		);
		expect(await service.download(token)).toEqual({
			kind: "bytes",
			bytes: new Uint8Array([1, 2, 3]),
			contentType: "video/mp4",
			filename: `${job.id}.mp4`,
		});
	});

	it("reports a video the provider no longer has as gone, and expires it", async () => {
		const { service, token, job, advance } = await finished(
			{
				poll: () => ({ state: "succeeded", delivery: { kind: "bytes" } }),
				content: () => ({ kind: "gone" }),
			},
			"google",
		);
		expect(await service.download(token)).toEqual({ kind: "gone" });
		advance(1000);
		expect((await service.status(WS, {}, job.id, {}, CONTEXT)).status).toBe(
			"expired",
		);
	});

	it("expires a video past the provider's retention", async () => {
		const { service, token, job, advance } = await finished({
			poll: () => ({
				state: "succeeded",
				delivery: { kind: "url", url: SIGNED, ttlMs: 3_600_000 },
			}),
			resultTtlMs: 3_600_000,
		});
		advance(3_600_001);
		expect((await service.list(WS, {}, {}, CONTEXT)).jobs[0]).toMatchObject({
			status: "expired",
			video: null,
		});
		expect(await service.download(token)).toEqual({ kind: "gone" });
		expect((await service.status(WS, {}, job.id, {}, CONTEXT)).status).toBe(
			"expired",
		);
	});

	it("answers nothing for a job that has not finished", async () => {
		const runway = scripted("runway");
		const { service, jobs } = await setup({ runway: runway.adapter });
		const job = await service.generate(WS, AGENT, { prompt: "x" }, CONTEXT);
		const record = await jobs.get(WS.id, job.id);
		expect(await service.download(record?.downloadToken ?? "")).toBeNull();
	});
});

describe("availability", () => {
	it("says why a workspace cannot make videos", async () => {
		const { service } = await setup({}, []);
		expect(await service.models(WS, true)).toMatchObject({
			available: false,
			reason: expect.stringContaining("no video provider"),
			canGenerate: true,
			providers: [],
		});
		expect(await service.settings(WS)).toMatchObject({
			available: true,
			configured: false,
			connections: [],
			persistence: "memory",
		});
	});

	it("lists usable providers and their models", async () => {
		const { service } = await setup({}, [
			{ name: "g", kind: "google" },
			{ name: "r", kind: "runway", defaultModel: "gen4.5" },
		]);
		const list = await service.models(WS, false);
		expect(list).toMatchObject({
			available: true,
			canGenerate: false,
			limits: { maxDurationSeconds: 10, promptLength: 4000 },
		});
		expect(
			list.providers.map((provider) => [provider.name, provider.defaultModel]),
		).toEqual([
			["g", "gemini-omni-1.2-flash"],
			["r", "gen4.5"],
		]);
	});

	it("refuses everything but the settings when the operator turned video off", async () => {
		const { service } = await setup(
			{ runway: scripted("runway").adapter },
			undefined,
			{
				disabled: true,
			},
		);
		expect(service.available).toBe(false);
		expect((await service.settings(WS)).available).toBe(false);
		for (const promise of [
			service.models(WS, true),
			service.generate(WS, AGENT, { prompt: "x" }, CONTEXT),
			service.status(WS, {}, "vid_x", {}, CONTEXT),
			service.cancel(WS, {}, "vid_x", CONTEXT),
			service.list(WS, {}, {}, CONTEXT),
			service.download("x".repeat(43)),
		])
			expect(await refusal(promise)).toMatchObject({ status: 503 });
	});
});

describe("job text for agents", () => {
	it("ends a failure's reason with one period", async () => {
		const { videoJobText } = await import("../src/video/mcp.js");
		const text = videoJobText({
			id: "vid_00000000-0000-4000-8000-000000000000",
			status: "failed",
			progress: null,
			provider: "runway",
			kind: "runway",
			model: "seedance2_5",
			prompt: "x",
			durationSeconds: 5,
			aspectRatio: "16:9",
			resolution: "720p",
			hasImage: false,
			createdBy: AGENT,
			createdAt: "2026-11-19T12:00:00.000Z",
			updatedAt: "2026-11-19T12:00:00.000Z",
			completedAt: "2026-11-19T12:00:00.000Z",
			costUsd: 0,
			video: null,
			error: {
				code: "moderated",
				message: "Runway: Runway refused the prompt: flagged by moderation.",
			},
			attempts: [
				{ provider: "runway", model: "seedance2_5", outcome: "accepted" },
			],
		});
		expect(text).toContain("flagged by moderation. Tried:");
		expect(text).not.toContain("..");
	});
});

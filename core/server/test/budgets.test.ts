import type { BudgetPolicy, BudgetPolicyInput } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { BudgetService } from "../src/budgets/service.js";
import { type BudgetSeed, BudgetStore } from "../src/budgets/store.js";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";
import { ServiceError } from "../src/service-error.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { joinWithInvite, withSession } from "./auth-helpers.js";
import { type StubProvider, startStubProvider } from "./helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const WS = { id: "00000000-0000-4000-8000-000000000002", isDefault: false };
const AGENT = { id: "agent:a1", name: "Researcher", kind: "agent" as const };
const OTHER_AGENT = { id: "agent:a2", name: "Writer", kind: "agent" as const };
const PERSON = { id: "user:u1", name: "Founder", kind: "user" as const };
const OPUS = "anthropic/claude-opus-4-8";

const available = await mongoAvailable();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

function stores(): Array<
	[
		string,
		(options?: ConstructorParameters<typeof BudgetStore>[1]) => BudgetStore,
	]
> {
	const memory: [string, (options?: object) => BudgetStore] = [
		"memory",
		(options) => new BudgetStore(undefined, options),
	];
	if (!available) return [memory];
	return [
		memory,
		[
			"mongodb",
			(options) => {
				const url = uniqueMongoUrl("budgets");
				const store = new BudgetStore(url, options);
				cleanups.push(async () => {
					const client = new MongoClient(url);
					await client.db().dropDatabase();
					await client.close();
					await store.close();
				});
				return store;
			},
		],
	];
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

const policy = (overrides: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
	id: "p1",
	appliesTo: { kind: "everyone" },
	covers: { kind: "all" },
	limitUsd: 10,
	period: "month",
	enabled: true,
	createdAt: "2026-11-20T00:00:00.000Z",
	updatedAt: "2026-11-20T00:00:00.000Z",
	...overrides,
});

describe.each(stores())("BudgetStore (%s)", (_name, make) => {
	it("starts a workspace with its old video budget and this month's video spend, once", async () => {
		let seeds = 0;
		const store = make({
			seed: async (): Promise<BudgetSeed> => {
				seeds += 1;
				return { videoMonthlyBudgetUsd: 7.5, videoSpentUsd: 2 };
			},
		});
		// Two first reads at once: one seed stands, and its spend is counted once.
		const [first, second] = await Promise.all([
			store.policies(WS.id),
			store.policies(WS.id),
		]);
		expect(first.policies).toHaveLength(1);
		expect(second.policies.map((item) => item.id)).toEqual(
			first.policies.map((item) => item.id),
		);
		expect(first.policies[0]).toMatchObject({
			appliesTo: { kind: "everyone" },
			covers: { kind: "video" },
			limitUsd: 7.5,
			period: "month",
			enabled: true,
		});
		const seeded = (await store.policies(WS.id)).policies;
		expect(await store.spent(WS.id, seeded)).toEqual([2_000_000]);
		expect(seeds).toBeGreaterThanOrEqual(1);
		// Deleting every budget leaves none: the seed is not made again.
		const { revision } = await store.policies(WS.id);
		await store.write(WS.id, [], revision);
		expect((await store.policies(WS.id)).policies).toEqual([]);
	});

	it("refuses a write from a stale read", async () => {
		const store = make();
		const { revision } = await store.policies(WS.id);
		await store.write(WS.id, [policy()], revision);
		expect(
			await refusal(store.write(WS.id, [policy({ id: "p2" })], revision)),
		).toMatchObject({ status: 409 });
	});

	it("counts spend per period, and a new day starts from zero", async () => {
		let now = new Date("2026-11-20T23:00:00Z");
		const store = make({ now: () => now });
		const daily = policy({ id: "day", period: "day" });
		const monthly = policy({ id: "month" });
		await store.charge(WS.id, [daily, monthly], 1_500_000);
		await store.charge(WS.id, [daily, monthly], 500_000);
		expect(await store.spent(WS.id, [daily, monthly])).toEqual([
			2_000_000, 2_000_000,
		]);
		now = new Date("2026-11-21T01:00:00Z");
		expect(await store.spent(WS.id, [daily, monthly])).toEqual([0, 2_000_000]);
	});

	it("counts a retried charge once, and every one of many charges racing to a new counter", async () => {
		const store = make();
		const daily = policy({ id: "day", period: "day" });
		const monthly = policy({ id: "month" });
		await store.charge(WS.id, [daily, monthly], 1_000_000, "charge-1");
		// The same charge again, as after a write whose answer was lost.
		await store.charge(WS.id, [daily, monthly], 1_000_000, "charge-1");
		expect(await store.spent(WS.id, [daily, monthly])).toEqual([
			1_000_000, 1_000_000,
		]);
		const fresh = policy({ id: "fresh" });
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				store.charge(WS.id, [fresh], 500_000, `race-${index}`),
			),
		);
		expect(await store.spent(WS.id, [fresh])).toEqual([4_000_000]);
	});

	it("holds against every budget or none, and gives holds back", async () => {
		const store = make();
		const roomy = policy({ id: "roomy", limitUsd: 10 });
		const tight = policy({ id: "tight", limitUsd: 3 });
		const first = await store.hold(WS.id, [roomy, tight], 2_000_000);
		expect(first).toMatchObject({ costMicros: 2_000_000 });
		// The tight one has $1 left: nothing is taken from the roomy one either.
		expect(await store.hold(WS.id, [roomy, tight], 2_000_000)).toEqual({
			refused: tight,
		});
		expect(await store.spent(WS.id, [roomy, tight])).toEqual([
			2_000_000, 2_000_000,
		]);
		if ("refused" in first) throw new Error("held");
		await store.release(first);
		await store.release(first);
		// Never below zero, however often a hold is given back.
		expect(await store.spent(WS.id, [roomy, tight])).toEqual([0, 0]);
	});

	it("refuses even a free hold once a budget is used up, or is $0", async () => {
		const store = make();
		expect(await store.hold(WS.id, [policy({ limitUsd: 0 })], 0)).toMatchObject(
			{
				refused: { limitUsd: 0 },
			},
		);
		const one = policy({ id: "one", limitUsd: 1 });
		expect(await store.hold(WS.id, [one], 1_000_000)).toMatchObject({
			costMicros: 1_000_000,
		});
		expect(await store.hold(WS.id, [one], 0)).toMatchObject({ refused: one });
	});

	it("seeds again when the carried spend could not be written, and gives back a hold from before budgets once", async () => {
		const store = make({
			seed: async () => ({ videoMonthlyBudgetUsd: 10, videoSpentUsd: 3 }),
		});
		const charge = vi
			.spyOn(store, "charge")
			.mockRejectedValueOnce(new ServiceError("Budgets are unavailable.", 503));
		expect(await refusal(store.policies(WS.id))).toMatchObject({ status: 503 });
		// Nothing was saved, so the next read seeds, and counts the spend once.
		const { policies } = await store.policies(WS.id);
		expect(charge).toHaveBeenCalledTimes(2);
		expect(policies).toHaveLength(1);
		expect(policies[0].origin).toBe("video-budget");
		expect(await store.spent(WS.id, policies)).toEqual([3_000_000]);
		const month = new Date().toISOString().slice(0, 7);
		await store.releaseCarried(WS.id, month, 1_000_000);
		// A hold from another month was never carried here.
		await store.releaseCarried(WS.id, "2001-01", 1_000_000);
		expect(await store.spent(WS.id, policies)).toEqual([2_000_000]);
	});

	it("lets only one of many concurrent holds take the last of a budget", async () => {
		const store = make();
		const one = policy({ limitUsd: 1 });
		const results = await Promise.all(
			Array.from({ length: 8 }, () => store.hold(WS.id, [one], 1_000_000)),
		);
		expect(results.filter((result) => !("refused" in result))).toHaveLength(1);
		expect(await store.spent(WS.id, [one])).toEqual([1_000_000]);
	});
});

describe("BudgetService", () => {
	function setup(knownAgents = ["a1", "a2"]) {
		let now = new Date("2026-11-20T12:00:00Z");
		const store = new BudgetStore(undefined, { now: () => now });
		const budgets = new BudgetService(store, {
			now: () => now,
			knownAgents: async () => new Set(knownAgents),
		});
		return {
			budgets,
			store,
			advance: (ms: number) => {
				now = new Date(now.getTime() + ms);
			},
		};
	}
	const input = (overrides: Partial<BudgetPolicyInput> = {}) => ({
		appliesTo: { kind: "everyone" as const },
		covers: { kind: "all" as const },
		limitUsd: 10,
		period: "month" as const,
		...overrides,
	});

	it("adds, changes, and deletes budgets, and checks what is sent", async () => {
		const { budgets } = setup();
		const created = await budgets.create(
			WS,
			input({
				appliesTo: { kind: "agents", agentIds: ["a1", " a2 ", "a1"] },
				covers: { kind: "llm-model", model: OPUS },
				limitUsd: 4.567,
				period: "day",
			}),
		);
		expect(created).toMatchObject({
			appliesTo: { kind: "agents", agentIds: ["a1", "a2"] },
			covers: { kind: "llm-model", model: OPUS },
			limitUsd: 4.57,
			period: "day",
			enabled: true,
			usage: { period: "2026-11-20", spentUsd: 0 },
		});
		expect(created.usage.resetsAt).toBe("2026-11-21T00:00:00.000Z");
		const changed = await budgets.update(WS, created.id, {
			limitUsd: 9,
			enabled: false,
		});
		expect(changed).toMatchObject({
			limitUsd: 9,
			enabled: false,
			period: "day",
		});
		// The seeded video budget, then this one.
		expect((await budgets.list(WS)).policies).toHaveLength(2);
		await budgets.remove(WS, created.id);
		expect((await budgets.list(WS)).policies).toHaveLength(1);
		expect(await refusal(budgets.remove(WS, created.id))).toMatchObject({
			status: 404,
		});
		for (const [bad, message] of [
			[
				input({ appliesTo: { kind: "agents", agentIds: [] } }),
				"Pick at least one agent",
			],
			[
				input({ appliesTo: { kind: "agents", agentIds: ["ghost"] } }),
				"ghost is not an agent",
			],
			[input({ covers: { kind: "llm-model", model: " " } }), "Pick a model"],
			[
				input({ covers: { kind: "video-model", model: "nope" } }),
				"nope is not a video model",
			],
			[input({ limitUsd: -1 }), "The limit is from $0"],
			[input({ period: "week" as never }), "a day or a month"],
		] as const)
			expect(await refusal(budgets.create(WS, bad))).toMatchObject({
				status: 400,
				message: expect.stringContaining(message),
			});
	});

	it("merges concurrent edits, and starts spend afresh when what a budget limits changes", async () => {
		const { budgets, advance } = setup();
		const created = await budgets.create(WS, input({ limitUsd: 10 }));
		// Two people change different fields at once: neither undoes the other.
		await Promise.all([
			budgets.update(WS, created.id, { limitUsd: 3 }),
			budgets.update(WS, created.id, { enabled: false }),
		]);
		const both = (await budgets.list(WS)).policies.find(
			(item) => item.id === created.id,
		);
		expect(both).toMatchObject({ limitUsd: 3, enabled: false });
		await budgets.update(WS, created.id, { enabled: true });
		budgets.chargeLlm(WS.id, PERSON, OPUS, 2);
		await budgets.idle();
		const spent = async () =>
			(await budgets.list(WS)).policies.find((item) => item.id === created.id)
				?.usage.spentUsd;
		expect(await spent()).toBe(2);
		// A new limit keeps what was spent; new coverage counts from now.
		await budgets.update(WS, created.id, { limitUsd: 4 });
		expect(await spent()).toBe(2);
		advance(1000);
		await budgets.update(WS, created.id, { covers: { kind: "llm" } });
		expect(await spent()).toBe(0);
		expect(
			await refusal(budgets.update(WS, created.id, { limitUsd: 0.004 })),
		).toMatchObject({ message: expect.stringContaining("at least $0.01") });
	});

	it("keeps a budget editable after an agent it names is removed", async () => {
		const known = ["a1", "a2"];
		const { budgets } = setup(known);
		const created = await budgets.create(
			WS,
			input({ appliesTo: { kind: "agents", agentIds: ["a1", "a2"] } }),
		);
		known.splice(1);
		expect(
			(await budgets.update(WS, created.id, { limitUsd: 3 })).limitUsd,
		).toBe(3);
	});

	it("refuses a language model call once a budget that covers it is used up", async () => {
		const { budgets, advance } = setup();
		const shared = await budgets.create(
			WS,
			input({
				appliesTo: { kind: "agents", agentIds: ["a1", "a2"] },
				covers: { kind: "llm" },
				limitUsd: 5,
				period: "day",
			}),
		);
		await budgets.create(
			WS,
			input({ covers: { kind: "llm-model", model: OPUS }, limitUsd: 20 }),
		);
		expect(await budgets.llmRefusal(WS.id, AGENT, OPUS)).toBeNull();
		budgets.chargeLlm(WS.id, AGENT, OPUS, 3);
		budgets.chargeLlm(WS.id, OTHER_AGENT, "openai/gpt-6", 2.5);
		await budgets.idle();
		// The two agents share $5 a day and spent $5.50 together.
		expect(await budgets.llmRefusal(WS.id, OTHER_AGENT, OPUS)).toBe(
			'The budget "2 agents · All language models · $5.00 a day" is used up: $5.50 of $5.00 spent. It starts again at 2026-11-21 00:00 UTC. A workspace admin can change it on the Models page, under Budget.',
		);
		// People are not in it, and videos are not language models.
		expect(await budgets.llmRefusal(WS.id, PERSON, OPUS)).toBeNull();
		const listed = await budgets.list(WS);
		expect(
			listed.policies.map((item) => [
				item.id === shared.id,
				item.usage.spentUsd,
			]),
		).toEqual([
			[false, 0],
			[true, 5.5],
			[false, 3],
		]);
		advance(12 * 3_600_000);
		expect(await budgets.llmRefusal(WS.id, AGENT, OPUS)).toBeNull();
	});

	it("refuses everything a budget of zero covers, and nothing once it is switched off", async () => {
		const { budgets } = setup();
		const zero = await budgets.create(
			WS,
			input({ covers: { kind: "llm-model", model: OPUS }, limitUsd: 0 }),
		);
		expect(await budgets.llmRefusal(WS.id, PERSON, OPUS)).toContain(
			"$0.00 a month",
		);
		expect(await budgets.llmRefusal(WS.id, PERSON, "openai/gpt-6")).toBeNull();
		await budgets.update(WS, zero.id, { enabled: false });
		expect(await budgets.llmRefusal(WS.id, PERSON, OPUS)).toBeNull();
	});
});

describe("budget routes and language model calls", () => {
	let provider: StubProvider;
	beforeAll(async () => {
		provider = await startStubProvider();
	});
	afterAll(async () => {
		await provider.close();
	});

	async function start() {
		const telemetry = new TelemetryService();
		const server = await withSession(
			createServer({
				config: configFromEnv({}),
				registry: provider.registry,
				telemetry,
				logger: false,
			}),
		);
		cleanups.push(() => server.close());
		// $1 per token: the stub's 10 in and 5 out cost $15 a call.
		telemetry.setPricingResolver(() => ({
			input: 1_000_000,
			output: 1_000_000,
		}));
		return server;
	}
	const chat = {
		model: "stub/chat-model",
		messages: [{ role: "user", content: "Hi" }],
	};

	it("lets members read budgets and only admins change them", async () => {
		const server = await start();
		const list = await server.inject({ method: "GET", url: "/v1/budgets" });
		expect(list.statusCode).toBe(200);
		expect(list.json().policies).toMatchObject([
			{ covers: { kind: "video" }, limitUsd: 25, period: "month" },
		]);
		const member = await joinWithInvite(
			server,
			server.session,
			"viewer@example.com",
		);
		const as = { authorization: `Bearer ${member.token}` };
		expect(
			(await server.inject({ method: "GET", url: "/v1/budgets", headers: as }))
				.statusCode,
		).toBe(200);
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/budgets",
					headers: as,
					payload: {
						appliesTo: { kind: "everyone" },
						covers: { kind: "all" },
						limitUsd: 1,
						period: "day",
					},
				})
			).statusCode,
		).toBe(403);
		const created = await server.inject({
			method: "POST",
			url: "/v1/budgets",
			payload: {
				appliesTo: { kind: "agents", agentIds: ["nobody"] },
				covers: { kind: "all" },
				limitUsd: 1,
				period: "day",
			},
		});
		expect(created.statusCode).toBe(400);
		expect(created.json().error.message).toContain("nobody is not an agent");
		const id = list.json().policies[0].id;
		const patched = await server.inject({
			method: "PATCH",
			url: `/v1/budgets/${id}`,
			payload: { limitUsd: 40 },
		});
		expect(patched.json()).toMatchObject({ limitUsd: 40 });
		expect(
			(await server.inject({ method: "DELETE", url: `/v1/budgets/${id}` }))
				.statusCode,
		).toBe(204);
	});

	it("refuses chat with 429 once a budget is used up, streaming or not", async () => {
		const server = await start();
		const added = await server.inject({
			method: "POST",
			url: "/v1/budgets",
			payload: {
				appliesTo: { kind: "everyone" },
				covers: { kind: "llm-model", model: "stub/chat-model" },
				limitUsd: 20,
				period: "month",
			},
		});
		expect(added.statusCode).toBe(201);
		// A charge lands after its call; wait for it before the next call.
		const spentReaches = (usd: number) =>
			vi.waitFor(async () => {
				const listed = await server.inject({
					method: "GET",
					url: "/v1/budgets",
				});
				expect(
					listed
						.json()
						.policies.find(
							(item: BudgetPolicy) => item.covers.kind === "llm-model",
						).usage.spentUsd,
				).toBe(usd);
			});
		const first = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: chat,
		});
		expect(first.statusCode).toBe(200);
		await spentReaches(15);
		// $15 of $20: still under, so the next call starts and takes it to $30.
		const second = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: chat,
		});
		expect(second.statusCode).toBe(200);
		await spentReaches(30);
		const refused = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: chat,
		});
		expect(refused.statusCode).toBe(429);
		expect(refused.json().error).toMatchObject({
			type: "budget_exceeded",
			message: expect.stringContaining(
				'"Everyone · stub/chat-model · $20.00 a month" is used up: $30.00 of $20.00',
			),
		});
		const stream = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: { ...chat, stream: true },
		});
		expect(stream.statusCode).toBe(429);
		expect(stream.json().error.type).toBe("budget_exceeded");
		const listed = await server.inject({ method: "GET", url: "/v1/budgets" });
		expect(
			listed
				.json()
				.policies.find((item: BudgetPolicy) => item.covers.kind === "llm-model")
				.usage.spentUsd,
		).toBe(30);
	});

	it("fails over past a model a budget refuses, and reports the provider's own error", async () => {
		const server = await start();
		await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { enabled: true, targets: ["stub/chat-model"] },
		});
		await server.inject({
			method: "POST",
			url: "/v1/budgets",
			payload: {
				appliesTo: { kind: "everyone" },
				covers: { kind: "llm-model", model: "stub/chat-model" },
				limitUsd: 0,
				period: "day",
			},
		});
		// The requested model fails; the only failover target is refused.
		const failed = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: { ...chat, model: "stub/broken-model" },
		});
		expect(failed.statusCode).toBe(502);
		expect(failed.json().error.message).toMatch(
			/provider exploded.*\(another model was skipped: a budget that covers it is used up\)/,
		);
		expect(failed.json().error.attempts).toMatchObject([
			{ model: "stub/broken-model" },
			{
				model: "stub/chat-model",
				error: expect.stringContaining("is used up"),
			},
		]);
		// Asked for the refused model, the stream says it fails over, then why it ended.
		await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { enabled: true, targets: ["stub/broken-model"] },
		});
		const stream = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: { ...chat, stream: true },
		});
		expect(stream.statusCode).toBe(200);
		const events = stream.body
			.split("\n\n")
			.filter((line) => line.startsWith("data: {"))
			.map((line) => JSON.parse(line.slice(6)));
		expect(events[0]).toMatchObject({
			type: "failover",
			from: "stub/chat-model",
			to: "stub/broken-model",
			error: expect.stringContaining("is used up"),
		});
		expect(events.at(-1)).toMatchObject({
			type: "error",
			error: { message: expect.stringContaining("provider exploded") },
		});
	});
});

import type { AnalyticsQuery } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { ModelCatalogService } from "../src/model-catalog-service.js";
import { createServer } from "../src/server.js";
import { MongoTelemetrySink } from "../src/telemetry/mongo.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { withSession } from "./auth-helpers.js";
import { startStubProvider } from "./helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const from = "2026-11-01T00:00:00.000Z";
const to = "2026-11-02T00:00:00.000Z";
const query: AnalyticsQuery = { from, to };
const usage = {
	promptTokens: 1_000_000,
	completionTokens: 500_000,
	totalTokens: 1_500_000,
};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function seed(telemetry: TelemetryService, setTime: (value: string) => void) {
	telemetry.setPricingResolver((model) =>
		model === "work/paid"
			? { input: 2, output: 6 }
			: model === "work/free"
				? { input: 0, output: 0 }
				: undefined,
	);
	setTime("2026-11-01T01:00:00.000Z");
	telemetry.recordChat({
		model: "work/paid",
		provider: "work",
		agentId: "spoofed-agent",
		caller: { id: "api-token:1", name: "Product team", kind: "api-token" },
		usage,
		latencyMs: 100,
	});
	telemetry.recordChat({
		model: "work/paid",
		provider: "work",
		caller: { id: "api-token:1", name: "Product team", kind: "api-token" },
		usage,
		latencyMs: 300,
	});
	setTime("2026-11-01T02:00:00.000Z");
	telemetry.recordChat({
		operation: "routing",
		model: "local/unknown",
		provider: "local",
		agentId: "agent-a",
		usage,
		latencyMs: 500,
		error: "failed",
	});
	telemetry.recordChat({
		operation: "decisions",
		model: "work/free",
		provider: "work",
		usage,
		latencyMs: 50,
	});
	setTime(to);
	telemetry.recordChat({
		model: "work/paid",
		provider: "work",
		usage,
		latencyMs: 100,
	}); // exclusive end
}

/**
 * An agent's calls as the gateway records them (a bot it runs and an MCP
 * agent), after older history that only carried the agent id.
 */
function seedAgents(
	telemetry: TelemetryService,
	setTime: (value: string) => void,
) {
	setTime("2026-11-01T04:00:00.000Z");
	telemetry.recordChat({
		model: "work/paid",
		provider: "work",
		agentId: "bot-1",
		usage,
		latencyMs: 100,
	});
	setTime("2026-11-01T05:00:00.000Z");
	telemetry.recordChat({
		model: "work/paid",
		provider: "work",
		caller: { id: "agent:bot-1", name: "Helper", kind: "agent" },
		usage,
		latencyMs: 100,
	});
	telemetry.recordChat({
		model: "work/paid",
		provider: "work",
		agentId: "mcp-1",
		caller: { id: "agent:mcp-1", name: "Claude Desktop", kind: "agent" },
		usage,
		latencyMs: 100,
	});
	// A recorded agent caller must name an agent; anything else is not trusted.
	telemetry.recordChat({
		model: "work/paid",
		provider: "work",
		caller: { id: "api-token:9", name: "Impostor", kind: "agent" },
		usage,
		latencyMs: 100,
	});
}

/** Four fetches: plain, through a proxy, blocked, and from the cache. */
function seedWeb(
	telemetry: TelemetryService,
	setTime: (value: string) => void,
) {
	const helper = { id: "agent:bot-1", name: "Helper", kind: "agent" as const };
	const founder = { id: "user:1", name: "Founder", kind: "user" as const };
	setTime("2026-11-01T06:00:00.000Z");
	telemetry.recordWebFetch({
		workspaceId: "default",
		caller: helper,
		host: "example.com",
		ok: true,
		via: "direct",
		cached: false,
		costUsd: 0,
		latencyMs: 200,
		attempts: [
			{
				step: "direct",
				outcome: "ok",
				status: 200,
				latencyMs: 200,
				costUsd: 0,
			},
		],
	});
	telemetry.recordWebFetch({
		workspaceId: "default",
		caller: helper,
		host: "shop.test",
		ok: true,
		via: "zenrows:auto",
		cached: false,
		costUsd: 0.25,
		latencyMs: 1000,
		attempts: [
			{
				step: "direct",
				outcome: "blocked",
				status: 403,
				latencyMs: 100,
				costUsd: 0,
			},
			{
				step: "zenrows:auto",
				outcome: "ok",
				status: 200,
				latencyMs: 900,
				costUsd: 0.25,
			},
		],
	});
	setTime("2026-11-01T07:00:00.000Z");
	telemetry.recordWebFetch({
		workspaceId: "default",
		caller: founder,
		host: "shop.test",
		ok: false,
		via: "",
		cached: false,
		costUsd: 0.5,
		latencyMs: 3000,
		attempts: [
			{
				step: "direct",
				outcome: "blocked",
				status: 403,
				latencyMs: 100,
				costUsd: 0,
			},
			{
				step: "zenrows:premium",
				outcome: "blocked",
				status: 403,
				latencyMs: 2900,
				costUsd: 0.5,
			},
		],
	});
	telemetry.recordWebFetch({
		workspaceId: "default",
		caller: founder,
		host: "example.com",
		ok: true,
		via: "direct",
		cached: true,
		costUsd: 0,
		latencyMs: 0,
		attempts: [],
	});
}

/**
 * A fetch blocked directly whose proxy was skipped for the budget, and one
 * recorded before fetches kept their outcome and cost.
 */
function seedSkippedAndLegacy(
	telemetry: TelemetryService,
	setTime: (value: string) => void,
) {
	setTime("2026-11-01T08:00:00.000Z");
	telemetry.recordWebFetch({
		workspaceId: "default",
		caller: { id: "user:1", name: "Founder", kind: "user" },
		host: "shop.test",
		ok: false,
		via: "",
		cached: false,
		costUsd: 0,
		latencyMs: 150,
		attempts: [
			{
				step: "direct",
				outcome: "blocked",
				status: 403,
				latencyMs: 150,
				costUsd: 0,
			},
			{
				step: "zenrows:auto",
				outcome: "skipped",
				status: null,
				latencyMs: 0,
				costUsd: 0,
			},
		],
	});
	const legacy = {
		id: "legacy-web",
		type: "gateway.web",
		workspaceId: "default",
		timestamp: "2026-11-01T09:00:00.000Z",
		data: { operation: "web", callerId: "user:1", callerKind: "user" },
	};
	telemetry.record(legacy);
	return legacy;
}

describe("usage analytics", () => {
	it.each([
		{ name: "chat", operation: "chat" as const, stream: false },
		{ name: "streaming chat", operation: "chat" as const, stream: true },
		{ name: "decisions", operation: "decisions" as const, stream: false },
		{ name: "routing selectors", operation: "routing" as const, stream: false },
	])("keeps failed $name calls unpriced when usage is missing or partial", async ({
		operation,
		stream,
	}) => {
		const telemetry = new TelemetryService({ now: () => new Date(from) });
		telemetry.setPricingResolver((model) =>
			model === "work/free" ? { input: 0, output: 0 } : { input: 2, output: 6 },
		);
		const emptyUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		for (const recordedUsage of [emptyUsage, usage]) {
			const failed = telemetry.recordChat({
				operation,
				stream,
				model: "work/paid",
				provider: "work",
				usage: recordedUsage,
				latencyMs: 10,
				error: "Provider failed before completing usage reporting",
			});
			expect(failed.data).not.toHaveProperty("estimatedCostUsd");
			expect(failed.data).not.toHaveProperty("pricing");
		}
		telemetry.recordChat({
			operation,
			stream,
			model: "work/paid",
			provider: "work",
			usage,
			latencyMs: 100,
		});
		const free = telemetry.recordChat({
			operation,
			stream,
			model: "work/free",
			provider: "work",
			usage,
			latencyMs: 100,
		});
		expect(free.data.estimatedCostUsd).toBe(0);
		const result = await telemetry.analytics(query);
		expect(result.totals).toMatchObject({
			requests: 4,
			errors: 2,
			pricedRequests: 2,
			estimatedCostUsd: 5,
		});
		expect(result.byModel.find((row) => row.id === "work/paid")).toMatchObject({
			requests: 3,
			errors: 2,
			pricedRequests: 1,
			estimatedCostUsd: 5,
		});
		expect(result.byModel.find((row) => row.id === "work/free")).toMatchObject({
			pricedRequests: 1,
			estimatedCostUsd: 0,
		});
	});

	it("reconciles money, caller identity, filters, successful latency, and empty time buckets", async () => {
		let time = from;
		const telemetry = new TelemetryService({
			maxRecent: 1,
			now: () => new Date(time),
		});
		seed(telemetry, (value) => {
			time = value;
		});
		const result = await telemetry.analytics(query);
		expect(result.totals).toEqual({
			requests: 4,
			errors: 1,
			promptTokens: 4_000_000,
			completionTokens: 2_000_000,
			totalTokens: 6_000_000,
			estimatedCostUsd: 10,
			pricedRequests: 3,
			avgLatencyMs: 150,
		});
		expect(result.activeCallers).toBe(2);
		expect(result.unattributedRequests).toBe(1);
		expect(result.byCaller.map((row) => row.id)).not.toContain(
			"agent:spoofed-agent",
		);
		expect(result.byOperation.find((row) => row.id === "routing")?.errors).toBe(
			1,
		);
		expect(result.series).toHaveLength(24);
		expect(result.series[0].requests).toBe(0);
		expect(result.series[1].estimatedCostUsd).toBe(10);
		expect(result.series.reduce((sum, point) => sum + point.requests, 0)).toBe(
			4,
		);
		expect(result.partial).toBe(false);
		expect(telemetry.recentEvents()).toHaveLength(1);
		const filtered = await telemetry.analytics({
			...query,
			model: "work/paid",
			provider: "work",
			caller: "api-token:1",
		});
		expect(filtered.totals).toMatchObject({
			requests: 2,
			estimatedCostUsd: 10,
			avgLatencyMs: 200,
		});
		expect(filtered.byModel).toHaveLength(1);
		expect(filtered.options.models).toHaveLength(3);
		expect(
			(await telemetry.analytics({ ...query, provider: "missing" })).totals
				.requests,
		).toBe(0);
		telemetry.setPricingResolver(() => ({ input: 99, output: 99 }));
		expect((await telemetry.analytics(query)).totals.estimatedCostUsd).toBe(10); // historical snapshot
	});

	it("names agents by their recorded identity and merges older history by agent id", async () => {
		let time = from;
		const telemetry = new TelemetryService({ now: () => new Date(time) });
		seedAgents(telemetry, (value) => {
			time = value;
		});
		const result = await telemetry.analytics(query);
		expect(
			result.byCaller.map(({ id, name, kind, requests }) => ({
				id,
				name,
				kind,
				requests,
			})),
		).toEqual([
			{ id: "agent:bot-1", name: "Helper", kind: "agent", requests: 2 },
			{
				id: "agent:mcp-1",
				name: "Claude Desktop",
				kind: "agent",
				requests: 1,
			},
			{
				id: "unattributed",
				name: "Unattributed",
				kind: "unattributed",
				requests: 1,
			},
		]);
		expect(result.activeCallers).toBe(2);
		expect(result.unattributedRequests).toBe(1);
		const filtered = await telemetry.analytics({
			...query,
			caller: "agent:bot-1",
		});
		expect(filtered.totals.requests).toBe(2);
	});

	it("reports web fetches apart from model calls", async () => {
		let time = from;
		const telemetry = new TelemetryService({ now: () => new Date(time) });
		seedWeb(telemetry, (value) => {
			time = value;
		});
		const result = await telemetry.analytics(query);
		expect(result.totals.requests).toBe(0);
		expect(result.byOperation).toEqual([]);
		expect(result.web.totals).toEqual({
			fetches: 4,
			succeeded: 3,
			proxied: 2,
			cached: 1,
			costUsd: 0.75,
			avgLatencyMs: 400,
		});
		expect(result.web.byConnection).toEqual([
			{
				id: "direct",
				attempts: 3,
				succeeded: 1,
				costUsd: 0,
				lastSeen: "2026-11-01T07:00:00.000Z",
			},
			{
				id: "zenrows",
				attempts: 2,
				succeeded: 1,
				costUsd: 0.75,
				lastSeen: "2026-11-01T07:00:00.000Z",
			},
		]);
		expect(result.web.byOutcome).toEqual([
			{ id: "ok", fetches: 3 },
			{ id: "blocked", fetches: 1 },
		]);
		expect(result.web.byHost.map((row) => [row.id, row.fetches])).toEqual([
			["shop.test", 2],
			["example.com", 2],
		]);
		expect(
			result.web.byCaller.map(({ id, name, fetches, costUsd }) => ({
				id,
				name,
				fetches,
				costUsd,
			})),
		).toEqual([
			{ id: "user:1", name: "Founder", fetches: 2, costUsd: 0.5 },
			{ id: "agent:bot-1", name: "Helper", fetches: 2, costUsd: 0.25 },
		]);
		expect(result.web.legacyFetches).toBe(0);
		expect(result.options.callers.map((caller) => caller.id).sort()).toEqual([
			"agent:bot-1",
			"user:1",
		]);
		const founder = await telemetry.analytics({ ...query, caller: "user:1" });
		expect(founder.web.totals).toMatchObject({ fetches: 2, costUsd: 0.5 });
		// A tie on attempts puts the costlier connection first.
		expect(founder.web.byConnection.map((row) => row.id)).toEqual([
			"zenrows",
			"direct",
		]);
		// Model filters leave web fetches alone; they have no model.
		const model = await telemetry.analytics({ ...query, model: "work/paid" });
		expect(model.web.totals.fetches).toBe(4);
	});

	it("counts no skipped step as a request, and leaves pre-upgrade fetches out", async () => {
		let time = from;
		const telemetry = new TelemetryService({ now: () => new Date(time) });
		seedSkippedAndLegacy(telemetry, (value) => {
			time = value;
		});
		const result = await telemetry.analytics(query);
		// The skipped proxy made no request: the fetch ended blocked, unproxied.
		expect(result.web.totals).toMatchObject({
			fetches: 1,
			succeeded: 0,
			proxied: 0,
		});
		expect(result.web.byOutcome).toEqual([{ id: "blocked", fetches: 1 }]);
		expect(
			result.web.byConnection.map((row) => [row.id, row.attempts]),
		).toEqual([["direct", 1]]);
		// The older fetch is counted apart, not as a free failure.
		expect(result.web.legacyFetches).toBe(1);
	});

	it("reports bounded history eviction and falls back when durable storage fails", async () => {
		let time = from;
		const sink = new MongoTelemetrySink(
			"mongodb://127.0.0.1:9/unreachable",
			500,
		);
		const telemetry = new TelemetryService({
			maxAnalyticsEvents: 2,
			now: () => new Date(time),
			sink,
			flushIntervalMs: 60_000,
		});
		cleanups.push(() => telemetry.close());
		seed(telemetry, (value) => {
			time = value;
		});
		const result = await telemetry.analytics(query);
		expect(result).toMatchObject({
			source: "memory",
			partial: true,
			durableUnavailable: true,
		});
		expect(result.totals.requests).toBe(1);
		expect(result.coverageFrom).toBe("2026-11-01T02:00:00.001Z");
	});

	it("rejects malformed, inverted and oversized ranges and accepts timezone offsets", async () => {
		const server = await withSession(
			createServer({
				config: { providers: [], corsOrigins: [] },
				logger: false,
			}),
		);
		cleanups.push(() => server.close());
		for (const params of [
			{ from: "bad", to },
			{ from: to, to: from },
			{ from, to: "2027-11-02T00:00:00Z" },
		]) {
			expect(
				(
					await server.inject(
						`/v1/telemetry/analytics?${new URLSearchParams(params)}`,
					)
				).statusCode,
			).toBe(400);
		}
		const response = await server.inject(
			`/v1/telemetry/analytics?${new URLSearchParams({ from: "2026-10-31T17:00:00-07:00", to })}`,
		);
		expect(response.statusCode).toBe(200);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.json().query.from).toBe(from);
	});

	it("captures authenticated callers for chat and streaming without storing secrets", async () => {
		const stub = await startStubProvider();
		const telemetry = new TelemetryService();
		const server = await withSession(
			createServer({
				registry: stub.registry,
				telemetry,
				config: { providers: [], corsOrigins: [] },
				logger: false,
			}),
		);
		cleanups.push(() => server.close(), stub.close);
		const issued = (
			await server.inject({
				method: "POST",
				url: "/v1/api-tokens",
				payload: {
					name: "Dashboard client",
					description: "",
					ttlDays: 30,
					permissions: ["inference:run"],
				},
			})
		).json();
		const headers = { authorization: `Bearer ${issued.secret}` };
		for (const stream of [false, true]) {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat",
				headers,
				payload: {
					model: "stub/chat-model",
					agentId: "reported",
					messages: [{ role: "user", content: "hello" }],
					stream,
				},
			});
			expect(response.statusCode).toBe(200);
		}
		const result = await telemetry.analytics({
			from: new Date(Date.now() - 60_000).toISOString(),
			to: new Date(Date.now() + 1000).toISOString(),
		});
		expect(result.byCaller).toHaveLength(1);
		expect(result.byCaller[0]).toMatchObject({
			id: `api-token:${issued.token.id}`,
			name: "Dashboard client",
			requests: 2,
		});
		expect(JSON.stringify(telemetry.recentEvents())).not.toContain(
			issued.secret,
		);
		expect(JSON.stringify(result)).not.toContain("agent:reported");
	});

	it("prices renamed provider connections from their provider kind", async () => {
		const telemetry = new TelemetryService();
		const modelCatalog = new ModelCatalogService({
			base: {
				updated: from,
				providers: {
					openai: {
						name: "OpenAI",
						source: "models.dev",
						models: [
							{ id: "paid", name: "Paid", pricing: { input: 2, output: 6 } },
						],
					},
				},
			},
		});
		const server = await withSession(
			createServer({
				telemetry,
				modelCatalog,
				config: {
					corsOrigins: [],
					providers: [
						{
							name: "work",
							kind: "openai",
							apiKey: "unused",
							models: ["paid"],
						},
					],
				},
				logger: false,
			}),
		);
		cleanups.push(() => server.close());
		// Call sites pass the connection's implementation kind with every call.
		const event = telemetry.recordChat({
			model: "work/paid",
			provider: "work",
			providerKind: "openai",
			usage,
			latencyMs: 10,
		});
		expect(event.data.estimatedCostUsd).toBe(5);
	});
});

const available = await mongoAvailable();
describe.skipIf(!available)("durable analytics", () => {
	it("matches memory across grouped filters, old events, deduplication, and priced zero", async () => {
		let time = from;
		const url = uniqueMongoUrl("analytics");
		const sink = new MongoTelemetrySink(url);
		const durable = new TelemetryService({
			sink,
			now: () => new Date(time),
			flushIntervalMs: 60_000,
		});
		const memory = new TelemetryService({ now: () => new Date(time) });
		cleanups.push(async () => {
			await durable.close();
			const client = new MongoClient(url, { serverSelectionTimeoutMS: 1500 });
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close();
			}
		});
		seed(durable, (value) => {
			time = value;
		});
		time = "2026-11-01T03:00:00.000Z";
		durable.recordChat({
			model: "work/paid",
			provider: "work",
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			latencyMs: 50,
			error: "Provider failed without usage",
		});
		for (const event of durable.recentEvents()) memory.record(event);
		const legacy = {
			id: "old",
			type: "gateway.error",
			timestamp: "2026-11-01T03:00:00.000Z",
			data: { model: "legacy/model", provider: "legacy", totalTokens: 10 },
		};
		durable.record(legacy);
		memory.record(legacy);
		await durable.flush();
		await sink.insert([legacy]);
		for (const filters of [
			{},
			{ provider: "work" },
			{ caller: "api-token:1", model: "work/paid" },
		]) {
			const result = await durable.analytics({ ...query, ...filters });
			const expected = await memory.analytics({ ...query, ...filters });
			expect(result.source).toBe("mongodb");
			for (const key of [
				"totals",
				"byModel",
				"byCaller",
				"byProvider",
				"byOperation",
				"series",
			] as const)
				expect(result[key]).toEqual(expected[key]);
		}
		const restarted = new TelemetryService({
			sink,
			flushIntervalMs: 60_000,
		});
		cleanups.unshift(() => restarted.close());
		expect((await restarted.analytics(query)).totals).toMatchObject({
			requests: 6,
			errors: 3,
			pricedRequests: 3,
			estimatedCostUsd: 10,
		});
	});

	it("attributes agents the same way in MongoDB and memory", async () => {
		let time = from;
		const url = uniqueMongoUrl("agents");
		const sink = new MongoTelemetrySink(url);
		const durable = new TelemetryService({
			sink,
			now: () => new Date(time),
			flushIntervalMs: 60_000,
		});
		const memory = new TelemetryService({ now: () => new Date(time) });
		cleanups.push(async () => {
			await durable.close();
			const client = new MongoClient(url, { serverSelectionTimeoutMS: 1500 });
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close();
			}
		});
		seedAgents(durable, (value) => {
			time = value;
		});
		for (const event of durable.recentEvents().reverse()) memory.record(event);
		await durable.flush();
		for (const filters of [{}, { caller: "agent:bot-1" }]) {
			const result = await durable.analytics({ ...query, ...filters });
			const expected = await memory.analytics({ ...query, ...filters });
			expect(result.source).toBe("mongodb");
			expect(result.byCaller).toEqual(expected.byCaller);
			expect(result.totals).toEqual(expected.totals);
		}
		const result = await durable.analytics(query);
		expect(result.byCaller.find((row) => row.id === "agent:bot-1")?.name).toBe(
			"Helper",
		);
	});

	it("reports web fetches the same way in MongoDB and memory", async () => {
		let time = from;
		const url = uniqueMongoUrl("web");
		const sink = new MongoTelemetrySink(url);
		const durable = new TelemetryService({
			sink,
			now: () => new Date(time),
			flushIntervalMs: 60_000,
		});
		const memory = new TelemetryService({ now: () => new Date(time) });
		cleanups.push(async () => {
			await durable.close();
			const client = new MongoClient(url, { serverSelectionTimeoutMS: 1500 });
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close();
			}
		});
		seedWeb(durable, (value) => {
			time = value;
		});
		seedSkippedAndLegacy(durable, (value) => {
			time = value;
		});
		for (const event of durable.recentEvents().reverse()) memory.record(event);
		await durable.flush();
		expect((await durable.analytics(query)).web.legacyFetches).toBe(1);
		for (const filters of [
			{},
			{ caller: "user:1" },
			{ caller: "agent:bot-1" },
		]) {
			const result = await durable.analytics({ ...query, ...filters });
			const expected = await memory.analytics({ ...query, ...filters });
			expect(result.source).toBe("mongodb");
			expect(result.web).toEqual(expected.web);
			expect(result.options.callers).toEqual(expected.options.callers);
		}
		expect((await durable.analytics(query)).web.totals.costUsd).toBe(0.75);
	});
});

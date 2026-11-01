import type { AnalyticsQuery } from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { ModelCatalogService } from "../src/model-catalog-service.js";
import { createServer } from "../src/server.js";
import { ClickHouseSink } from "../src/telemetry/clickhouse.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import {
	clickhouseAvailable,
	clickhouseQuery,
	clickhouseTestConfig,
	uniqueTable,
} from "./clickhouse-env.js";
import { startStubProvider } from "./helpers.js";

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

describe("usage analytics", () => {
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

	it("reports bounded history eviction and falls back when durable storage fails", async () => {
		let time = from;
		const sink = new ClickHouseSink({
			...clickhouseTestConfig("unreachable"),
			url: "http://127.0.0.1:9",
			requestTimeoutMs: 100,
		});
		const telemetry = new TelemetryService({
			maxAnalyticsEvents: 2,
			now: () => new Date(time),
			sink,
			flushIntervalMs: 60_000,
		});
		cleanups.push(() => telemetry.stop());
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
		const server = createServer({
			config: { providers: [], corsOrigins: [] },
			logger: false,
		});
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
		const server = createServer({
			registry: stub.registry,
			telemetry,
			config: { providers: [], corsOrigins: [], ownerToken: "owner-test" },
			logger: false,
		});
		cleanups.push(() => server.close(), stub.close);
		const issued = (
			await server.inject({
				method: "POST",
				url: "/v1/api-tokens",
				headers: { authorization: "Bearer owner-test" },
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
		const server = createServer({
			telemetry,
			modelCatalog,
			config: {
				corsOrigins: [],
				providers: [
					{ name: "work", kind: "openai", apiKey: "unused", models: ["paid"] },
				],
			},
			logger: false,
		});
		cleanups.push(() => server.close());
		const event = telemetry.recordChat({
			model: "work/paid",
			provider: "work",
			usage,
			latencyMs: 10,
		});
		expect(event.data.estimatedCostUsd).toBe(5);
	});
});

const available = await clickhouseAvailable();
describe.skipIf(!available)("durable analytics", () => {
	it("matches memory across grouped filters, old events, deduplication, and priced zero", async () => {
		let time = from;
		const config = clickhouseTestConfig(uniqueTable("analytics"));
		const sink = new ClickHouseSink(config);
		const durable = new TelemetryService({
			sink,
			now: () => new Date(time),
			flushIntervalMs: 60_000,
		});
		const memory = new TelemetryService({ now: () => new Date(time) });
		cleanups.push(
			() => durable.stop(),
			() =>
				clickhouseQuery(
					config,
					`DROP TABLE IF EXISTS ${config.database}.${config.table}`,
				),
		);
		seed(durable, (value) => {
			time = value;
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
			expect(result.source).toBe("clickhouse");
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
		const restarted = new TelemetryService({ sink });
		cleanups.unshift(() => restarted.stop());
		expect((await restarted.analytics(query)).totals.requests).toBe(5);
	});
});

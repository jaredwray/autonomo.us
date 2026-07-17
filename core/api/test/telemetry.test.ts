import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { ClickHouseSink } from "../src/telemetry/clickhouse.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { mockRegistry } from "./helpers.js";

const CH_CONFIG = {
	url: "http://clickhouse.test:8123",
	database: "autonomous",
	table: "telemetry_events",
	username: "autonomous",
	password: "autonomous",
	requestTimeoutMs: 3000,
};

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

describe("TelemetryService", () => {
	it("aggregates per-model usage and latency for successes and errors", () => {
		const telemetry = new TelemetryService();
		telemetry.recordChat({
			model: "mock/a",
			provider: "mock",
			usage,
			latencyMs: 100,
		});
		telemetry.recordChat({
			model: "mock/a",
			provider: "mock",
			usage,
			latencyMs: 300,
		});
		telemetry.recordChat({
			model: "mock/b",
			provider: "mock",
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			latencyMs: 50,
			error: "boom",
		});

		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(3);
		expect(summary.totalErrors).toBe(1);
		expect(summary.promptTokens).toBe(20);
		expect(summary.completionTokens).toBe(10);
		expect(summary.totalTokens).toBe(30);
		expect(summary.avgLatencyMs).toBe(200);
		expect(summary.source).toBe("memory");

		expect(summary.byModel).toHaveLength(2);
		expect(summary.byModel[0]).toEqual({
			model: "a",
			provider: "mock",
			requests: 2,
			errors: 0,
			promptTokens: 20,
			completionTokens: 10,
			totalTokens: 30,
			avgLatencyMs: 200,
		});
		expect(summary.byModel[1]).toMatchObject({
			model: "b",
			requests: 1,
			errors: 1,
			avgLatencyMs: 0,
		});
	});

	it("caps the recent event ring buffer", () => {
		const telemetry = new TelemetryService({ maxRecent: 3 });
		for (let i = 0; i < 5; i++) {
			telemetry.recordChat({
				model: `mock/m${i}`,
				provider: "mock",
				usage,
				latencyMs: 1,
			});
		}
		const events = telemetry.recentEvents();
		expect(events).toHaveLength(3);
		expect(events[0].data.model).toBe("mock/m4");
	});

	it("flushes batched events to the sink with schema bootstrap", async () => {
		const calls: Array<{ url: string; body?: string }> = [];
		const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
			calls.push({ url, body: init?.body });
			return { ok: true, status: 200, text: async () => "" };
		});
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		telemetry.recordChat({
			model: "mock/a",
			provider: "mock",
			usage,
			latencyMs: 100,
		});
		telemetry.recordChat({
			model: "mock/a",
			provider: "mock",
			usage,
			latencyMs: 120,
		});
		await telemetry.flush();

		expect(calls).toHaveLength(3);
		expect(calls[0].url).toContain("CREATE+DATABASE");
		expect(calls[1].url).toContain("CREATE+TABLE");
		expect(calls[2].url).toContain("INSERT+INTO");
		const rows = (calls[2].body ?? "")
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			type: "gateway.chat",
			model: "mock/a",
			provider: "mock",
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
			latency_ms: 100,
		});

		// Second flush with nothing pending does not hit the sink again.
		await telemetry.flush();
		expect(calls).toHaveLength(3);
		await telemetry.stop();
	});

	it("folds distinct models beyond maxModels into an overflow bucket", () => {
		const telemetry = new TelemetryService({ maxModels: 2 });
		for (const model of ["mock/a", "mock/b", "mock/c", "mock/d"]) {
			telemetry.recordChat({ model, provider: "mock", usage, latencyMs: 10 });
		}
		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(4);
		expect(summary.byModel).toHaveLength(3);
		const other = summary.byModel.find((m) => m.model === "(other)");
		expect(other).toMatchObject({ requests: 2, provider: "other" });
	});

	it("keeps events queued when the sink fails and recovers later", async () => {
		let fail = true;
		const inserts: string[] = [];
		const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
			if (fail) throw new Error("connection refused");
			if (url.includes("INSERT")) inserts.push(init?.body ?? "");
			return { ok: true, status: 200, text: async () => "" };
		});
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		telemetry.recordChat({
			model: "mock/a",
			provider: "mock",
			usage,
			latencyMs: 100,
		});
		await telemetry.flush();
		expect(telemetry.summary().totalRequests).toBe(1);

		fail = false;
		await telemetry.flush();
		expect(inserts).toHaveLength(1);
		expect(inserts[0]).toContain("gateway.chat");
		await telemetry.stop();
	});

	it("bootstraps the schema before querying an empty sink", async () => {
		const calls: string[] = [];
		const fetchImpl = vi.fn(async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				text: async () =>
					url.includes("SELECT") ? JSON.stringify({ data: [] }) : "",
			};
		});
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		// No events recorded — the query path must still create the schema.
		const summary = await telemetry.summaryFromSink();
		expect(summary?.source).toBe("clickhouse");
		expect(calls).toHaveLength(3);
		expect(calls[0]).toContain("CREATE+DATABASE");
		expect(calls[1]).toContain("CREATE+TABLE");
		expect(calls[2]).toContain("SELECT");
		await telemetry.stop();
	});

	it("falls back to memory when pending events cannot be flushed", async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("INSERT")) {
				throw new Error("insert denied");
			}
			return {
				ok: true,
				status: 200,
				text: async () =>
					url.includes("SELECT") ? JSON.stringify({ data: [] }) : "",
			};
		});
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		telemetry.recordChat({
			model: "mock/a",
			provider: "mock",
			usage,
			latencyMs: 100,
		});

		// Insert fails, so the sink summary would under-report — refuse it
		// even though the SELECT itself would succeed.
		expect(await telemetry.summaryFromSink()).toBeUndefined();
		await telemetry.stop();
	});
});

describe("telemetry routes", () => {
	it("serves the memory summary and recent events", async () => {
		const telemetry = new TelemetryService();
		const server = createServer({
			registry: mockRegistry(),
			telemetry,
			logger: false,
		});

		await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "mock/chat-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		const summaryResponse = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary",
		});
		expect(summaryResponse.statusCode).toBe(200);
		const summary = JSON.parse(summaryResponse.body);
		expect(summary.totalRequests).toBe(1);
		expect(summary.source).toBe("memory");

		const memoryResponse = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary?source=memory",
		});
		expect(JSON.parse(memoryResponse.body).source).toBe("memory");

		const clickhouseResponse = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary?source=clickhouse",
		});
		expect(clickhouseResponse.statusCode).toBe(503);

		const eventsResponse = await server.inject({
			method: "GET",
			url: "/v1/telemetry/events?limit=10",
		});
		expect(eventsResponse.statusCode).toBe(200);
		const events = JSON.parse(eventsResponse.body);
		expect(events.events).toHaveLength(1);
		expect(events.sink).toEqual({ configured: false, healthy: false });

		await server.close();
	});

	it("prefers clickhouse for auto summaries when the sink works", async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("SELECT")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							data: [
								{
									model: "chat-model",
									provider: "mock",
									requests: 7,
									errors: 1,
									prompt_tokens: 70,
									completion_tokens: 35,
									total_tokens: 105,
									avg_latency_ms: 88,
								},
							],
						}),
				};
			}
			return { ok: true, status: 200, text: async () => "" };
		});
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });
		const server = createServer({
			registry: mockRegistry(),
			telemetry,
			logger: false,
		});

		const response = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary",
		});
		expect(response.statusCode).toBe(200);
		const summary = JSON.parse(response.body);
		expect(summary.source).toBe("clickhouse");
		expect(summary.totalRequests).toBe(7);
		expect(summary.totalErrors).toBe(1);
		expect(summary.totalTokens).toBe(105);
		expect(summary.byModel[0].model).toBe("chat-model");

		await server.close();
	});
});

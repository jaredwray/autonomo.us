import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { ClickHouseSink } from "../src/telemetry/clickhouse.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import {
	clickhouseAvailable,
	clickhouseQuery,
	clickhouseTestConfig,
	uniqueTable,
} from "./clickhouse-env.js";
import { type StubProvider, startStubProvider } from "./helpers.js";

// Full telemetry pipeline against a real ClickHouse server (and the real
// OpenAI-compatible stub provider for the end-to-end route test).
const available = await clickhouseAvailable();
if (!available) {
	console.warn(
		"[telemetry.integration] no ClickHouse at CLICKHOUSE_URL — skipping. Start it with: docker compose up -d clickhouse",
	);
}

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

describe.skipIf(!available)("TelemetryService + real ClickHouse", () => {
	const cleanups: Array<() => Promise<unknown>> = [];

	afterAll(async () => {
		for (const cleanup of cleanups) {
			await cleanup().catch(() => {});
		}
	});

	function trackedSink(prefix: string) {
		const config = clickhouseTestConfig(uniqueTable(prefix));
		cleanups.push(() =>
			clickhouseQuery(
				config,
				`DROP TABLE IF EXISTS ${config.database}.${config.table}`,
			),
		);
		return new ClickHouseSink(config);
	}

	it("flushes recorded chats into ClickHouse and reads them back", async () => {
		const sink = trackedSink("flush");
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		telemetry.recordChat({
			model: "stub/chat-model",
			provider: "stub",
			usage,
			latencyMs: 100,
		});
		telemetry.recordChat({
			model: "stub/chat-model",
			provider: "stub",
			usage,
			latencyMs: 200,
		});

		expect(await telemetry.flush()).toBe(true);

		const summary = await telemetry.summaryFromSink();
		expect(summary?.source).toBe("clickhouse");
		expect(summary?.totalRequests).toBe(2);
		expect(summary?.totalTokens).toBe(30);
		expect(summary?.avgLatencyMs).toBe(150);
		expect(summary?.byModel[0]).toMatchObject({
			model: "chat-model",
			provider: "stub",
		});
		expect(telemetry.sinkHealthy).toBe(true);
		await telemetry.stop();
	});

	it("bootstraps the schema before querying an empty sink", async () => {
		const sink = trackedSink("fresh");
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		// No traffic yet — the query path must still create the table.
		const summary = await telemetry.summaryFromSink();
		expect(summary?.source).toBe("clickhouse");
		expect(summary?.totalRequests).toBe(0);
		expect(summary?.byModel).toEqual([]);
		await telemetry.stop();
	});
});

describe.skipIf(!available)("gateway → ClickHouse end to end", () => {
	let provider: StubProvider;

	beforeAll(async () => {
		provider = await startStubProvider();
	});

	afterAll(async () => {
		await provider.close();
	});

	it("serves ClickHouse-backed summaries for real chat traffic", async () => {
		const config = clickhouseTestConfig(uniqueTable("e2e"));
		const sink = new ClickHouseSink(config);
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });
		const server = createServer({
			registry: provider.registry,
			telemetry,
			logger: false,
		});

		const chat = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});
		expect(chat.statusCode).toBe(200);

		// Auto source flushes pending events and prefers the durable store.
		const response = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary",
		});
		expect(response.statusCode).toBe(200);
		const summary = JSON.parse(response.body);
		expect(summary.source).toBe("clickhouse");
		expect(summary.totalRequests).toBe(1);
		expect(summary.totalTokens).toBe(15);
		expect(summary.byModel[0]).toMatchObject({
			model: "chat-model",
			provider: "stub",
		});

		const events = await server.inject({
			method: "GET",
			url: "/v1/telemetry/events?limit=5",
		});
		expect(JSON.parse(events.body).sink).toEqual({
			configured: true,
			healthy: true,
		});

		await server.close();
		await clickhouseQuery(
			config,
			`DROP TABLE IF EXISTS ${config.database}.${config.table}`,
		).catch(() => {});
	});
});

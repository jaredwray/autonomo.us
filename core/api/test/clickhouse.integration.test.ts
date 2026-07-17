import type { TelemetryEvent } from "@autonomo.us/common";
import { afterAll, describe, expect, it } from "vitest";
import { ClickHouseSink } from "../src/telemetry/clickhouse.js";
import {
	clickhouseAvailable,
	clickhouseQuery,
	clickhouseTestConfig,
	uniqueTable,
} from "./clickhouse-env.js";

// Runs against a real ClickHouse server — the CI service container or
// `docker compose up clickhouse` locally. Skipped (loudly) when absent.
const available = await clickhouseAvailable();
if (!available) {
	console.warn(
		"[clickhouse.integration] no ClickHouse at CLICKHOUSE_URL — skipping. Start it with: docker compose up -d clickhouse",
	);
}

function chatEvent(
	id: string,
	overrides: Partial<{
		type: string;
		model: string;
		provider: string;
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		latencyMs: number;
		error: string;
		timestamp: string;
	}> = {},
): TelemetryEvent {
	const {
		type = "gateway.chat",
		timestamp = new Date().toISOString(),
		...data
	} = overrides;
	return {
		id,
		type,
		data: {
			model: "stub/chat-model",
			provider: "stub",
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			latencyMs: 100,
			...data,
		},
		timestamp,
	};
}

describe.skipIf(!available)("ClickHouseSink (real server)", () => {
	const cleanups: Array<() => Promise<unknown>> = [];

	afterAll(async () => {
		for (const cleanup of cleanups) {
			await cleanup().catch(() => {});
		}
	});

	function sinkWithTable(prefix: string) {
		const config = clickhouseTestConfig(uniqueTable(prefix));
		const sink = new ClickHouseSink(config);
		cleanups.push(() =>
			clickhouseQuery(
				config,
				`DROP TABLE IF EXISTS ${config.database}.${config.table}`,
			),
		);
		return { config, sink };
	}

	it("creates the schema, inserts events, and aggregates summaries", async () => {
		const { sink } = sinkWithTable("summary");
		await sink.ensureSchema();
		await sink.insert([
			chatEvent("evt-1", {
				model: "stub/chat-model",
				latencyMs: 100,
			}),
			chatEvent("evt-2", {
				model: "stub/chat-model",
				latencyMs: 200,
			}),
			chatEvent("evt-3", {
				type: "gateway.error",
				model: "stub/broken-model",
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				latencyMs: 50,
				error: "provider exploded",
			}),
		]);

		const summary = await sink.querySummary();
		expect(summary.source).toBe("clickhouse");
		// Error events are counted — totals match the in-memory aggregates.
		expect(summary.totalRequests).toBe(3);
		expect(summary.totalErrors).toBe(1);
		expect(summary.promptTokens).toBe(20);
		expect(summary.completionTokens).toBe(10);
		expect(summary.totalTokens).toBe(30);
		expect(summary.avgLatencyMs).toBe(150);

		const models = Object.fromEntries(
			summary.byModel.map((usage) => [usage.model, usage]),
		);
		// Canonical ids are normalized back to bare model names.
		expect(models["chat-model"]).toMatchObject({
			provider: "stub",
			requests: 2,
			errors: 0,
			totalTokens: 30,
		});
		expect(models["broken-model"]).toMatchObject({
			requests: 1,
			errors: 1,
		});
		expect(sink.healthy).toBe(true);
	});

	it("deduplicates re-inserted batches via ReplacingMergeTree + FINAL", async () => {
		const { sink } = sinkWithTable("dedup");
		await sink.ensureSchema();
		const timestamp = new Date().toISOString();
		const batch = [
			chatEvent("evt-dup-1", { timestamp }),
			chatEvent("evt-dup-2", { timestamp }),
		];

		// An insert whose response was lost gets retried with the same rows.
		await sink.insert(batch);
		await sink.insert(batch);

		const summary = await sink.querySummary();
		expect(summary.totalRequests).toBe(2);
		expect(summary.totalTokens).toBe(30);
	});

	it("marks itself unhealthy on auth failures and recovers", async () => {
		const { config, sink } = sinkWithTable("auth");
		await sink.ensureSchema();
		expect(sink.healthy).toBe(true);

		const badAuth = new ClickHouseSink({
			...config,
			password: "definitely-wrong-password",
		});
		await expect(badAuth.insert([chatEvent("evt-auth")])).rejects.toThrow(
			/ClickHouse request failed/,
		);
		expect(badAuth.healthy).toBe(false);

		await sink.insert([chatEvent("evt-auth-ok")]);
		expect(sink.healthy).toBe(true);
	});

	it("times out against an unreachable server without hanging", async () => {
		const dead = new ClickHouseSink({
			...clickhouseTestConfig("dead"),
			url: "http://127.0.0.1:9",
			requestTimeoutMs: 500,
		});
		const started = performance.now();
		await expect(dead.insert([chatEvent("evt-dead")])).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(4000);
		expect(dead.healthy).toBe(false);
	});
});

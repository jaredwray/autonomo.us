import { describe, expect, it, vi } from "vitest";
import {
	ClickHouseSink,
	eventToRow,
	stripProviderPrefix,
	toClickHouseDateTime,
} from "../src/telemetry/clickhouse.js";

const CH_CONFIG = {
	url: "http://clickhouse.test:8123",
	database: "autonomous",
	table: "telemetry_events",
	username: "user-1",
	password: "secret-1",
	requestTimeoutMs: 3000,
};

describe("toClickHouseDateTime", () => {
	it("converts ISO timestamps to DateTime64 input format", () => {
		expect(toClickHouseDateTime("2026-07-17T12:34:56.789Z")).toBe(
			"2026-07-17 12:34:56.789",
		);
	});
});

describe("stripProviderPrefix", () => {
	it("strips only the exact provider prefix", () => {
		expect(stripProviderPrefix("anthropic/claude-opus-4-8", "anthropic")).toBe(
			"claude-opus-4-8",
		);
		expect(stripProviderPrefix("local/meta-llama/Llama-3.3-70B", "local")).toBe(
			"meta-llama/Llama-3.3-70B",
		);
		expect(stripProviderPrefix("claude-opus-4-8", "anthropic")).toBe(
			"claude-opus-4-8",
		);
		expect(stripProviderPrefix("localhost/model", "local")).toBe(
			"localhost/model",
		);
	});
});

describe("eventToRow", () => {
	it("flattens gateway events into columns", () => {
		const row = eventToRow({
			id: "evt-1",
			type: "gateway.chat",
			agentId: "agent-1",
			data: {
				model: "anthropic/claude-opus-4-8",
				provider: "anthropic",
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				latencyMs: 123,
			},
			timestamp: "2026-07-17T12:00:00.000Z",
		});

		expect(row).toEqual({
			id: "evt-1",
			type: "gateway.chat",
			agent_id: "agent-1",
			model: "anthropic/claude-opus-4-8",
			provider: "anthropic",
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
			latency_ms: 123,
			error: "",
			data: JSON.stringify({
				model: "anthropic/claude-opus-4-8",
				provider: "anthropic",
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				latencyMs: 123,
			}),
			timestamp: "2026-07-17 12:00:00.000",
		});
	});

	it("defaults missing fields safely", () => {
		const row = eventToRow({
			id: "evt-2",
			type: "custom",
			data: { note: "hello" },
			timestamp: "2026-07-17T12:00:00.000Z",
		});
		expect(row.agent_id).toBe("");
		expect(row.model).toBe("");
		expect(row.prompt_tokens).toBe(0);
		expect(row.error).toBe("");
	});
});

describe("ClickHouseSink", () => {
	it("sends inserts as JSONEachRow with auth headers", async () => {
		const fetchImpl = vi.fn(
			async (
				_url: string,
				_init?: { headers?: Record<string, string>; body?: string },
			) => ({ ok: true, status: 200, text: async () => "" }),
		);
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);

		await sink.insert([
			{
				id: "evt-1",
				type: "gateway.chat",
				data: { model: "m", provider: "p", promptTokens: 1 },
				timestamp: "2026-07-17T12:00:00.000Z",
			},
		]);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toContain(
			"INSERT+INTO+autonomous.telemetry_events+FORMAT+JSONEachRow",
		);
		expect(url).toContain("output_format_json_quote_64bit_integers=0");
		expect(init?.headers).toMatchObject({
			"X-ClickHouse-User": "user-1",
			"X-ClickHouse-Key": "secret-1",
		});
		expect(init?.body).toContain('"model":"m"');
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(sink.healthy).toBe(true);
	});

	it("creates a deduplicating table and queries it with FINAL", async () => {
		const calls: string[] = [];
		const fetchImpl = vi.fn(async (url: string) => {
			calls.push(decodeURIComponent(url.replace(/\+/g, " ")));
			return {
				ok: true,
				status: 200,
				text: async () =>
					url.includes("SELECT") ? JSON.stringify({ data: [] }) : "",
			};
		});
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);

		await sink.ensureSchema();
		await sink.querySummary();

		expect(calls[1]).toContain("ReplacingMergeTree ORDER BY (timestamp, id)");
		expect(calls[2]).toContain("FROM autonomous.telemetry_events FINAL");
		expect(calls[2]).toContain("IN ('gateway.chat', 'gateway.error')");
	});

	it("marks itself unhealthy on failed requests", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 500,
			text: async () => "boom",
		}));
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);

		await expect(
			sink.insert([
				{
					id: "evt-1",
					type: "gateway.chat",
					data: {},
					timestamp: "2026-07-17T12:00:00.000Z",
				},
			]),
		).rejects.toThrow("ClickHouse request failed (500)");
		expect(sink.healthy).toBe(false);
	});

	it("skips empty inserts", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => "",
		}));
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);
		await sink.insert([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("parses summary aggregates from FORMAT JSON responses", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					data: [
						{
							model: "anthropic/claude-opus-4-8",
							provider: "anthropic",
							requests: 4,
							errors: 1,
							prompt_tokens: 40,
							completion_tokens: 20,
							total_tokens: 60,
							avg_latency_ms: 150,
						},
						{
							model: "llama3.3",
							provider: "local",
							requests: 2,
							errors: 0,
							prompt_tokens: 10,
							completion_tokens: 10,
							total_tokens: 20,
							avg_latency_ms: 50,
						},
					],
				}),
		}));
		const sink = new ClickHouseSink(CH_CONFIG, fetchImpl);

		const summary = await sink.querySummary();
		expect(summary.source).toBe("clickhouse");
		expect(summary.totalRequests).toBe(6);
		expect(summary.totalErrors).toBe(1);
		expect(summary.totalTokens).toBe(80);
		// Weighted mean over successful requests: (150*3 + 50*2) / 5 = 110.
		expect(summary.avgLatencyMs).toBe(110);
		expect(summary.byModel).toHaveLength(2);
		// Canonical ids are normalized to match the in-memory summary shape.
		expect(summary.byModel[0].model).toBe("claude-opus-4-8");
	});
});

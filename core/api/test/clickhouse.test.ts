import { describe, expect, it } from "vitest";
import {
	eventToRow,
	stripProviderPrefix,
	toClickHouseDateTime,
} from "../src/telemetry/clickhouse.js";

// Pure row/format helpers. Sink behavior against a real ClickHouse server
// lives in clickhouse.integration.test.ts.

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

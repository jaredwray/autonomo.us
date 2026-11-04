import { describe, expect, it } from "vitest";
import {
	eventToDocument,
	stripProviderPrefix,
} from "../src/telemetry/mongo.js";

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

describe("eventToDocument", () => {
	it("flattens gateway events into a telemetry document", () => {
		const document = eventToDocument({
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

		expect(document).toEqual({
			_id: "evt-1",
			type: "gateway.chat",
			agentId: "agent-1",
			model: "anthropic/claude-opus-4-8",
			provider: "anthropic",
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			latencyMs: 123,
			error: "",
			timestamp: new Date("2026-07-17T12:00:00.000Z"),
		});
	});

	it("keeps priced calls and omits failed or unknown prices", () => {
		const priced = eventToDocument({
			id: "evt-priced",
			type: "gateway.chat",
			data: {
				model: "work/paid",
				provider: "work",
				operation: "chat",
				callerId: "api-token:1",
				callerName: "Product team",
				callerKind: "api-token",
				estimatedCostUsd: 0,
				promptTokens: 1,
				completionTokens: 0,
				totalTokens: 1,
				latencyMs: 10,
			},
			timestamp: "2026-11-01T01:00:00.000Z",
		});
		expect(priced).toMatchObject({
			operation: "chat",
			callerId: "api-token:1",
			callerName: "Product team",
			callerKind: "api-token",
			estimatedCostUsd: 0,
		});
		const failed = eventToDocument({
			id: "evt-failed",
			type: "gateway.error",
			data: {
				model: "work/paid",
				provider: "work",
				error: "failed",
			},
			timestamp: "2026-11-01T01:00:00.000Z",
		});
		expect(failed).not.toHaveProperty("estimatedCostUsd");
		expect(failed).not.toHaveProperty("callerId");
		expect(failed.error).toBe("failed");
	});

	it("defaults missing fields safely", () => {
		const document = eventToDocument({
			id: "evt-2",
			type: "custom",
			data: { note: "hello" },
			timestamp: "2026-07-17T12:00:00.000Z",
		});
		expect(document.agentId).toBe("");
		expect(document.model).toBe("");
		expect(document.promptTokens).toBe(0);
		expect(document.error).toBe("");
	});
});

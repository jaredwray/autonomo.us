import { describe, expect, it } from "vitest";
import type {
	AgentConfig,
	FailoverPolicy,
	GatewayRequest,
	GatewayResponse,
	ModelInfo,
	UsageSummary,
} from "../src/index.js";

describe("common types", () => {
	it("should create a valid AgentConfig", () => {
		const config: AgentConfig = {
			id: "agent-1",
			name: "Test Agent",
			model: "anthropic/claude-opus-4-8",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		expect(config.id).toBe("agent-1");
		expect(config.name).toBe("Test Agent");
	});

	it("should create a valid GatewayRequest routed by model", () => {
		const request: GatewayRequest = {
			model: "anthropic/claude-opus-4-8",
			messages: [{ role: "user", content: "Hello" }],
			temperature: 0.2,
			maxTokens: 256,
		};
		expect(request.model).toBe("anthropic/claude-opus-4-8");
		expect(request.messages).toHaveLength(1);
	});

	it("should create a valid GatewayRequest routed by agent", () => {
		const request: GatewayRequest = {
			agentId: "agent-1",
			messages: [{ role: "user", content: "Hello" }],
		};
		expect(request.agentId).toBe("agent-1");
	});

	it("should create a valid GatewayResponse", () => {
		const response: GatewayResponse = {
			id: "resp-1",
			model: "anthropic/claude-opus-4-8",
			message: { role: "assistant", content: "Hi there!" },
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			finishReason: "stop",
			createdAt: new Date().toISOString(),
		};
		expect(response.usage.totalTokens).toBe(15);
		expect(response.model).toBe("anthropic/claude-opus-4-8");
	});

	it("should create a valid GatewayResponse served by a failover target", () => {
		const response: GatewayResponse = {
			id: "resp-2",
			model: "local/llama3.3",
			message: { role: "assistant", content: "Hi there!" },
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			createdAt: new Date().toISOString(),
			failover: {
				requestedModel: "anthropic/claude-opus-4-8",
				attempts: [
					{
						model: "anthropic/claude-opus-4-8",
						error: "timed out after 30000ms",
					},
				],
			},
		};
		expect(response.failover?.requestedModel).toBe("anthropic/claude-opus-4-8");
		expect(response.failover?.attempts).toHaveLength(1);
	});

	it("should create a valid FailoverPolicy", () => {
		const policy: FailoverPolicy = {
			enabled: true,
			targets: ["anthropic/claude-sonnet-5", "local/llama3.3"],
			timeoutMs: 30000,
		};
		expect(policy.enabled).toBe(true);
		expect(policy.targets).toHaveLength(2);
	});

	it("should create a valid ModelInfo", () => {
		const info: ModelInfo = {
			id: "local/llama3.3",
			provider: "local",
			model: "llama3.3",
		};
		expect(info.id).toBe("local/llama3.3");
	});

	it("should create a valid UsageSummary", () => {
		const summary: UsageSummary = {
			totalRequests: 2,
			totalErrors: 0,
			promptTokens: 20,
			completionTokens: 10,
			totalTokens: 30,
			avgLatencyMs: 120,
			byModel: [
				{
					model: "claude-opus-4-8",
					provider: "anthropic",
					requests: 2,
					errors: 0,
					promptTokens: 20,
					completionTokens: 10,
					totalTokens: 30,
					avgLatencyMs: 120,
				},
			],
			source: "memory",
		};
		expect(summary.byModel).toHaveLength(1);
		expect(summary.source).toBe("memory");
	});
});

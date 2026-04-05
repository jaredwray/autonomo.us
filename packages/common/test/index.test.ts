import { describe, expect, it } from "vitest";
import type {
	AgentConfig,
	GatewayRequest,
	GatewayResponse,
} from "../src/index.js";

describe("common types", () => {
	it("should create a valid AgentConfig", () => {
		const config: AgentConfig = {
			id: "agent-1",
			name: "Test Agent",
			model: "gpt-4",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		expect(config.id).toBe("agent-1");
		expect(config.name).toBe("Test Agent");
	});

	it("should create a valid GatewayRequest", () => {
		const request: GatewayRequest = {
			agentId: "agent-1",
			messages: [{ role: "user", content: "Hello" }],
		};
		expect(request.agentId).toBe("agent-1");
		expect(request.messages).toHaveLength(1);
	});

	it("should create a valid GatewayResponse", () => {
		const response: GatewayResponse = {
			id: "resp-1",
			agentId: "agent-1",
			message: { role: "assistant", content: "Hi there!" },
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			createdAt: new Date().toISOString(),
		};
		expect(response.usage.totalTokens).toBe(15);
	});
});

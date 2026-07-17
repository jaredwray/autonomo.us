import type { LanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { ProviderRegistry } from "../src/providers/registry.js";

export const mockUsage = {
	inputTokens: {
		total: 10,
		noCache: 10,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export function mockModel(text = "Hello there"): LanguageModel {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: { unified: "stop" as const, raw: "stop" },
			usage: mockUsage,
			warnings: [],
		}),
		doStream: async () => ({
			stream: convertArrayToReadableStream([
				{ type: "stream-start" as const, warnings: [] },
				{ type: "text-start" as const, id: "1" },
				{ type: "text-delta" as const, id: "1", delta: "Hello " },
				{ type: "text-delta" as const, id: "1", delta: "world" },
				{ type: "text-end" as const, id: "1" },
				{
					type: "finish" as const,
					finishReason: { unified: "stop" as const, raw: "stop" },
					usage: mockUsage,
				},
			]),
		}),
	});
}

export function failingModel(message = "provider exploded"): LanguageModel {
	return new MockLanguageModelV4({
		doGenerate: async () => {
			throw new Error(message);
		},
		doStream: async () => {
			throw new Error(message);
		},
	});
}

export function mockRegistry(): ProviderRegistry {
	const registry = new ProviderRegistry();
	registry.register({
		name: "mock",
		kind: "mock",
		models: ["chat-model"],
		languageModel: (modelId) =>
			modelId === "broken-model" ? failingModel() : mockModel(),
	});
	return registry;
}

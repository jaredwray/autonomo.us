import {
	ProviderRegistry,
	providerFromConfig,
} from "../src/providers/registry.js";
import { type OpenAIStub, startOpenAIStub } from "./openai-stub.js";

export type StubProvider = {
	registry: ProviderRegistry;
	stub: OpenAIStub;
	close(): Promise<void>;
};

/**
 * Starts the real OpenAI-compatible stub server and returns a registry with a
 * `stub` provider routed to it through the production provider factory.
 */
export async function startStubProvider(): Promise<StubProvider> {
	const stub = await startOpenAIStub();
	const registry = new ProviderRegistry();
	registry.register(
		providerFromConfig({
			kind: "openai-compatible",
			name: "stub",
			baseURL: stub.url,
			models: ["chat-model"],
		}),
	);
	return { registry, stub, close: stub.close };
}

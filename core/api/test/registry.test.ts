import { describe, expect, it } from "vitest";
import { configFromEnv, DEFAULT_ANTHROPIC_MODELS } from "../src/config.js";
import {
	ProviderRegistry,
	registryFromConfig,
	UnknownProviderError,
} from "../src/providers/registry.js";
import { mockModel } from "./helpers.js";

function registryWith(names: string[]): ProviderRegistry {
	const registry = new ProviderRegistry();
	for (const name of names) {
		registry.register({
			name,
			kind: "mock",
			models: [`${name}-model`],
			languageModel: () => mockModel(),
		});
	}
	return registry;
}

describe("ProviderRegistry", () => {
	it("resolves provider/model ids on the first slash", () => {
		const registry = registryWith(["local"]);
		const resolved = registry.resolve("local/meta-llama/Llama-3.3-70B");
		expect(resolved.provider.name).toBe("local");
		expect(resolved.modelId).toBe("meta-llama/Llama-3.3-70B");
		expect(resolved.id).toBe("local/meta-llama/Llama-3.3-70B");
	});

	it("resolves bare model ids when a single provider is registered", () => {
		const registry = registryWith(["only"]);
		const resolved = registry.resolve("some-model");
		expect(resolved.provider.name).toBe("only");
		expect(resolved.modelId).toBe("some-model");
	});

	it("rejects bare model ids when multiple providers are registered", () => {
		const registry = registryWith(["a", "b"]);
		expect(() => registry.resolve("some-model")).toThrow(UnknownProviderError);
	});

	it("rejects unknown providers and empty model ids", () => {
		const registry = registryWith(["local"]);
		expect(() => registry.resolve("nope/model")).toThrow(UnknownProviderError);
		expect(() => registry.resolve("local/")).toThrow(UnknownProviderError);
	});

	it("lists routable models across providers", () => {
		const registry = registryWith(["a", "b"]);
		expect(registry.listModels()).toEqual([
			{ id: "a/a-model", provider: "a", model: "a-model" },
			{ id: "b/b-model", provider: "b", model: "b-model" },
		]);
	});
});

describe("configFromEnv + registryFromConfig", () => {
	it("registers anthropic and openai-compatible providers from env", () => {
		const config = configFromEnv({
			ANTHROPIC_API_KEY: "test-key",
			OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
			OPENAI_COMPAT_NAME: "ollama",
			OPENAI_COMPAT_MODELS: "llama3.3, qwen3",
		});
		expect(config.providers).toHaveLength(2);

		const registry = registryFromConfig(config);
		expect(registry.listProviders()).toEqual([
			{ name: "anthropic", kind: "anthropic" },
			{ name: "ollama", kind: "openai-compatible" },
		]);
		const ids = registry.listModels().map((m) => m.id);
		expect(ids).toContain("anthropic/claude-opus-4-8");
		expect(ids).toContain("ollama/llama3.3");
		expect(ids).toContain("ollama/qwen3");

		const resolved = registry.resolve("anthropic/claude-opus-4-8");
		expect(resolved.modelId).toBe("claude-opus-4-8");
	});

	it("defaults to the claude model catalog", () => {
		const config = configFromEnv({ ANTHROPIC_API_KEY: "k" });
		expect(config.providers[0]).toMatchObject({
			kind: "anthropic",
			models: DEFAULT_ANTHROPIC_MODELS,
		});
	});

	it("registers no providers and no sink for an empty env", () => {
		const config = configFromEnv({});
		expect(config.providers).toEqual([]);
		expect(config.clickhouse).toBeUndefined();
	});

	it("configures clickhouse from env with docker-compose defaults", () => {
		const config = configFromEnv({ CLICKHOUSE_URL: "http://localhost:8123" });
		expect(config.clickhouse).toEqual({
			url: "http://localhost:8123",
			database: "autonomous",
			table: "telemetry_events",
			username: "autonomous",
			password: "autonomous",
			requestTimeoutMs: 3000,
		});
	});

	it("parses cors origins from env with a dev-origin default", () => {
		expect(configFromEnv({}).corsOrigins).toEqual([
			"http://localhost:5173",
			"http://127.0.0.1:5173",
		]);
		expect(
			configFromEnv({ CORS_ORIGIN: "https://app.example.com, https://b.dev" })
				.corsOrigins,
		).toEqual(["https://app.example.com", "https://b.dev"]);
		expect(configFromEnv({ CORS_ORIGIN: "*" }).corsOrigins).toEqual(["*"]);
	});
});

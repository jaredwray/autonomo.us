import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
	buildModelCatalog,
	compareCatalogModels,
	diffCatalogs,
	normalizeModels,
	PROVIDERS,
	toReleaseDate,
} from "../scripts/update-models.js";
import { type ModelCatalog, modelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { modelsRoutes } from "../src/routes/models.js";
import { createServer } from "../src/server.js";

type RecordedCall = { url: URL; headers: Record<string, string> };

/**
 * In-memory fetch: the handler returns a JSON body (or throws) per URL, and
 * every call is recorded so tests can assert on endpoints and headers.
 */
function fakeFetch(
	handler: (url: URL, headers: Record<string, string>) => unknown,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (
		input: string | URL,
		init?: { headers?: Record<string, string> },
	) => {
		const url = new URL(String(input));
		const headers = init?.headers ?? {};
		calls.push({ url, headers });
		return new Response(JSON.stringify(handler(url, headers)), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function specs(...keys: string[]) {
	return PROVIDERS.filter((provider) => keys.includes(provider.key));
}

const MODELS_DEV_FIXTURE = {
	anthropic: {
		name: "Anthropic",
		models: {
			"claude-sonnet-5": {
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5",
				release_date: "2026-06-29",
			},
			"claude-haiku-4-5": {
				id: "claude-haiku-4-5",
				name: "Claude Haiku 4.5",
				release_date: "2025-10-15",
			},
		},
	},
	openai: {
		name: "OpenAI",
		models: {
			"gpt-5.2": { id: "gpt-5.2", name: "GPT-5.2", release_date: "2025-12-11" },
		},
	},
};

describe("toReleaseDate", () => {
	it("converts epoch seconds and ISO strings to YYYY-MM-DD", () => {
		expect(toReleaseDate(1735689600)).toBe("2025-01-01");
		expect(toReleaseDate("2026-06-29")).toBe("2026-06-29");
		expect(toReleaseDate("2026-02-05T12:30:00Z")).toBe("2026-02-05");
	});

	it("rejects values that are not dates", () => {
		expect(toReleaseDate(undefined)).toBeUndefined();
		expect(toReleaseDate(0)).toBeUndefined();
		expect(toReleaseDate("soon")).toBeUndefined();
		expect(toReleaseDate({})).toBeUndefined();
	});
});

describe("normalizeModels", () => {
	it("sorts newest first, undated last, and dedupes by id", () => {
		const models = normalizeModels([
			{ id: "undated-b" },
			{ id: "old", released: "2024-03-13" },
			{ id: "new", name: "Newest", released: "2026-06-29" },
			{ id: "undated-a" },
			{ id: "new", name: "Duplicate", released: "2020-01-01" },
			{ id: "  " },
			{ id: 42 },
		]);
		expect(models.map((model) => model.id)).toEqual([
			"new",
			"old",
			"undated-a",
			"undated-b",
		]);
		// First occurrence wins and missing names fall back to the id.
		expect(models[0].name).toBe("Newest");
		expect(models[2]).toEqual({ id: "undated-a", name: "undated-a" });
	});

	it("orders same-day releases by id", () => {
		const a = { id: "a", name: "a", released: "2026-01-01" };
		const b = { id: "b", name: "b", released: "2026-01-01" };
		expect(compareCatalogModels(a, b)).toBeLessThan(0);
		expect(compareCatalogModels(b, a)).toBeGreaterThan(0);
	});
});

describe("buildModelCatalog", () => {
	it("pages through the Anthropic models API when a key is set", async () => {
		const { fetchImpl, calls } = fakeFetch((url) => {
			expect(url.host).toBe("api.anthropic.com");
			if (!url.searchParams.get("after_id")) {
				return {
					data: [
						{
							id: "claude-opus-4-8",
							display_name: "Claude Opus 4.8",
							created_at: "2026-02-05T00:00:00Z",
						},
					],
					has_more: true,
					last_id: "claude-opus-4-8",
				};
			}
			return {
				data: [
					{
						id: "claude-3-haiku",
						display_name: "Claude 3 Haiku",
						created_at: "2024-03-13T00:00:00Z",
					},
				],
				has_more: false,
			};
		});

		const { catalog, changed } = await buildModelCatalog({
			env: { ANTHROPIC_API_KEY: "test-key" },
			fetchImpl,
			providers: specs("anthropic"),
		});

		expect(changed).toBe(true);
		expect(catalog.providers.anthropic).toEqual({
			name: "Anthropic",
			source: "api",
			models: [
				{
					id: "claude-opus-4-8",
					name: "Claude Opus 4.8",
					released: "2026-02-05",
				},
				{
					id: "claude-3-haiku",
					name: "Claude 3 Haiku",
					released: "2024-03-13",
				},
			],
		});
		expect(calls).toHaveLength(2);
		expect(calls[0].headers["x-api-key"]).toBe("test-key");
		expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
		expect(calls[1].url.searchParams.get("after_id")).toBe("claude-opus-4-8");
	});

	it("maps OpenAI-style endpoints, converting created epochs to dates", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({
			data: [
				{ id: "o3", created: 1704067200 },
				{ id: "gpt-5.2", created: 1735689600 },
			],
		}));

		const { catalog } = await buildModelCatalog({
			env: { OPENAI_API_KEY: "sk-test" },
			fetchImpl,
			providers: specs("openai"),
		});

		expect(calls[0].url.href).toBe("https://api.openai.com/v1/models");
		expect(calls[0].headers.authorization).toBe("Bearer sk-test");
		expect(catalog.providers.openai.models).toEqual([
			{ id: "gpt-5.2", name: "gpt-5.2", released: "2025-01-01" },
			{ id: "o3", name: "o3", released: "2024-01-01" },
		]);
	});

	it("pages through the Gemini API and strips the models/ prefix", async () => {
		const { fetchImpl, calls } = fakeFetch((url) => {
			if (!url.searchParams.get("pageToken")) {
				return {
					models: [
						{
							name: "models/gemini-3-pro-preview",
							displayName: "Gemini 3 Pro",
						},
					],
					nextPageToken: "page-2",
				};
			}
			return {
				models: [{ name: "models/gemini-2.5-flash", displayName: "" }],
			};
		});

		const { catalog } = await buildModelCatalog({
			env: { GEMINI_API_KEY: "g-key" },
			fetchImpl,
			providers: specs("google"),
		});

		expect(calls[0].headers["x-goog-api-key"]).toBe("g-key");
		expect(calls[1].url.searchParams.get("pageToken")).toBe("page-2");
		expect(catalog.providers.google.models).toEqual([
			{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" },
			{ id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
		]);
	});

	it("falls back to models.dev for providers without an API key", async () => {
		const { fetchImpl, calls } = fakeFetch((url) => {
			expect(url.host).toBe("models.dev");
			return MODELS_DEV_FIXTURE;
		});
		const logged: string[] = [];

		const { catalog } = await buildModelCatalog({
			env: {},
			fetchImpl,
			log: (message) => logged.push(message),
		});

		// One request covers every provider; those missing from the fixture
		// are skipped with a log line.
		expect(calls).toHaveLength(1);
		expect(Object.keys(catalog.providers)).toEqual(["anthropic", "openai"]);
		expect(catalog.providers.anthropic.source).toBe("models.dev");
		expect(catalog.providers.anthropic.models.map((model) => model.id)).toEqual(
			["claude-sonnet-5", "claude-haiku-4-5"],
		);
		expect(logged.some((line) => line.includes("groq"))).toBe(true);
	});

	it("keeps the previous live entry when the provider API fails", async () => {
		const previous: ModelCatalog = {
			updated: "2026-01-01T00:00:00.000Z",
			providers: {
				anthropic: {
					name: "Anthropic",
					source: "api",
					models: [
						{
							id: "claude-sonnet-5",
							name: "Claude Sonnet 5",
							released: "2026-06-29",
						},
					],
				},
			},
		};
		const { fetchImpl, calls } = fakeFetch(() => {
			throw new Error("provider outage");
		});

		const { catalog, changed } = await buildModelCatalog({
			previous,
			env: { ANTHROPIC_API_KEY: "test-key" },
			fetchImpl,
			log: () => {},
			providers: specs("anthropic"),
		});

		expect(changed).toBe(false);
		expect(catalog).toEqual(previous);
		// The previous entry came from the live API, so models.dev (which may
		// lag behind it) is not consulted.
		expect(calls.filter((call) => call.url.host === "models.dev")).toHaveLength(
			0,
		);
	});

	it("falls back to models.dev when the live fetch fails with no previous data", async () => {
		const { fetchImpl } = fakeFetch((url) => {
			if (url.host === "api.anthropic.com") throw new Error("boom");
			return MODELS_DEV_FIXTURE;
		});

		const { catalog } = await buildModelCatalog({
			env: { ANTHROPIC_API_KEY: "test-key" },
			fetchImpl,
			log: () => {},
			providers: specs("anthropic"),
		});

		expect(catalog.providers.anthropic.source).toBe("models.dev");
		expect(catalog.providers.anthropic.models).toHaveLength(2);
	});

	it("reports no change when the refetched catalog is identical", async () => {
		const { fetchImpl } = fakeFetch(() => MODELS_DEV_FIXTURE);
		const first = await buildModelCatalog({
			env: {},
			fetchImpl,
			log: () => {},
			now: () => new Date("2026-07-01T00:00:00Z"),
		});
		expect(first.changed).toBe(true);
		expect(first.catalog.updated).toBe("2026-07-01T00:00:00.000Z");

		const second = await buildModelCatalog({
			previous: first.catalog,
			env: {},
			fetchImpl,
			log: () => {},
			now: () => new Date("2026-07-02T00:00:00Z"),
		});
		expect(second.changed).toBe(false);
		// The timestamp still reflects the last run that changed something.
		expect(second.catalog.updated).toBe("2026-07-01T00:00:00.000Z");
		expect(second.changes).toEqual([]);
	});

	it("diffs added and removed model ids per provider", () => {
		const previous: ModelCatalog = {
			updated: "2026-01-01T00:00:00.000Z",
			providers: {
				anthropic: {
					name: "Anthropic",
					source: "api",
					models: [{ id: "claude-opus-4-5", name: "Claude Opus 4.5" }],
				},
			},
		};
		const next: ModelCatalog = {
			updated: "2026-07-01T00:00:00.000Z",
			providers: {
				anthropic: {
					name: "Anthropic",
					source: "api",
					models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }],
				},
				xai: {
					name: "xAI",
					source: "models.dev",
					models: [{ id: "grok-4.5", name: "Grok 4.5" }],
				},
			},
		};
		expect(diffCatalogs(previous, next)).toEqual([
			{
				provider: "anthropic",
				added: ["claude-opus-4-8"],
				removed: ["claude-opus-4-5"],
			},
			{ provider: "xai", added: ["grok-4.5"], removed: [] },
		]);
	});
});

describe("GET /v1/models/catalog", () => {
	it("serves the bundled models.json catalog", async () => {
		const server = createServer({
			config: { providers: [], corsOrigins: [] },
			logger: false,
		});
		const response = await server.inject({
			method: "GET",
			url: "/v1/models/catalog",
		});
		await server.close();

		expect(response.statusCode).toBe(200);
		const body = response.json() as ModelCatalog;
		expect(body.updated).toBe(modelCatalog.updated);
		expect(body.providers.anthropic.models.length).toBeGreaterThan(0);
		expect(Object.keys(body.providers)).toEqual(
			PROVIDERS.map((provider) => provider.key),
		);
	});

	it("serves an injected catalog override", async () => {
		const catalog: ModelCatalog = {
			updated: "2026-07-01T00:00:00.000Z",
			providers: {
				anthropic: {
					name: "Anthropic",
					source: "api",
					models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
				},
			},
		};
		const server = Fastify({ logger: false });
		await server.register(modelsRoutes, {
			registry: new ProviderRegistry(),
			catalog,
		});
		const response = await server.inject({
			method: "GET",
			url: "/v1/models/catalog",
		});
		await server.close();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(catalog);
	});
});

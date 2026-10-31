import { generateText } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config.js";
import { registryFromConfig } from "../src/providers/registry.js";
import { createServer } from "../src/server.js";

afterEach(() => vi.unstubAllGlobals());

it("configures all hosted providers from environment model lists", () => {
	for (const [kind, prefix] of [
		["openai", "OPENAI"],
		["groq", "GROQ"],
		["mistral", "MISTRAL"],
		["deepseek", "DEEPSEEK"],
		["openrouter", "OPENROUTER"],
		["typesafe", "TYPESAFE"],
	]) {
		const config = configFromEnv({
			[`${prefix}_API_KEY`]: "secret",
			[`${prefix}_MODELS`]: "one, two",
		});
		expect(config.providers).toEqual([
			expect.objectContaining({
				kind,
				name: kind,
				apiKey: "secret",
				models: ["one", "two"],
			}),
		]);
		expect(
			registryFromConfig(config)
				.listModels()
				.map((model) => model.id),
		).toEqual([`${kind}/one`, `${kind}/two`]);
	}
	expect(() => configFromEnv({ CLOUDFLARE_API_TOKEN: "secret" })).toThrow(
		"CLOUDFLARE_ACCOUNT_ID",
	);
});

it("sends Cloudflare requests to the account-scoped endpoint with native model IDs and bearer auth", async () => {
	const upstream = vi.fn<typeof fetch>(async () =>
		Response.json({
			id: "response",
			created: 1,
			model: "@cf/meta/test",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "Hello" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
		}),
	);
	vi.stubGlobal("fetch", upstream);
	const registry = registryFromConfig(
		configFromEnv({
			CLOUDFLARE_API_TOKEN: "secret",
			CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
			CLOUDFLARE_MODELS: "@cf/meta/test",
		}),
	);
	const { text } = await generateText({
		model: registry.resolve("cloudflare/@cf/meta/test").model,
		prompt: "Hi",
	});
	expect(text).toBe("Hello");
	const [endpoint, request] = upstream.mock.calls[0];
	expect(endpoint).toBe(
		`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1/chat/completions`,
	);
	expect(new Headers(request?.headers).get("authorization")).toBe(
		"Bearer secret",
	);
	expect(JSON.parse(request?.body as string).model).toBe("@cf/meta/test");
});

it("validates Cloudflare account setup and allows later additions to reuse account and token", async () => {
	const server = createServer({ config: configFromEnv({}), logger: false });
	try {
		for (const accountId of [undefined, "../bad", "short"]) {
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/models",
						payload: {
							provider: "cloudflare",
							model: "@cf/meta/test",
							apiKey: "secret",
							accountId,
						},
					})
				).statusCode,
			).toBe(400);
		}
		expect((await server.inject("/v1/models")).json().models).toHaveLength(0);
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/models",
					payload: {
						provider: "cloudflare",
						model: "@cf/meta/test",
						apiKey: "secret",
						accountId: "a".repeat(32),
					},
				})
			).statusCode,
		).toBe(200);
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/models",
					payload: { provider: "cloudflare", model: "@cf/meta/second" },
				})
			).statusCode,
		).toBe(200);
		const settings = await server.inject("/v1/providers");
		expect(settings.body).not.toContain("secret");
		expect(
			settings
				.json()
				.providers.find((item: { id: string }) => item.id === "cloudflare"),
		).toMatchObject({ configured: true, accountId: "a".repeat(32) });
	} finally {
		await server.close();
	}
});

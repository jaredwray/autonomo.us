import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";

const url = new URL(
	process.env.MONGODB_URL ??
		"mongodb://autonomous:autonomous@localhost:27017/autonomous?authSource=admin",
);
url.pathname = `/autonomous_models_test_${randomUUID().replaceAll("-", "")}`;
const client = new MongoClient(url.toString(), {
	serverSelectionTimeoutMS: 1500,
});
let available = false;
try {
	await client.db().command({ ping: 1 });
	available = true;
} catch {
	console.warn(
		"MongoDB unavailable; skipping model persistence integration tests.",
	);
}
afterAll(async () => {
	if (available) await client.db().dropDatabase();
	await client.close();
});

describe.skipIf(!available)("persisted model settings", () => {
	it("restores multiple connections of the same provider independently", async () => {
		const config = configFromEnv({ MONGODB_URL: url.toString() });
		let server = createServer({ config, logger: false });
		const ids = ["openai-work", "openai-personal"];
		try {
			for (const connectionId of ids) {
				expect(
					(
						await server.inject({
							method: "POST",
							url: "/v1/models",
							payload: {
								provider: "openai",
								connectionId,
								createConnection: true,
								model: "same-model",
								apiKey: `${connectionId}-secret`,
							},
						})
					).statusCode,
				).toBe(200);
			}
			await server.close();
			server = createServer({ config, logger: false });
			const settings = await server.inject("/v1/providers");
			for (const id of ids)
				expect(settings.json().connections).toContainEqual({
					id,
					provider: "openai",
					configured: true,
				});
			expect(settings.body).not.toContain("-secret");
			const models = (await server.inject("/v1/models")).json().models;
			for (const id of ids)
				expect(models).toContainEqual({
					id: `${id}/same-model`,
					provider: id,
					model: "same-model",
				});
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/models",
						payload: {
							provider: "openai",
							connectionId: ids[0],
							model: "second-model",
						},
					})
				).statusCode,
			).toBe(200);
			const documents = await client
				.db()
				.collection("gateway_providers")
				.find({ "config.kind": "openai" })
				.toArray();
			for (const id of ids)
				expect(
					documents.find((doc) => doc.config.name === id)?.config.apiKey,
				).toBe(`${id}-secret`);
		} finally {
			await server.close();
			await client
				.db()
				.collection<{ _id: string }>("gateway_providers")
				.deleteMany({ _id: { $in: ids } });
		}
	});
	it("restores Cloudflare account IDs, native model IDs, and Jev capability after restart", async () => {
		const config = configFromEnv({ MONGODB_URL: url.toString() });
		let server = createServer({ config, logger: false });
		try {
			for (const payload of [
				{
					provider: "cloudflare",
					model: "@cf/meta/test",
					accountId: "a".repeat(32),
					apiKey: "cf-secret",
				},
				{ provider: "typesafe", model: "jev-latest", apiKey: "jev-secret" },
			])
				expect(
					(await server.inject({ method: "POST", url: "/v1/models", payload }))
						.statusCode,
				).toBe(200);
			await server.close();
			server = createServer({ config, logger: false });
			const settings = await server.inject("/v1/providers");
			expect(settings.json().providers).toContainEqual({
				id: "cloudflare",
				name: "Cloudflare Workers AI",
				configured: true,
				accountId: "a".repeat(32),
			});
			expect(settings.body).not.toMatch(/cf-secret|jev-secret/);
			expect((await server.inject("/v1/models")).json().models).toContainEqual({
				id: "typesafe/jev-latest",
				provider: "typesafe",
				model: "jev-latest",
				capability: "decisions",
			});
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/models",
						payload: { provider: "cloudflare", model: "@cf/meta/second" },
					})
				).statusCode,
			).toBe(200);
		} finally {
			await server.close();
			await client
				.db()
				.collection<{ _id: string }>("gateway_providers")
				.deleteMany({ _id: { $in: ["cloudflare", "typesafe"] } });
		}
	});
	it("preserves simultaneous additions and restores credentials and models after restart", async () => {
		const config = configFromEnv({ MONGODB_URL: url.toString() });
		let server = createServer({ config, logger: false });
		try {
			const responses = await Promise.all(
				["model-one", "model-two"].map((model) =>
					server.inject({
						method: "POST",
						url: "/v1/models",
						payload: {
							provider: "google",
							model,
							apiKey: "test-persisted-key",
						},
					}),
				),
			);
			for (const response of responses) expect(response.statusCode).toBe(200);
			await server.close();
			server = createServer({ config, logger: false });
			const models = await server.inject("/v1/models");
			expect(
				models
					.json()
					.models.map((model: { id: string }) => model.id)
					.sort(),
			).toEqual(["google/model-one", "google/model-two"]);
			const settings = await server.inject("/v1/providers");
			expect(settings.json().persistence).toBe("mongodb");
			expect(settings.json().providers).toContainEqual({
				id: "google",
				name: "Google Gemini",
				configured: true,
			});
			expect(settings.body).not.toContain("test-persisted-key");
			const added = await server.inject({
				method: "POST",
				url: "/v1/models",
				payload: { provider: "google", model: "model-three" },
			});
			expect(added.statusCode).toBe(200);
		} finally {
			await server.close();
		}
	});
});

it("does not advertise an unsaved model when MongoDB is unavailable", async () => {
	const server = createServer({
		config: configFromEnv({ MONGODB_URL: "mongodb://127.0.0.1:9/test" }),
		logger: false,
	});
	try {
		const added = await server.inject({
			method: "POST",
			url: "/v1/models",
			payload: { provider: "xai", model: "grok-test", apiKey: "test-key" },
		});
		expect(added.statusCode).toBe(503);
		expect(added.body).not.toContain("test-key");
		expect((await server.inject("/v1/models")).json().models).toEqual([]);
	} finally {
		await server.close();
	}
}, 10000);

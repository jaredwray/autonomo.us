import { randomUUID } from "node:crypto";
import type { RoutingConfig } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const url = new URL(
	process.env.MONGODB_URL ??
		"mongodb://autonomous:autonomous@localhost:27017/autonomous?authSource=admin",
);
url.pathname = `/autonomous_routing_test_${randomUUID().replaceAll("-", "")}`;
const client = new MongoClient(url.toString(), {
	serverSelectionTimeoutMS: 1500,
});
let available = false;
try {
	await client.db().command({ ping: 1 });
	available = true;
} catch {
	console.warn(
		"MongoDB unavailable; skipping routing persistence integration tests.",
	);
}
afterAll(async () => {
	if (available) await client.db().dropDatabase();
	await client.close();
});
const config: ApiConfig = {
	mongodbUrl: url.toString(),
	corsOrigins: [],
	providers: [
		{
			kind: "openai-compatible",
			name: "local",
			baseURL: "http://127.0.0.1:9/v1",
			models: ["one", "two"],
		},
	],
};
const policy: RoutingConfig = {
	auto: {
		enabled: true,
		decisionModel: "local/one",
		targets: [
			{ target: "pool/coding", description: "Coding" },
			{ target: "local/two", description: "Writing" },
		],
		fallbackTarget: "local/two",
		timeoutMs: 500,
	},
	pools: [
		{
			id: "coding",
			strategy: "least-requests",
			members: [
				{ model: "local/one", weight: 2 },
				{ model: "local/two", weight: 1 },
			],
			failover: true,
		},
	],
	failover: { enabled: true, targets: ["local/two"], timeoutMs: 1000 },
	rules: [
		{
			model: "local/one",
			enabled: true,
			targets: ["local/two"],
			timeoutMs: 200,
		},
	],
};

describe.skipIf(!available)("durable routing", () => {
	it("restores Auto, pools, rules, and serialized legacy edits after restart", async () => {
		let server = createServer({ config, logger: false });
		try {
			expect(
				(
					await server.inject({
						method: "PUT",
						url: "/v1/routing",
						payload: policy,
					})
				).statusCode,
			).toBe(200);
			const edits = await Promise.all(
				[{ enabled: false }, { timeoutMs: 300 }].map((payload) =>
					server.inject({ method: "PUT", url: "/v1/failover", payload }),
				),
			);
			for (const edit of edits) expect(edit.statusCode).toBe(200);
			await server.close();
			server = createServer({ config, logger: false });
			expect((await server.inject("/v1/routing")).json()).toEqual({
				persistence: "mongodb",
				config: {
					...policy,
					failover: { ...policy.failover, enabled: false, timeoutMs: 300 },
				},
			});
			expect((await server.inject("/v1/failover")).json().timeoutMs).toBe(300);
		} finally {
			await server.close();
		}
	});
	it("does not activate edits rejected by durable storage", async () => {
		const server = createServer({ config, logger: false });
		try {
			const before = (await server.inject("/v1/routing")).json();
			await client.db().command({
				collMod: "gateway_routing",
				validator: { rejectTestWrites: { $exists: true } },
				validationLevel: "strict",
			});
			const result = await server.inject({
				method: "PUT",
				url: "/v1/routing",
				payload: { ...policy, rules: [] },
			});
			expect(result.statusCode).toBe(503);
			expect((await server.inject("/v1/routing")).json()).toEqual(before);
			const legacy = await server.inject({
				method: "PUT",
				url: "/v1/failover",
				payload: { timeoutMs: 500 },
			});
			expect(legacy.statusCode).toBe(503);
			expect((await server.inject("/v1/failover")).json()).toEqual(
				before.config.failover,
			);
		} finally {
			await client.db().command({ collMod: "gateway_routing", validator: {} });
			await server.close();
		}
	});
});

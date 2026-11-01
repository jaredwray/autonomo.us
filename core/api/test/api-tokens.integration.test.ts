import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { AgentTokenStore } from "../src/auth/agent-tokens.js";
import { ApiTokenStore, tokenHash } from "../src/auth/tokens.js";

const url = new URL(
	process.env.MONGODB_URL ??
		"mongodb://autonomous:autonomous@localhost:27017/autonomous?authSource=admin",
);
url.pathname = `/autonomous_token_test_${randomUUID().replaceAll("-", "")}`;
const client = new MongoClient(url.toString(), {
	serverSelectionTimeoutMS: 1500,
});
let available = false;
try {
	await client.db().command({ ping: 1 });
	available = true;
} catch {
	console.warn(
		"MongoDB unavailable; skipping API token persistence integration tests.",
	);
}
afterAll(async () => {
	if (available) await client.db().dropDatabase();
	await client.close();
});

describe.skipIf(!available)("durable API tokens", () => {
	it("persists agent credentials separately and propagates permission edits and revocation across replicas", async () => {
		let store = new AgentTokenStore(url.toString());
		const replica = new AgentTokenStore(url.toString());
		const api = new ApiTokenStore(url.toString());
		try {
			const original = await store.create(
				{
					name: "Durable agent",
					description: "MCP",
					ttlDays: 30,
					permissions: ["mcp:read", "mcp:call"],
				},
				"owner",
			);
			const rolled = await store.roll(
				original.token.id,
				{ ttlDays: 7, previousTokenTtlSeconds: 3600 },
				"owner",
			);
			await store.close();
			store = new AgentTokenStore(url.toString());
			const raw = await client
				.db()
				.collection("gateway_agent_tokens")
				.findOne({ name: "Durable agent" });
			for (const issued of [original, rolled]) {
				expect(JSON.stringify(raw)).not.toContain(issued.secret);
				expect(JSON.stringify(raw)).toContain(tokenHash(issued.secret));
				expect(await store.authenticate(issued.secret)).not.toBeNull();
				expect(await api.authenticate(issued.secret)).toBeNull();
			}
			expect(
				(await api.settings(true)).tokens.some(
					(token) => token.id === original.token.id,
				),
			).toBe(false);
			await replica.update(
				original.token.id,
				{
					name: "Durable agent",
					description: "Reduced",
					permissions: ["mcp:read"],
				},
				"owner",
			);
			for (const issued of [original, rolled])
				expect((await store.authenticate(issued.secret))?.permissions).toEqual([
					"mcp:read",
				]);
			const before = await store.settings(true);
			await client.db().command({
				collMod: "gateway_agent_tokens",
				validator: { rejectTestWrites: { $exists: true } },
				validationLevel: "strict",
			});
			try {
				await expect(
					replica.roll(
						original.token.id,
						{ ttlDays: 7, previousTokenTtlSeconds: 0 },
						"owner",
					),
				).rejects.toMatchObject({ statusCode: 503 });
				await expect(
					replica.revoke(original.token.id, "owner"),
				).rejects.toMatchObject({ statusCode: 503 });
				expect(await store.settings(true)).toEqual(before);
			} finally {
				await client
					.db()
					.command({ collMod: "gateway_agent_tokens", validator: {} });
			}
			await replica.revoke(original.token.id, "owner");
			for (const issued of [original, rolled])
				expect(await store.authenticate(issued.secret)).toBeNull();
			expect((await store.settings(true)).actions).toHaveLength(4);
		} finally {
			await store.close();
			await replica.close();
			await api.close();
		}
	});
	it("stores hashes, restores overlap after restart, and propagates revocation across replicas", async () => {
		let now = Date.now();
		let store = new ApiTokenStore(url.toString(), () => now);
		const replica = new ApiTokenStore(url.toString(), () => now);
		try {
			const original = await store.create(
				{ name: "Durable", description: "Across restarts", ttlDays: 30 },
				"owner",
			);
			const rolled = await store.roll(
				original.token.id,
				{ ttlDays: 180, previousTokenTtlSeconds: 1 },
				"owner",
			);
			await store.close();
			store = new ApiTokenStore(url.toString(), () => now);
			const raw = await client
				.db()
				.collection("gateway_api_tokens")
				.findOne({ name: "Durable" });
			expect(JSON.stringify(raw)).not.toContain(original.secret);
			expect(JSON.stringify(raw)).not.toContain(rolled.secret);
			expect(JSON.stringify(raw)).toContain(tokenHash(original.secret));
			expect(await store.authenticate(original.secret)).not.toBeNull();
			expect(await replica.authenticate(rolled.secret)).not.toBeNull();
			now += 1000;
			expect(await store.authenticate(original.secret)).toBeNull();
			await Promise.all([
				store.update(
					original.token.id,
					{ name: "Changed", description: "concurrent edit" },
					"owner",
				),
				replica.roll(
					original.token.id,
					{ ttlDays: 7, previousTokenTtlSeconds: 3600 },
					"owner",
				),
			]);
			expect((await store.settings(true)).tokens[0]).toMatchObject({
				name: "Changed",
				ttlDays: 7,
			});
			await store.revoke(original.token.id, "owner");
			expect(await replica.authenticate(rolled.secret)).toBeNull();
			expect((await replica.settings(true)).actions).toHaveLength(5);
		} finally {
			await store.close();
			await replica.close();
		}
	});
	it("keeps old credentials and history when a write is rejected", async () => {
		const store = new ApiTokenStore(url.toString());
		try {
			const original = await store.create(
				{ name: "Write failure", description: "", ttlDays: 7 },
				"owner",
			);
			const before = await store.settings(true);
			await client.db().command({
				collMod: "gateway_api_tokens",
				validator: { rejectTestWrites: { $exists: true } },
				validationLevel: "strict",
			});
			await expect(
				store.roll(
					original.token.id,
					{ ttlDays: 30, previousTokenTtlSeconds: 0 },
					"owner",
				),
			).rejects.toMatchObject({ statusCode: 503 });
			await expect(
				store.revoke(original.token.id, "owner"),
			).rejects.toMatchObject({ statusCode: 503 });
			await expect(
				store.update(
					original.token.id,
					{
						name: "Failed permissions",
						description: "",
						permissions: ["routing:edit"],
					},
					"owner",
				),
			).rejects.toMatchObject({ statusCode: 503 });
			await expect(
				store.create(
					{ name: "Rejected", description: "", ttlDays: 1 },
					"owner",
				),
			).rejects.toMatchObject({ statusCode: 503 });
			expect(await store.settings(true)).toEqual(before);
			expect(await store.authenticate(original.secret)).not.toBeNull();
		} finally {
			await client
				.db()
				.command({ collMod: "gateway_api_tokens", validator: {} });
			await store.close();
		}
	});
	it("upgrades legacy records on mutation and persists reductions across replicas and restarts", async () => {
		let store = new ApiTokenStore(url.toString());
		const replica = new ApiTokenStore(url.toString());
		try {
			const original = await store.create(
				{ name: "Legacy permissions", description: "", ttlDays: 30 },
				"owner",
			);
			await client
				.db()
				.collection("gateway_api_tokens")
				.updateOne(
					{ name: "Legacy permissions" },
					{ $unset: { permissions: "" } },
				);
			expect(
				(await replica.authenticate(original.secret))?.permissions,
			).toEqual(["models:read", "inference:run"]);
			const rolled = await store.roll(
				original.token.id,
				{ ttlDays: 30, previousTokenTtlSeconds: 3600 },
				"owner",
			);
			expect(rolled.token.permissions).toEqual([
				"models:read",
				"inference:run",
			]);
			await store.update(
				original.token.id,
				{
					name: "Legacy permissions",
					description: "",
					permissions: ["routing:edit"],
				},
				"owner",
			);
			await store.close();
			store = new ApiTokenStore(url.toString());
			for (const issued of [original, rolled]) {
				expect((await store.authenticate(issued.secret))?.permissions).toEqual([
					"routing:edit",
				]);
				expect(
					(await replica.authenticate(issued.secret))?.permissions,
				).toEqual(["routing:edit"]);
			}
			await replica.update(
				original.token.id,
				{ name: "Legacy permissions", description: "", permissions: [] },
				"owner",
			);
			expect((await store.authenticate(original.secret))?.permissions).toEqual(
				[],
			);
			expect((await store.authenticate(rolled.secret))?.permissions).toEqual(
				[],
			);
		} finally {
			await store.close();
			await replica.close();
		}
	});
});

it("fails closed when configured MongoDB is unavailable", async () => {
	const store = new ApiTokenStore("mongodb://127.0.0.1:1/unavailable");
	try {
		await expect(store.settings(true)).rejects.toMatchObject({
			statusCode: 503,
		});
		await expect(
			store.authenticate(`aut_${randomUUID()}_${"x".repeat(43)}`),
		).rejects.toMatchObject({ statusCode: 503 });
	} finally {
		await store.close();
	}
});

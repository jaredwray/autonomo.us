import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
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

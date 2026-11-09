import type { RoutingConfig } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { createServer, initializePersistence } from "../src/server.js";
import { withSession } from "./auth-helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
if (!available) {
	console.warn(
		"MongoDB unavailable; skipping database initialization integration tests.",
	);
}

describe.skipIf(!available)("database initialization", () => {
	let mongodbUrl: string;
	let client: MongoClient;
	const servers: ReturnType<typeof createServer>[] = [];

	beforeEach(() => {
		mongodbUrl = uniqueMongoUrl("init");
		client = new MongoClient(mongodbUrl, { serverSelectionTimeoutMS: 1500 });
	});

	afterEach(async () => {
		try {
			await Promise.all(servers.splice(0).map((server) => server.close()));
		} finally {
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close();
			}
		}
	});

	function start(failover?: ApiConfig["failover"]) {
		const server = createServer({
			config: { mongodbUrl, providers: [], corsOrigins: [], failover },
			logger: false,
		});
		servers.push(server);
		return server;
	}

	function settings() {
		return client
			.db()
			.collection<{ _id: string; config: RoutingConfig }>("gateway_routing");
	}

	it("defers database creation until the Worker handles a request", async () => {
		const server = createServer({
			config: { mongodbUrl, providers: [], corsOrigins: [] },
			logger: false,
			deferPersistence: true,
		});
		servers.push(server);
		await server.ready();
		expect(await client.db().listCollections().toArray()).toEqual([]);
		expect(await initializePersistence(server)).toBe(true);
		expect(await settings().findOne({ _id: "default" })).not.toBeNull();
		expect((await server.inject("/healthz")).json().mongodb.initialized).toBe(
			true,
		);
	});

	it("creates a fresh database at startup and preserves its defaults on restart", async () => {
		expect(await client.db().listCollections().toArray()).toEqual([]);
		const server = start({ timeoutMs: 1234 });
		await server.ready();

		const defaults: RoutingConfig = {
			auto: {
				enabled: false,
				decisionModel: "",
				targets: [],
				fallbackTarget: "",
				timeoutMs: 10_000,
			},
			pools: [],
			failover: { enabled: false, targets: [], timeoutMs: 1234 },
			rules: [],
		};
		expect(await settings().findOne({ _id: "default" })).toEqual({
			_id: "default",
			config: defaults,
			revision: 0,
		});
		await server.close();

		const restarted = await withSession(
			start({ enabled: true, timeoutMs: 5678 }),
		);
		const response = await restarted.inject("/v1/routing");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			persistence: "mongodb",
			config: defaults,
		});
		expect(await settings().findOne({ _id: "default" })).toEqual({
			_id: "default",
			config: defaults,
			revision: 0,
		});
	});

	it("shares the persisted defaults between concurrent first startups", async () => {
		const first = start({ timeoutMs: 1000 });
		const second = start({ timeoutMs: 2000 });
		await Promise.all([first.ready(), second.ready()]);

		const saved = await settings().findOne({ _id: "default" });
		expect(saved).not.toBeNull();
		expect(await settings().countDocuments()).toBe(1);
		expect([1000, 2000]).toContain(saved?.config.failover.timeoutMs);
		for (const server of [
			await withSession(first),
			await withSession(second),
		]) {
			const response = await server.inject("/v1/routing");
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				persistence: "mongodb",
				config: saved?.config,
			});
		}
	});

	it("reports a failed initialization and retries after writes recover", async () => {
		await client.db().createCollection("gateway_routing", {
			validator: { rejectTestWrites: { $exists: true } },
			validationLevel: "strict",
		});
		const server = await withSession(start());
		const failed = await server.inject("/v1/routing");
		expect(failed.statusCode).toBe(503);
		expect(await settings().countDocuments()).toBe(0);
		expect((await server.inject("/healthz")).json().mongodb).toEqual({
			configured: true,
			connected: true,
			initialized: false,
		});

		await client.db().command({ collMod: "gateway_routing", validator: {} });
		expect(await initializePersistence(server)).toBe(true);
		const recovered = await server.inject("/v1/routing");
		expect(recovered.statusCode).toBe(200);
		expect(await settings().findOne({ _id: "default" })).toEqual({
			_id: "default",
			config: recovered.json().config,
			revision: 0,
		});
	});
});

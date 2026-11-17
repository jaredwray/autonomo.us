import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config.js";
import { healthRoutes } from "../src/routes/health.js";
import { createServer as createGatewayServer } from "../src/server.js";
import { scheduleTicksAsMicrotasks } from "../src/worker-requests.js";
import { routeToDefaultWorkspace } from "./auth-helpers.js";

/** Servers here exercise the default workspace through pre-workspace paths. */
const createServer = (options?: Parameters<typeof createGatewayServer>[0]) =>
	routeToDefaultWorkspace(createGatewayServer(options));

const mocks = vi.hoisted(() => ({
	mongoPing: vi.fn(),
	mongoClose: vi.fn(),
	synapseIndexes: vi.fn(),
}));
vi.mock("mongodb", () => ({
	MongoClient: class {
		db() {
			return {
				command: mocks.mongoPing,
				collection: () => ({
					find: () => ({ toArray: async () => [] }),
					findOne: async () => null,
					updateOne: async () => ({ matchedCount: 0 }),
					createIndex: async () => "index",
					createIndexes: mocks.synapseIndexes,
					findOneAndUpdate: async (
						_filter: unknown,
						update: { $setOnInsert: { config: unknown } },
					) => ({ _id: "default", ...update.$setOnInsert }),
				}),
			};
		}
		close = mocks.mongoClose;
	},
	MongoBulkWriteError: class MongoBulkWriteError extends Error {},
}));

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	vi.resetAllMocks();
});

async function health(env: Record<string, string> = {}) {
	const server = createServer({ config: configFromEnv(env), logger: false });
	servers.push(server);
	const response = await server.inject("/health");
	expect(response.statusCode).toBe(200);
	return response.json();
}

const configuredEnv = {
	MONGODB_URI: "mongodb://localhost:27017/autonomous",
};

describe("health route", () => {
	it("reports an unconfigured database without probing", async () => {
		const body = await health();
		expect(body.status).toBe("ok");
		expect(body.timestamp).toBeDefined();
		expect(body.mongodb).toEqual({
			configured: false,
			connected: false,
			initialized: false,
		});
		expect(mocks.mongoPing).not.toHaveBeenCalled();
		const healthz = await servers[0].inject("/healthz");
		expect(healthz.statusCode).toBe(200);
		expect(healthz.json()).toMatchObject({
			status: "ok",
			mongodb: { configured: false, connected: false },
		});
	});

	it("boots with the Worker timer settings", async () => {
		const restore = scheduleTicksAsMicrotasks();
		try {
			const server = createServer({ logger: false, pluginTimeout: 0 });
			servers.push(server);
			const response = await server.inject("/healthz");
			expect(response.statusCode).toBe(200);
			expect(response.json().status).toBe("ok");
		} finally {
			restore();
		}
	});

	it("reports a successful probe and closes MongoDB clients", async () => {
		const body = await health(configuredEnv);
		expect(body.mongodb).toEqual({
			configured: true,
			connected: true,
			initialized: true,
		});
		expect(mocks.mongoPing).toHaveBeenCalledWith({ ping: 1 });
		await servers[0].close();
		// The probe closes its own client. The stores share one control-plane
		// client, which closes once. Synapse owns one additional client.
		expect(mocks.mongoClose).toHaveBeenCalledTimes(3);
		expect(body.synapse).toEqual({ configured: true, ready: true });
	});

	it("reports a failed probe and recovers on the next request", async () => {
		mocks.mongoPing.mockRejectedValueOnce(new Error("unavailable"));
		const body = await health(configuredEnv);
		expect(body.mongodb.connected).toBe(false);
		const recovered = (await servers[0].inject("/health")).json();
		expect(recovered.mongodb.connected).toBe(true);
	});
});

it("reports Synapse failure independently, coalesces probes and observes recovery after cache expiry", async () => {
	const probe = vi.fn<() => Promise<void>>();
	let fail: (error: Error) => void = () => {};
	probe.mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			}),
	);
	const server = Fastify();
	await server.register(healthRoutes, {
		config: configFromEnv(configuredEnv),
		persistenceInitialized: () => true,
		synapseProbe: probe,
		synapseCacheMs: 5000,
	});
	try {
		const first = server.inject("/healthz");
		const second = server.inject("/healthz");
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
		fail(new Error("private URI"));
		for (const response of await Promise.all([first, second])) {
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				mongodb: { connected: true, initialized: true },
				synapse: { configured: true, ready: false },
			});
			expect(response.body).not.toContain("private URI");
		}
		await server.inject("/healthz");
		expect(probe).toHaveBeenCalledTimes(1);
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 6000);
		probe.mockResolvedValue(undefined);
		expect((await server.inject("/healthz")).json().synapse.ready).toBe(true);
	} finally {
		vi.restoreAllMocks();
		await server.close();
	}
});
it("does not share pending probes when request-scoped Worker clients are used", async () => {
	const probe = vi.fn(async () => {});
	const server = Fastify();
	await server.register(healthRoutes, {
		config: configFromEnv({}),
		persistenceInitialized: () => false,
		synapseProbe: probe,
		synapseCacheMs: 0,
	});
	try {
		await Promise.all([server.inject("/health"), server.inject("/healthz")]);
		expect(probe).toHaveBeenCalledTimes(2);
	} finally {
		await server.close();
	}
});

it("the API reports an actual Synapse index failure while Mongo remains healthy and logs its stage", async () => {
	mocks.synapseIndexes.mockRejectedValueOnce(
		Object.assign(new Error("mongodb://private:secret@host/db"), {
			name: "MongoServerError",
			code: 85,
		}),
	);
	const server = createServer({
		config: configFromEnv({
			MONGODB_URI: "mongodb://localhost/health_index_failure",
		}),
		logger: false,
	});
	servers.push(server);
	const log = vi.spyOn(server.log, "error");
	const response = await server.inject("/healthz");
	expect(response.json()).toMatchObject({
		status: "ok",
		mongodb: { connected: true, initialized: true },
		synapse: { configured: true, ready: false },
	});
	expect(log).toHaveBeenCalledWith(
		expect.objectContaining({
			event: "synapse.storage_failed",
			stage: "indexes.notes",
			errors: [{ errorType: "MongoServerError", code: 85 }],
		}),
		"synapse.storage_failed",
	);
	expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
	expect(response.body).not.toContain("secret");
});

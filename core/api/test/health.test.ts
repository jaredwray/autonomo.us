import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";

const mocks = vi.hoisted(() => ({
	mongoPing: vi.fn(),
	mongoClose: vi.fn(),
}));
vi.mock("mongodb", () => ({
	MongoClient: class {
		db() {
			return {
				command: mocks.mongoPing,
				collection: () => ({
					find: () => ({ toArray: async () => [] }),
					findOne: async () => null,
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
	MONGODB_URL: "mongodb://localhost:27017/autonomous",
};

describe("health route", () => {
	it("reports an unconfigured database without probing", async () => {
		const body = await health();
		expect(body.status).toBe("ok");
		expect(body.timestamp).toBeDefined();
		expect(body.mongodb).toEqual({ configured: false, connected: false });
		expect(mocks.mongoPing).not.toHaveBeenCalled();
	});

	it("reports a successful probe and closes MongoDB clients", async () => {
		const body = await health(configuredEnv);
		expect(body.mongodb).toEqual({ configured: true, connected: true });
		expect(mocks.mongoPing).toHaveBeenCalledWith(
			{ ping: 1 },
			{ timeoutMS: 1000 },
		);
		await servers[0].close();
		// The probe closes its own client. Model settings and routing each
		// close the client they opened while loading.
		expect(mocks.mongoClose).toHaveBeenCalledTimes(3);
	});

	it("reports a failed probe and recovers on the next request", async () => {
		mocks.mongoPing.mockRejectedValueOnce(new Error("unavailable"));
		const body = await health(configuredEnv);
		expect(body.mongodb.connected).toBe(false);
		const recovered = (await servers[0].inject("/health")).json();
		expect(recovered.mongodb.connected).toBe(true);
	});
});

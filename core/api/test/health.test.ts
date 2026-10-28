import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";

const mocks = vi.hoisted(() => ({
	mongoPing: vi.fn(),
	mongoClose: vi.fn(),
	clickhousePing: vi.fn(),
}));
vi.mock("mongodb", () => ({
	MongoClient: class {
		db() {
			return { command: mocks.mongoPing };
		}
		close = mocks.mongoClose;
	},
}));
vi.mock("../src/telemetry/clickhouse.js", () => ({
	ClickHouseSink: class {
		ping = mocks.clickhousePing;
	},
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
	CLICKHOUSE_URL: "http://localhost:8123",
};

describe("health route", () => {
	it("reports unconfigured databases without probing", async () => {
		const body = await health();
		expect(body.status).toBe("ok");
		expect(body.timestamp).toBeDefined();
		expect(body.mongodb).toEqual({ configured: false, connected: false });
		expect(body.clickhouse).toEqual({ configured: false, connected: false });
		expect(mocks.mongoPing).not.toHaveBeenCalled();
		expect(mocks.clickhousePing).not.toHaveBeenCalled();
	});

	it("reports successful authenticated probes and closes MongoDB", async () => {
		const body = await health(configuredEnv);
		expect(body.mongodb).toEqual({ configured: true, connected: true });
		expect(body.clickhouse).toEqual({ configured: true, connected: true });
		expect(mocks.mongoPing).toHaveBeenCalledWith(
			{ ping: 1 },
			{ timeoutMS: 1000 },
		);
		await servers[0].close();
		expect(mocks.mongoClose).toHaveBeenCalledOnce();
	});

	it("reports failures independently and recovers on a subsequent probe", async () => {
		mocks.mongoPing.mockRejectedValueOnce(new Error("unavailable"));
		const body = await health(configuredEnv);
		expect(body.mongodb.connected).toBe(false);
		expect(body.clickhouse.connected).toBe(true);
		mocks.clickhousePing.mockRejectedValueOnce(new Error("unauthorized"));
		const recovered = (await servers[0].inject("/health")).json();
		expect(recovered.mongodb.connected).toBe(true);
		expect(recovered.clickhouse.connected).toBe(false);
	});
});

import type { FastifyInstance } from "fastify";
import { MongoClient } from "mongodb";
import type { ApiConfig } from "../config.js";
import { ClickHouseSink } from "../telemetry/clickhouse.js";

type DependencyStatus = { configured: boolean; connected: boolean };

async function check(
	probe?: () => Promise<unknown>,
): Promise<DependencyStatus> {
	if (!probe) return { configured: false, connected: false };
	try {
		await probe();
		return { configured: true, connected: true };
	} catch {
		return { configured: true, connected: false };
	}
}

export async function healthRoutes(
	server: FastifyInstance,
	{ config }: { config: ApiConfig },
) {
	const clickhouse = config.clickhouse
		? new ClickHouseSink(config.clickhouse)
		: undefined;
	let mongo: MongoClient | undefined;
	const pingMongo = config.mongodbUrl
		? async () => {
				// Construct lazily so malformed URLs report disconnected instead
				// of preventing the API from starting.
				mongo ??= new MongoClient(config.mongodbUrl as string, {
					serverSelectionTimeoutMS: 1000,
					connectTimeoutMS: 1000,
					socketTimeoutMS: 1000,
				});
				await mongo.db().command({ ping: 1 }, { timeoutMS: 1000 });
			}
		: undefined;

	server.addHook("onClose", async () => {
		await mongo?.close();
	});

	server.get("/health", async () => {
		const [mongodb, clickhouseStatus] = await Promise.all([
			check(pingMongo),
			check(clickhouse ? () => clickhouse.ping() : undefined),
		]);
		return {
			// This remains a liveness endpoint; optional database outages do
			// not prevent the dashboard from starting in Docker Compose.
			status: "ok",
			timestamp: new Date().toISOString(),
			mongodb,
			clickhouse: clickhouseStatus,
		};
	});
}

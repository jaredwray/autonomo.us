import type { FastifyInstance } from "fastify";
import { MongoClient } from "mongodb";
import type { ApiConfig } from "../config.js";

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
	const pingMongo = config.mongodbUrl
		? async () => {
				// A fresh client per probe: Workers cannot reuse the socket,
				// and a malformed URL should report disconnected rather than
				// prevent the API from starting.
				const mongo = new MongoClient(config.mongodbUrl as string, {
					serverSelectionTimeoutMS: 1000,
					connectTimeoutMS: 1000,
					socketTimeoutMS: 1000,
				});
				try {
					await mongo.db().command({ ping: 1 }, { timeoutMS: 1000 });
				} finally {
					await mongo.close();
				}
			}
		: undefined;

	server.get("/health", async () => {
		const mongodb = await check(pingMongo);
		return {
			// This remains a liveness endpoint; an optional database outage
			// does not prevent the dashboard from starting in Docker Compose.
			status: "ok",
			timestamp: new Date().toISOString(),
			mongodb,
		};
	});
}

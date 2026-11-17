import type { FastifyInstance } from "fastify";
import { MongoClient } from "mongodb";
import type { ApiConfig } from "../config.js";
import { mongoOperationDeadlines } from "../mongo.js";

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
	{
		config,
		persistenceInitialized,
		synapseProbe,
		synapseCacheMs = 0,
	}: {
		config: ApiConfig;
		persistenceInitialized: () => boolean;
		synapseProbe?: () => Promise<void>;
		synapseCacheMs?: number;
	},
) {
	const pingMongo = config.mongodbUrl
		? async () => {
				// A fresh client per probe: Workers cannot reuse the socket,
				// and a malformed URL should report disconnected rather than
				// prevent the API from starting.
				const mongo = new MongoClient(config.mongodbUrl as string, {
					serverSelectionTimeoutMS: 1000,
					...mongoOperationDeadlines(1000),
				});
				try {
					await mongo.db().command({ ping: 1 });
				} finally {
					await mongo.close();
				}
			}
		: undefined;

	let cached: { configured: boolean; ready: boolean } | undefined;
	let until = 0;
	let pending: Promise<{ configured: boolean; ready: boolean }> | undefined;
	const probeSynapse = async () => {
		const result = await check(synapseProbe);
		return { configured: result.configured, ready: result.connected };
	};
	const synapseHealth = () => {
		if (!synapseCacheMs) return probeSynapse();
		if (cached && Date.now() < until) return Promise.resolve(cached);
		pending ??= probeSynapse()
			.then((result) => {
				cached = result;
				until = Date.now() + synapseCacheMs;
				return result;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
	const report = async (includeSynapse: boolean) => {
		const [mongodb, synapse] = await Promise.all([
			check(pingMongo),
			includeSynapse ? synapseHealth() : undefined,
		]);
		return {
			// This remains a liveness endpoint; an optional database outage
			// does not prevent the dashboard from starting in Docker Compose.
			status: "ok",
			...(synapse === undefined ? {} : { synapse }),
			timestamp: new Date().toISOString(),
			mongodb: {
				...mongodb,
				initialized: mongodb.configured && persistenceInitialized(),
			},
		};
	};
	// Compose and load balancers use /health: never wait on Synapse here.
	server.get("/health", () => report(false));
	server.get("/healthz", () => report(true));
}

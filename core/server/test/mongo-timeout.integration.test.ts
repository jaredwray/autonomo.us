import { MongoClient, MongoNetworkTimeoutError } from "mongodb";
import { describe, expect, it } from "vitest";
import { mongoOperationDeadlines } from "../src/mongo.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
const failpoints = available && (await failpointsEnabled());
if (!available) {
	console.warn(
		"[mongo-timeout] no MongoDB at MONGODB_URI — skipping. Start it with: docker compose up -d mongo",
	);
} else if (!failpoints) {
	console.warn(
		"[mongo-timeout] MongoDB test commands are disabled — skipping the stall deadline.",
	);
}

async function failpointsEnabled(): Promise<boolean> {
	const client = new MongoClient(uniqueMongoUrl("failpoints"), {
		serverSelectionTimeoutMS: 1500,
	});
	try {
		await client.db("admin").command({
			configureFailPoint: "failCommand",
			mode: "off",
		});
		return true;
	} catch {
		return false;
	} finally {
		await client.close().catch(() => {});
	}
}

describe.skipIf(!failpoints)("mongodb operation deadlines", () => {
	it("stops waiting when the server accepts a command and then stalls", async () => {
		const url = uniqueMongoUrl("deadline");
		const appName = "autonomo-deadline-test";
		const admin = new MongoClient(url, { serverSelectionTimeoutMS: 1500 });
		const stalled = new MongoClient(url, {
			appName,
			serverSelectionTimeoutMS: 1500,
			// One attempt, so the socket deadline is the operation deadline.
			retryReads: false,
			...mongoOperationDeadlines(500),
		});
		try {
			await admin.db("admin").command({
				configureFailPoint: "failCommand",
				mode: { times: 1 },
				data: {
					failCommands: ["find"],
					appName,
					blockConnection: true,
					blockTimeMS: 2_000,
				},
			});
			const started = Date.now();
			await expect(
				stalled.db().collection("stall").find({}).toArray(),
			).rejects.toThrow(MongoNetworkTimeoutError);
			expect(Date.now() - started).toBeLessThan(4_000);
		} finally {
			await admin
				.db("admin")
				.command({ configureFailPoint: "failCommand", mode: "off" })
				.catch(() => {});
			await stalled.close().catch(() => {});
			await admin
				.db()
				.dropDatabase()
				.catch(() => {});
			await admin.close().catch(() => {});
		}
	});
});

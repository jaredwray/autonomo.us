import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlPlaneConnection } from "../src/mongo.js";
import type { SynapseDiagnostic } from "../src/synapse/diagnostics.js";
import { MongoSynapseRepository } from "../src/synapse/mongo-repository.js";
import { MongoTelemetrySink } from "../src/telemetry/mongo.js";
import { FakeMongo } from "./fake-mongo.js";

/**
 * A long-lived process keeps one client per store. The driver closes a client
 * whose first connection attempt times out and never reopens it, so without a
 * replacement every later call fails until the process restarts.
 */
describe("a client whose first connection attempt timed out", () => {
	let mongo: FakeMongo;
	beforeEach(async () => {
		mongo = await FakeMongo.listen();
	});
	afterEach(async () => {
		await mongo.close();
	});

	it("is replaced for the control-plane stores", async () => {
		const connection = controlPlaneConnection(mongo.url, 200);
		try {
			await expect(
				connection.collection("gateway_instance").findOne({}),
			).rejects.toMatchObject({ name: "MongoServerSelectionError" });
			mongo.reachable = true;
			await expect(
				connection.collection("gateway_instance").findOne({}),
			).resolves.toBeNull();
		} finally {
			await connection.close();
		}
	});

	it("is replaced for Synapse, which then initializes and reads", async () => {
		const logs: SynapseDiagnostic[] = [];
		const repository = new MongoSynapseRepository(
			mongo.url,
			(entry) => logs.push(entry),
			200,
		);
		try {
			await expect(repository.check()).rejects.toMatchObject({
				statusCode: 503,
			});
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				event: "synapse.storage_failed",
				stage: "connect",
			});
			expect(logs[0].errors?.[0]).toEqual({
				errorType: "MongoServerSelectionError",
			});
			mongo.reachable = true;
			await expect(repository.check()).resolves.toBeUndefined();
			await expect(repository.getNote("shared", "note")).resolves.toBeNull();
			expect(logs.slice(1).map((entry) => [entry.event, entry.stage])).toEqual([
				["synapse.storage_ready", "connect"],
				["synapse.storage_ready", "indexes.notes"],
				["synapse.storage_ready", "indexes.proposals"],
				["synapse.storage_ready", "indexes.revisions"],
			]);
		} finally {
			await repository.close();
		}
	});

	it("is replaced for telemetry, which reports healthy again", async () => {
		const sink = new MongoTelemetrySink(mongo.url, 200);
		try {
			await expect(sink.ping()).rejects.toMatchObject({
				name: "MongoServerSelectionError",
			});
			expect(sink.healthy).toBe(false);
			mongo.reachable = true;
			await sink.ping();
			expect(sink.healthy).toBe(true);
		} finally {
			await sink.close();
		}
	});
});

import type { TelemetryEvent } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { MongoTelemetrySink } from "../src/telemetry/mongo.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

// Runs against a real MongoDB server — the CI service container or
// `docker compose up mongo` locally. Skipped (loudly) when absent.
const available = await mongoAvailable();
if (!available) {
	console.warn(
		"[mongo.integration] no MongoDB at MONGODB_URL — skipping. Start it with: docker compose up -d mongo",
	);
}

function chatEvent(
	id: string,
	overrides: Partial<{
		type: string;
		model: string;
		provider: string;
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		latencyMs: number;
		error: string;
		timestamp: string;
	}> = {},
): TelemetryEvent {
	const {
		type = "gateway.chat",
		timestamp = new Date().toISOString(),
		...data
	} = overrides;
	return {
		id,
		type,
		data: {
			model: "stub/chat-model",
			provider: "stub",
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			latencyMs: 100,
			...data,
		},
		timestamp,
	};
}

describe.skipIf(!available)("MongoTelemetrySink (real server)", () => {
	const urls: string[] = [];

	afterAll(async () => {
		for (const url of urls) {
			const client = new MongoClient(url, { serverSelectionTimeoutMS: 1500 });
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close().catch(() => {});
			}
		}
	});

	function sinkWithDatabase(prefix: string) {
		const url = uniqueMongoUrl(prefix);
		urls.push(url);
		return new MongoTelemetrySink(url);
	}

	it("creates the schema, inserts events, and aggregates summaries", async () => {
		const sink = sinkWithDatabase("summary");
		await sink.ensureSchema();
		await sink.insert([
			chatEvent("evt-1", {
				model: "stub/chat-model",
				latencyMs: 100,
			}),
			chatEvent("evt-2", {
				type: "gateway.decisions",
				model: "stub/chat-model",
				latencyMs: 200,
			}),
			chatEvent("evt-3", {
				type: "gateway.error",
				model: "stub/broken-model",
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				latencyMs: 50,
				error: "provider exploded",
			}),
		]);

		const summary = await sink.querySummary();
		expect(summary.source).toBe("mongodb");
		expect(summary.totalRequests).toBe(3);
		expect(summary.totalErrors).toBe(1);
		expect(summary.promptTokens).toBe(20);
		expect(summary.completionTokens).toBe(10);
		expect(summary.totalTokens).toBe(30);
		expect(summary.avgLatencyMs).toBe(150);

		const models = Object.fromEntries(
			summary.byModel.map((usage) => [usage.model, usage]),
		);
		expect(models["chat-model"]).toMatchObject({
			provider: "stub",
			requests: 2,
			errors: 0,
			totalTokens: 30,
		});
		expect(models["broken-model"]).toMatchObject({
			requests: 1,
			errors: 1,
		});
		expect(sink.healthy).toBe(true);
		await sink.close();
	});

	it("deduplicates a retried batch by event id", async () => {
		const sink = sinkWithDatabase("dedup");
		await sink.ensureSchema();
		const timestamp = new Date().toISOString();
		const batch = [
			chatEvent("evt-dup-1", { timestamp }),
			chatEvent("evt-dup-2", { timestamp }),
		];

		await sink.insert(batch);
		await sink.insert(batch);

		const summary = await sink.querySummary();
		expect(summary.totalRequests).toBe(2);
		expect(summary.totalTokens).toBe(30);
		await sink.close();
	});

	it("marks itself unhealthy on auth failures and recovers", async () => {
		const url = uniqueMongoUrl("auth");
		urls.push(url);
		const sink = new MongoTelemetrySink(url);
		await sink.ensureSchema();
		expect(sink.healthy).toBe(true);

		const badUrl = new URL(url);
		badUrl.password = "definitely-wrong-password";
		const badAuth = new MongoTelemetrySink(badUrl.toString(), 1500);
		await expect(badAuth.insert([chatEvent("evt-auth")])).rejects.toThrow();
		expect(badAuth.healthy).toBe(false);

		await sink.insert([chatEvent("evt-auth-ok")]);
		expect(sink.healthy).toBe(true);
		await badAuth.close();
		await sink.close();
	});

	it("times out against an unreachable server without hanging", async () => {
		const dead = new MongoTelemetrySink(
			"mongodb://127.0.0.1:9/dead?serverSelectionTimeoutMS=500",
			500,
		);
		const started = performance.now();
		await expect(dead.insert([chatEvent("evt-dead")])).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(4000);
		expect(dead.healthy).toBe(false);
		await dead.close();
	});
});

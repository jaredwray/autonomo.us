import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.js";
import { createServer, releaseRequestResources } from "../src/server.js";
import { MongoTelemetrySink } from "../src/telemetry/mongo.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { type StubProvider, startStubProvider } from "./helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

// Full telemetry pipeline against a real MongoDB server (and the real
// OpenAI-compatible stub provider for the end-to-end route test).
const available = await mongoAvailable();
if (!available) {
	console.warn(
		"[telemetry.integration] no MongoDB at MONGODB_URI — skipping. Start it with: docker compose up -d mongo",
	);
}

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

describe.skipIf(!available)("TelemetryService + real MongoDB", () => {
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

	function trackedSink(prefix: string) {
		const url = uniqueMongoUrl(prefix);
		urls.push(url);
		return new MongoTelemetrySink(url);
	}

	it("flushes recorded chats into MongoDB and reads them back", async () => {
		const sink = trackedSink("flush");
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		telemetry.recordChat({
			model: "stub/chat-model",
			provider: "stub",
			usage,
			latencyMs: 100,
		});
		telemetry.recordChat({
			model: "stub/chat-model",
			provider: "stub",
			usage,
			latencyMs: 200,
		});

		expect(await telemetry.flush()).toBe(true);

		const summary = await telemetry.summaryFromSink();
		expect(summary?.source).toBe("mongodb");
		expect(summary?.totalRequests).toBe(2);
		expect(summary?.totalTokens).toBe(30);
		expect(summary?.avgLatencyMs).toBe(150);
		expect(summary?.byModel[0]).toMatchObject({
			model: "chat-model",
			provider: "stub",
		});
		expect(telemetry.sinkHealthy).toBe(true);
		await telemetry.close();
	});

	it("bootstraps the schema before querying an empty sink", async () => {
		const sink = trackedSink("fresh");
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		const summary = await telemetry.summaryFromSink();
		expect(summary?.source).toBe("mongodb");
		expect(summary?.totalRequests).toBe(0);
		expect(summary?.byModel).toEqual([]);
		await telemetry.close();
	});

	it("flushes inside the recording call when the interval is zero", async () => {
		const sink = trackedSink("immediate");
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 0 });
		telemetry.recordChat({
			model: "stub/chat-model",
			provider: "stub",
			usage,
			latencyMs: 40,
		});
		expect(await telemetry.drain()).toBe(true);
		const summary = await sink.querySummary();
		expect(summary.totalRequests).toBe(1);
		expect(summary.source).toBe("mongodb");
		await telemetry.close();
	});

	it("includes successful Auto selector calls in the default durable summary", async () => {
		const telemetry = new TelemetryService({
			sink: trackedSink("routing"),
			flushIntervalMs: 60_000,
		});
		const server = createServer({
			config: { providers: [], corsOrigins: [] },
			telemetry,
			logger: false,
		});
		try {
			telemetry.recordChat({
				operation: "routing",
				model: "jev/selector",
				provider: "jev",
				usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 },
				latencyMs: 100,
			});
			telemetry.recordChat({
				model: "work/chat",
				provider: "work",
				usage,
				latencyMs: 100,
			});
			const summary = (await server.inject("/v1/telemetry/summary")).json();
			const memory = telemetry.summary();
			expect(summary).toMatchObject({
				source: "mongodb",
				totalRequests: memory.totalRequests,
				totalTokens: memory.totalTokens,
				promptTokens: memory.promptTokens,
				completionTokens: memory.completionTokens,
			});
			expect(summary.totalTokens).toBe(37);
			expect(summary.byModel).toContainEqual(
				expect.objectContaining({
					model: "selector",
					provider: "jev",
					requests: 1,
					totalTokens: 22,
				}),
			);
		} finally {
			await server.close();
		}
	});
});

describe.skipIf(!available)("gateway → MongoDB end to end", () => {
	let provider: StubProvider;
	const databaseUrls: string[] = [];

	beforeAll(async () => {
		provider = await startStubProvider();
	});

	afterAll(async () => {
		await provider.close();
		for (const url of databaseUrls) {
			const client = new MongoClient(url, { serverSelectionTimeoutMS: 1500 });
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close().catch(() => {});
			}
		}
	});

	it("serves MongoDB-backed summaries for real chat traffic", async () => {
		const databaseUrl = uniqueMongoUrl("e2e");
		databaseUrls.push(databaseUrl);
		const sink = new MongoTelemetrySink(databaseUrl);
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });
		const server = createServer({
			registry: provider.registry,
			telemetry,
			logger: false,
		});

		const chat = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});
		expect(chat.statusCode).toBe(200);

		const response = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary",
		});
		expect(response.statusCode).toBe(200);
		const summary = JSON.parse(response.body);
		expect(summary.source).toBe("mongodb");
		expect(summary.totalRequests).toBe(1);
		expect(summary.totalTokens).toBe(15);
		expect(summary.byModel[0]).toMatchObject({
			model: "chat-model",
			provider: "stub",
		});

		const events = await server.inject({
			method: "GET",
			url: "/v1/telemetry/events?limit=5",
		});
		expect(JSON.parse(events.body).sink).toEqual({
			configured: true,
			healthy: true,
		});

		await server.close();
	});

	it("persists each request's telemetry before releasing the Worker's clients", async () => {
		const databaseUrl = uniqueMongoUrl("worker");
		databaseUrls.push(databaseUrl);
		const server = createServer({
			config: configFromEnv({ MONGODB_URI: databaseUrl }),
			registry: provider.registry,
			logger: false,
			releaseMongoPerRequest: true,
		});
		const payload = {
			model: "stub/chat-model",
			messages: [{ role: "user", content: "Hi" }],
		};
		// Reads through its own client so nothing leaks from the server's.
		const observer = new MongoTelemetrySink(databaseUrl);

		// The JSON route records telemetry inside the handler; the release must
		// wait for that flush before it closes the sink's client.
		const chat = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload,
		});
		expect(chat.statusCode).toBe(200);
		await releaseRequestResources(server);
		expect((await observer.querySummary()).totalRequests).toBe(1);

		// A streamed chat records telemetry after the headers went out, and the
		// sink reopens a client after the previous release closed it.
		const stream = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: { ...payload, stream: true },
		});
		expect(stream.statusCode).toBe(200);
		expect(stream.body).toContain("data: [DONE]");
		await releaseRequestResources(server);
		expect((await observer.querySummary()).totalRequests).toBe(2);

		const summary = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary",
		});
		expect(summary.json()).toMatchObject({
			source: "mongodb",
			totalRequests: 2,
			totalTokens: 30,
		});
		await releaseRequestResources(server);
		// Releasing with nothing open is a no-op rather than an error.
		await releaseRequestResources(server);

		await observer.close();
		await server.close();
	});
});

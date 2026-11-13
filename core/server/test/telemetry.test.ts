import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { MongoTelemetrySink } from "../src/telemetry/mongo.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { withSession } from "./auth-helpers.js";

// In-memory aggregation and route behavior without a sink. Sink behavior
// against a real MongoDB server lives in telemetry.integration.test.ts.

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

describe("TelemetryService", () => {
	it("aggregates per-model usage and latency for successes and errors", () => {
		const telemetry = new TelemetryService();
		telemetry.recordChat({
			model: "stub/a",
			provider: "stub",
			usage,
			latencyMs: 100,
		});
		telemetry.recordChat({
			model: "stub/a",
			provider: "stub",
			usage,
			latencyMs: 300,
		});
		telemetry.recordChat({
			model: "stub/b",
			provider: "stub",
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			latencyMs: 50,
			error: "boom",
		});

		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(3);
		expect(summary.totalErrors).toBe(1);
		expect(summary.promptTokens).toBe(20);
		expect(summary.completionTokens).toBe(10);
		expect(summary.totalTokens).toBe(30);
		expect(summary.avgLatencyMs).toBe(200);
		expect(summary.source).toBe("memory");

		expect(summary.byModel).toHaveLength(2);
		expect(summary.byModel[0]).toEqual({
			model: "a",
			provider: "stub",
			requests: 2,
			errors: 0,
			promptTokens: 20,
			completionTokens: 10,
			totalTokens: 30,
			avgLatencyMs: 200,
		});
		expect(summary.byModel[1]).toMatchObject({
			model: "b",
			requests: 1,
			errors: 1,
			avgLatencyMs: 0,
		});
	});

	it("caps the recent event ring buffer", () => {
		const telemetry = new TelemetryService({ maxRecent: 3 });
		for (let i = 0; i < 5; i++) {
			telemetry.recordChat({
				model: `stub/m${i}`,
				provider: "stub",
				usage,
				latencyMs: 1,
			});
		}
		const events = telemetry.recentEvents();
		expect(events).toHaveLength(3);
		expect(events[0].data.model).toBe("stub/m4");
	});

	it("folds distinct models beyond maxModels into an overflow bucket", () => {
		const telemetry = new TelemetryService({ maxModels: 2 });
		for (const model of ["stub/a", "stub/b", "stub/c", "stub/d"]) {
			telemetry.recordChat({ model, provider: "stub", usage, latencyMs: 10 });
		}
		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(4);
		expect(summary.byModel).toHaveLength(3);
		const other = summary.byModel.find((m) => m.model === "(other)");
		expect(other).toMatchObject({ requests: 2, provider: "other" });
	});

	it("holds queued events aside: dropped after a clear, requeued if it fails", async () => {
		const inserted: unknown[] = [];
		let failing = true;
		const sink = {
			healthy: true,
			ensureSchema: async () => {},
			insert: async (batch: unknown[]) => {
				if (failing) throw new Error("MongoDB went away");
				inserted.push(...batch);
			},
			close: async () => {},
		} as unknown as MongoTelemetrySink;
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 0 });
		const chat = { model: "stub/a", provider: "stub", usage, latencyMs: 100 };
		telemetry.recordChat(chat);
		expect(await telemetry.drain()).toBe(false);

		// A clear that fails puts the held events back, so nothing is lost.
		const held = telemetry.takePending();
		expect(held).toHaveLength(1);
		telemetry.restorePending(held);
		failing = false;
		expect(await telemetry.flush()).toBe(true);
		expect(inserted).toHaveLength(1);

		// A clear that succeeds drops them: a later flush writes nothing old.
		failing = true;
		telemetry.recordChat(chat);
		expect(await telemetry.drain()).toBe(false);
		expect(telemetry.takePending()).toHaveLength(1);
		failing = false;
		expect(await telemetry.flush()).toBe(true);
		expect(inserted).toHaveLength(1);
		// Later events still reach the sink.
		telemetry.recordChat(chat);
		expect(await telemetry.drain()).toBe(true);
		expect(inserted).toHaveLength(2);
		await telemetry.stop();
	});

	it("falls back to memory when the sink is unreachable", async () => {
		// Real network failure: nothing listens on port 9.
		const sink = new MongoTelemetrySink(
			"mongodb://127.0.0.1:9/unreachable",
			500,
		);
		const telemetry = new TelemetryService({ sink, flushIntervalMs: 60_000 });

		telemetry.recordChat({
			model: "stub/a",
			provider: "stub",
			usage,
			latencyMs: 100,
		});

		expect(await telemetry.flush()).toBe(false);
		expect(await telemetry.summaryFromSink()).toBeUndefined();
		// The complete picture is still served from memory.
		expect(telemetry.summary().totalRequests).toBe(1);
		expect(telemetry.sinkConfigured).toBe(true);
		expect(telemetry.sinkHealthy).toBe(false);
		await telemetry.stop();
	});
});

describe("telemetry routes (no sink)", () => {
	it("serves the memory summary and recent events", async () => {
		const telemetry = new TelemetryService();
		const server = await withSession(
			createServer({ telemetry, logger: false }),
		);

		telemetry.recordChat({
			model: "stub/chat-model",
			provider: "stub",
			usage,
			latencyMs: 12,
		});

		const summaryResponse = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary",
		});
		expect(summaryResponse.statusCode).toBe(200);
		const summary = JSON.parse(summaryResponse.body);
		expect(summary.totalRequests).toBe(1);
		expect(summary.source).toBe("memory");

		const memoryResponse = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary?source=memory",
		});
		expect(JSON.parse(memoryResponse.body).source).toBe("memory");

		const mongoResponse = await server.inject({
			method: "GET",
			url: "/v1/telemetry/summary?source=mongodb",
		});
		expect(mongoResponse.statusCode).toBe(503);

		const eventsResponse = await server.inject({
			method: "GET",
			url: "/v1/telemetry/events?limit=10",
		});
		expect(eventsResponse.statusCode).toBe(200);
		const events = JSON.parse(eventsResponse.body);
		expect(events.events).toHaveLength(1);
		expect(events.sink).toEqual({ configured: false, healthy: false });

		await server.close();
	});
});

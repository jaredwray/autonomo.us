import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

const summary = {
	totalRequests: 12500,
	totalErrors: 1,
	promptTokens: 90000,
	completionTokens: 30000,
	totalTokens: 120000,
	avgLatencyMs: 142,
	byModel: [
		{
			model: "claude-opus-4-8",
			provider: "anthropic",
			requests: 9000,
			errors: 0,
			promptTokens: 60000,
			completionTokens: 20000,
			totalTokens: 80000,
			avgLatencyMs: 150,
		},
		{
			model: "llama3.3",
			provider: "local",
			requests: 3500,
			errors: 1,
			promptTokens: 30000,
			completionTokens: 10000,
			totalTokens: 40000,
			avgLatencyMs: 120,
		},
	],
	source: "memory",
};

const events = {
	events: [
		{
			id: "evt-1",
			type: "gateway.chat",
			data: {
				model: "anthropic/claude-opus-4-8",
				totalTokens: 15,
				latencyMs: 120,
			},
			timestamp: "2026-07-17T12:00:00.000Z",
		},
		{
			id: "evt-2",
			type: "gateway.error",
			data: {
				model: "local/llama3.3",
				totalTokens: 0,
				latencyMs: 40,
				error: "connection refused",
			},
			timestamp: "2026-07-17T12:01:00.000Z",
		},
	],
	sink: { configured: true, healthy: true },
};

const models = {
	models: [
		{
			id: "anthropic/claude-opus-4-8",
			provider: "anthropic",
			model: "claude-opus-4-8",
		},
		{ id: "local/llama3.3", provider: "local", model: "llama3.3" },
	],
	providers: [
		{ name: "anthropic", kind: "anthropic" },
		{ name: "local", kind: "openai-compatible" },
	],
};

function jsonResponse(payload: unknown) {
	return {
		ok: true,
		status: 200,
		json: async () => payload,
	};
}

describe("App", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/telemetry/summary")) {
					return jsonResponse(summary);
				}
				if (url.includes("/v1/telemetry/events")) {
					return jsonResponse(events);
				}
				if (url.includes("/v1/models")) {
					return jsonResponse(models);
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("renders the heading and subtitle", async () => {
		render(<App />);
		expect(screen.getByText("autonomo.us")).toBeDefined();
		expect(screen.getByText("AI Platform Dashboard")).toBeDefined();
		await screen.findByText("API connected");
	});

	it("renders usage totals from the telemetry summary", async () => {
		render(<App />);
		expect(await screen.findByText("12.5K")).toBeDefined();
		expect(screen.getByText("Requests")).toBeDefined();
		expect(screen.getByText("120K")).toBeDefined();
		expect(screen.getByText("142 ms")).toBeDefined();
		expect(screen.getByText("90K prompt · 30K completion")).toBeDefined();
	});

	it("renders per-model usage with a legend", async () => {
		render(<App />);
		expect(await screen.findByText("claude-opus-4-8")).toBeDefined();
		expect(screen.getByText("llama3.3")).toBeDefined();
		expect(screen.getByText("Prompt tokens")).toBeDefined();
		expect(screen.getByText("Completion tokens")).toBeDefined();
	});

	it("renders recent events with statuses", async () => {
		render(<App />);
		const modelCells = await screen.findAllByText("anthropic/claude-opus-4-8");
		expect(modelCells.length).toBeGreaterThan(0);
		expect(screen.getByText("ok")).toBeDefined();
		expect(screen.getByText("error")).toBeDefined();
	});

	it("lists available models", async () => {
		render(<App />);
		const ids = await screen.findAllByText("local/llama3.3");
		expect(ids.length).toBeGreaterThan(0);
	});

	it("explains routing when a provider has no advertised models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/telemetry/summary")) {
					return jsonResponse(summary);
				}
				if (url.includes("/v1/telemetry/events")) {
					return jsonResponse(events);
				}
				if (url.includes("/v1/models")) {
					return jsonResponse({
						models: [],
						providers: [{ name: "local", kind: "openai-compatible" }],
					});
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
		render(<App />);
		expect(await screen.findByText(/No advertised models, but/)).toBeDefined();
		expect(screen.queryByText(/No providers configured/)).toBeNull();
	});

	it("shows an error banner when the API is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connection refused");
			}),
		);
		render(<App />);
		expect(await screen.findByText("API unreachable")).toBeDefined();
		expect(screen.getByText("Cannot reach the gateway API.")).toBeDefined();
	});
});

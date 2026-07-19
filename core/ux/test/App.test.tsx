import {
	type ApiConfig,
	createServer,
	TelemetryService,
} from "@autonomo.us/api";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

// The dashboard renders against a real gateway API server (no fetch mocks):
// each test boots @autonomo.us/api on an ephemeral port, seeds its telemetry
// through the public TelemetryService API, and points VITE_API_URL at it.

const BASE_CONFIG: ApiConfig = {
	providers: [
		{
			kind: "openai-compatible",
			name: "local",
			baseURL: "http://127.0.0.1:9/v1",
			models: ["llama3.3", "qwen3"],
		},
	],
	corsOrigins: ["*"],
};

type RunningApp = {
	telemetry: TelemetryService;
	url: string;
	close(): Promise<void>;
};

const running: RunningApp[] = [];

async function startApp(config: ApiConfig = BASE_CONFIG): Promise<RunningApp> {
	const telemetry = new TelemetryService();
	const server = createServer({ config, telemetry, logger: false });
	const url = await server.listen({ port: 0, host: "127.0.0.1" });
	vi.stubEnv("VITE_API_URL", url);
	const app: RunningApp = { telemetry, url, close: () => server.close() };
	running.push(app);
	return app;
}

function seedTraffic(telemetry: TelemetryService) {
	telemetry.recordChat({
		model: "local/llama3.3",
		provider: "local",
		usage: { promptTokens: 60000, completionTokens: 20000, totalTokens: 80000 },
		latencyMs: 100,
	});
	telemetry.recordChat({
		model: "local/qwen3",
		provider: "local",
		usage: { promptTokens: 60000, completionTokens: 20000, totalTokens: 80000 },
		latencyMs: 184,
	});
	telemetry.recordChat({
		model: "local/llama3.3",
		provider: "local",
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		latencyMs: 40,
		error: "connection refused",
	});
}

describe("App", () => {
	afterEach(async () => {
		cleanup();
		vi.unstubAllEnvs();
		while (running.length > 0) {
			await running.pop()?.close();
		}
	});

	it("renders the heading, subtitle, and live API status", async () => {
		await startApp();
		render(<App />);
		expect(screen.getByText("autonomo.us")).toBeDefined();
		expect(screen.getByText("AI Platform Dashboard")).toBeDefined();
		expect(await screen.findByText("API connected")).toBeDefined();
	});

	it("renders usage totals from the telemetry summary", async () => {
		const app = await startApp();
		seedTraffic(app.telemetry);
		render(<App />);

		expect(await screen.findByText("160K")).toBeDefined();
		expect(screen.getByText("Requests")).toBeDefined();
		expect(screen.getByText("3")).toBeDefined();
		expect(screen.getByText("142 ms")).toBeDefined();
		expect(screen.getByText("120K prompt · 40K completion")).toBeDefined();
	});

	it("renders per-model usage with a legend", async () => {
		const app = await startApp();
		seedTraffic(app.telemetry);
		render(<App />);

		expect(await screen.findByText("llama3.3")).toBeDefined();
		expect(screen.getByText("qwen3")).toBeDefined();
		expect(screen.getByText("Prompt tokens")).toBeDefined();
		expect(screen.getByText("Completion tokens")).toBeDefined();
	});

	it("renders recent events with statuses", async () => {
		const app = await startApp();
		seedTraffic(app.telemetry);
		render(<App />);

		const modelCells = await screen.findAllByText("local/llama3.3");
		expect(modelCells.length).toBeGreaterThan(0);
		expect(screen.getAllByText("ok").length).toBe(2);
		expect(screen.getByText("error")).toBeDefined();
	});

	it("lists available models", async () => {
		await startApp();
		render(<App />);
		const ids = await screen.findAllByText("local/llama3.3");
		expect(ids.length).toBeGreaterThan(0);
		// Appears in the models card and in the failover target picker.
		expect(screen.getAllByText("local/qwen3").length).toBeGreaterThan(0);
	});

	it("explains routing when a provider has no advertised models", async () => {
		await startApp({
			...BASE_CONFIG,
			providers: [
				{
					kind: "openai-compatible",
					name: "local",
					baseURL: "http://127.0.0.1:9/v1",
					models: [],
				},
			],
		});
		render(<App />);
		expect(await screen.findByText(/No advertised models, but/)).toBeDefined();
		expect(screen.queryByText(/No providers configured/)).toBeNull();
	});

	it("shows an error banner when the API is unreachable", async () => {
		// Real connection failure: nothing listens on this port.
		vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
		render(<App />);
		expect(await screen.findByText("API unreachable")).toBeDefined();
		expect(screen.getByText("Cannot reach the gateway API.")).toBeDefined();
	});

	it("loads the failover policy into the card", async () => {
		await startApp();
		render(<App />);

		expect(await screen.findByText("Failover policy")).toBeDefined();
		const toggle = (await screen.findByLabelText(
			"Enable failover",
		)) as HTMLInputElement;
		expect(toggle.checked).toBe(false);
		const timeout = screen.getByLabelText(
			/Attempt timeout/,
		) as HTMLInputElement;
		expect(timeout.value).toBe("30000");
	});

	it("saves failover policy changes through the real API", async () => {
		const app = await startApp();
		render(<App />);

		const toggle = (await screen.findByLabelText(
			"Enable failover",
		)) as HTMLInputElement;
		fireEvent.click(toggle);

		fireEvent.change(screen.getByLabelText(/Attempt timeout/), {
			target: { value: "5000" },
		});

		fireEvent.change(screen.getByLabelText("Fallback model to add"), {
			target: { value: "local/qwen3" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));

		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
		expect(await screen.findByText("Saved")).toBeDefined();

		// The policy round-tripped through the real gateway API.
		const response = await fetch(`${app.url}/v1/failover`);
		expect(await response.json()).toEqual({
			enabled: true,
			targets: ["local/qwen3"],
			timeoutMs: 5000,
		});
	});

	it("accepts a typed model id even when the provider advertises none", async () => {
		// Default Ollama-style setup: provider registered, no advertised models.
		await startApp({
			...BASE_CONFIG,
			providers: [
				{
					kind: "openai-compatible",
					name: "local",
					baseURL: "http://127.0.0.1:9/v1",
					models: [],
				},
			],
		});
		render(<App />);

		fireEvent.change(await screen.findByLabelText("Fallback model to add"), {
			target: { value: "  local/llama3.3  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));

		// Trimmed and listed as the first fallback.
		expect(screen.getByText("1.")).toBeDefined();
		expect(screen.getAllByText("local/llama3.3").length).toBeGreaterThan(0);
	});

	it("removes a fallback model from the target list", async () => {
		await startApp();
		render(<App />);

		fireEvent.change(await screen.findByLabelText("Fallback model to add"), {
			target: { value: "local/llama3.3" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(screen.getByText("1.")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(screen.queryByText("1.")).toBeNull();
		expect(screen.getByText(/No fallback models yet/)).toBeDefined();
	});

	it("surfaces API validation errors when saving fails", async () => {
		// Seed a policy, then remove the provider so saving it back fails
		// validation against the real registry.
		await startApp();
		render(<App />);

		fireEvent.change(await screen.findByLabelText("Fallback model to add"), {
			target: { value: "local/qwen3" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));

		// Swap the API for one with no providers registered; startApp points
		// VITE_API_URL at the new server, so the save lands there.
		await running.pop()?.close();
		await startApp({ ...BASE_CONFIG, providers: [] });

		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
		expect(await screen.findByText(/Unknown failover target/)).toBeDefined();
	});
});

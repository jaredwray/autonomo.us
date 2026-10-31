import {
	type ApiConfig,
	createServer,
	TelemetryService,
} from "@autonomo.us/api";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
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
	it("adds a second connection of the same provider and reuses only the selected connection", async () => {
		const app = await startApp({
			...BASE_CONFIG,
			providers: [
				{
					kind: "openai",
					name: "openai",
					apiKey: "default-secret",
					models: ["gpt-test"],
				},
			],
		});
		window.history.replaceState(null, "", "#/models");
		render(<App />);
		await screen.findByText("openai/gpt-test");
		fireEvent.click(screen.getByRole("button", { name: "Add model" }));
		fireEvent.change(screen.getByLabelText("Provider"), {
			target: { value: "openai" },
		});
		expect(
			(screen.getByLabelText("Connection") as HTMLSelectElement).value,
		).toBe("openai");
		fireEvent.change(screen.getByLabelText("Connection"), {
			target: { value: "" },
		});
		fireEvent.change(screen.getByLabelText("Connection name"), {
			target: { value: "openai-work" },
		});
		fireEvent.change(screen.getByLabelText("Model"), {
			target: { value: "gpt-test" },
		});
		const submit = () =>
			within(screen.getByRole("region", { name: "Add a model" })).getByRole(
				"button",
				{ name: "Add model" },
			);
		expect((submit() as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByLabelText("API key"), {
			target: { value: "work-secret" },
		});
		fireEvent.click(submit());
		await screen.findByText("openai-work/gpt-test is now active.");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined(),
		);
		expect(screen.getByText("openai/gpt-test")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add model" }));
		fireEvent.change(screen.getByLabelText("Provider"), {
			target: { value: "openai" },
		});
		fireEvent.change(screen.getByLabelText("Connection"), {
			target: { value: "openai-work" },
		});
		expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe(
			"",
		);
		fireEvent.change(screen.getByLabelText("Model"), {
			target: { value: "second-model" },
		});
		fireEvent.click(submit());
		await screen.findByText("openai-work/second-model is now active.");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined(),
		);
		const models = await (await fetch(`${app.url}/v1/models`)).json();
		expect(models.models.map((item: { id: string }) => item.id)).toEqual([
			"openai/gpt-test",
			"openai-work/gpt-test",
			"openai-work/second-model",
		]);
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "openai-work" },
		});
		expect(screen.queryByText("openai/gpt-test")).toBeNull();
		expect(screen.getByText("openai-work/gpt-test")).toBeDefined();
		expect(JSON.stringify(window.localStorage)).not.toContain("work-secret");
	});
	afterEach(async () => {
		cleanup();
		window.history.replaceState(null, "", "/");
		window.localStorage.clear();
		vi.unstubAllEnvs();
		while (running.length > 0) {
			await running.pop()?.close();
		}
	});

	it("renders the dashboard heading, brand and live API status", async () => {
		await startApp();
		render(<App />);
		expect(screen.getByRole("heading", { name: "Dashboard" })).toBeDefined();
		expect(
			screen.getByRole("link", { name: "autonomo.us home" }),
		).toBeDefined();
		expect(await screen.findByText("API connected")).toBeDefined();
	});

	it("collapses navigation, keeps accessible icon links, and remembers the preference", async () => {
		await startApp();
		const rendered = render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
		expect(
			screen
				.getByRole("button", { name: "Expand sidebar" })
				.getAttribute("aria-expanded"),
		).toBe("false");
		expect(
			screen.getByRole("link", { name: "Models" }).querySelector("svg"),
		).not.toBeNull();
		expect(window.localStorage.getItem("autonomous.sidebar.collapsed")).toBe(
			"true",
		);
		rendered.unmount();
		render(<App />);
		expect(
			screen.getByRole("button", { name: "Expand sidebar" }),
		).toBeDefined();
		fireEvent.click(screen.getByRole("link", { name: "Models" }));
		expect(
			await screen.findByRole("heading", { name: "Models" }),
		).toBeDefined();
		expect(
			screen.getByRole("link", { name: "Models" }).getAttribute("aria-current"),
		).toBe("page");
		fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
		expect(
			await screen.findByRole("heading", { name: "Dashboard" }),
		).toBeDefined();
	});

	it("opens the Models deep link and filters active models", async () => {
		await startApp();
		window.history.replaceState(null, "", "#/models");
		render(<App />);
		expect(await screen.findByText("local/llama3.3")).toBeDefined();
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "qwen" },
		});
		expect(screen.getByText("local/qwen3")).toBeDefined();
		expect(screen.queryByText("local/llama3.3")).toBeNull();
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "missing" },
		});
		expect(screen.getByText("No matching models")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect(screen.getByText("local/llama3.3")).toBeDefined();
	});

	for (const provider of [
		"google",
		"xai",
		"openai",
		"groq",
		"mistral",
		"deepseek",
		"openrouter",
		"cloudflare",
		"typesafe",
	]) {
		it(`adds a ${provider} model through the real API and reuses the saved key`, async () => {
			const app = await startApp({ ...BASE_CONFIG, providers: [] });
			window.history.replaceState(null, "", "#/models");
			render(<App />);
			expect(await screen.findByText("No active models yet")).toBeDefined();
			fireEvent.click(
				screen.getByRole("button", { name: "Add your first model" }),
			);
			fireEvent.change(screen.getByLabelText("Provider"), {
				target: { value: provider },
			});
			fireEvent.change(screen.getByLabelText("Model"), {
				target: { value: "test-model" },
			});
			if (provider === "cloudflare")
				fireEvent.change(screen.getByLabelText("Cloudflare Account ID"), {
					target: { value: "a".repeat(32) },
				});
			fireEvent.change(
				screen.getByLabelText(
					provider === "cloudflare" ? "API token" : "API key",
				),
				{
					target: { value: "test-secret-key" },
				},
			);
			fireEvent.click(
				within(screen.getByRole("region", { name: "Add a model" })).getByRole(
					"button",
					{ name: "Add model" },
				),
			);
			expect(
				await screen.findByText(`${provider}/test-model is now active.`),
			).toBeDefined();
			expect(screen.getByText(`${provider}/test-model`)).toBeDefined();
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined(),
			);
			fireEvent.click(screen.getByRole("button", { name: "Add model" }));
			fireEvent.change(screen.getByLabelText("Provider"), {
				target: { value: provider },
			});
			expect(
				(screen.getByLabelText(/API (key|token)/) as HTMLInputElement).value,
			).toBe("");
			fireEvent.change(screen.getByLabelText("Model"), {
				target: { value: "second-model" },
			});
			fireEvent.click(
				within(screen.getByRole("region", { name: "Add a model" })).getByRole(
					"button",
					{ name: "Add model" },
				),
			);
			expect(
				await screen.findByText(`${provider}/second-model is now active.`),
			).toBeDefined();
			const response = await fetch(`${app.url}/v1/models`);
			const text = await response.text();
			expect(text).toContain(`${provider}/second-model`);
			expect(text).not.toContain("test-secret-key");
			expect(JSON.stringify(window.localStorage)).not.toContain(
				"test-secret-key",
			);
		});
	}

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

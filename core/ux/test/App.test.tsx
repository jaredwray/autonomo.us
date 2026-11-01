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

	it("renders usage, reliability and estimated spending without configuration controls", async () => {
		const app = await startApp();
		seedTraffic(app.telemetry);
		render(<App />);
		const totals = await screen.findByRole("region", { name: "Usage totals" });
		expect(within(totals).getByText("160K")).toBeDefined();
		expect(within(totals).getByText("142 ms")).toBeDefined();
		expect(within(totals).getByText("66.7%")).toBeDefined();
		expect(
			within(totals).getByText("120K prompt · 40K completion"),
		).toBeDefined();
		expect(
			within(totals).getByText("0 of 3 calls priced · partial"),
		).toBeDefined();
		expect(
			screen.getByRole("heading", { name: "Users & callers" }),
		).toBeDefined();
		expect(screen.queryByText("Failover policy")).toBeNull();
		expect(screen.queryByText("Available models")).toBeNull();
		expect(screen.queryByLabelText("Enable failover")).toBeNull();
	});

	it("filters every breakdown by model and caller, then clears the filters", async () => {
		const app = await startApp();
		seedTraffic(app.telemetry);
		app.telemetry.recordChat({
			model: "local/qwen3",
			provider: "local",
			agentId: "support-agent",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			latencyMs: 20,
		});
		render(<App />);
		await screen.findByRole("region", { name: "Usage totals" });
		fireEvent.change(screen.getByLabelText("Caller"), {
			target: { value: "agent:support-agent" },
		});
		await waitFor(() =>
			expect(
				screen.getByRole("region", { name: "Usage totals" }).textContent,
			).toContain("15"),
		);
		expect(
			screen.getByRole("region", { name: "Usage by model" }).textContent,
		).not.toContain("local/llama3.3");
		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		await waitFor(() =>
			expect(
				screen.getByRole("region", { name: "Usage by model" }).textContent,
			).toContain("local/llama3.3"),
		);
		fireEvent.change(screen.getByLabelText("Model"), {
			target: { value: "local/llama3.3" },
		});
		await waitFor(() =>
			expect(
				screen.getByRole("region", { name: "Usage totals" }).textContent,
			).toContain("80K"),
		);
		expect(
			screen.getByRole("region", { name: "Usage by model" }).textContent,
		).not.toContain("local/qwen3");
	});

	it("uses date ranges to include older retained events and supports chart metrics", async () => {
		const app = await startApp();
		app.telemetry.record({
			id: "old",
			type: "gateway.chat",
			timestamp: new Date(Date.now() - 3 * 86400000).toISOString(),
			agentId: "older-agent",
			data: {
				model: "local/old-model",
				provider: "local",
				promptTokens: 50,
				completionTokens: 10,
				totalTokens: 60,
				latencyMs: 10,
			},
		});
		render(<App />);
		await screen.findByRole("heading", { name: "No activity in this period" });
		fireEvent.change(screen.getByLabelText("Period"), {
			target: { value: "7d" },
		});
		await waitFor(() =>
			expect(
				screen.getByRole("region", { name: "Usage by model" }).textContent,
			).toContain("local/old-model"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Spend", exact: true }));
		expect(
			screen
				.getByRole("button", { name: "Spend", exact: true })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(screen.getByText(/Unpriced calls are excluded/)).toBeDefined();
	});

	it("shows unknown costs separately from genuinely free model calls", async () => {
		const app = await startApp();
		app.telemetry.setPricingResolver((model) =>
			model === "local/llama3.3" ? { input: 0, output: 0 } : undefined,
		);
		seedTraffic(app.telemetry);
		render(<App />);
		const models = await screen.findByRole("region", {
			name: "Usage by model",
		});
		const free = within(models)
			.getByRole("button", { name: "local/llama3.3" })
			.closest("tr");
		const unknown = within(models)
			.getByRole("button", { name: "local/qwen3" })
			.closest("tr");
		expect(free?.textContent).toContain("$0.00");
		expect(unknown?.textContent).toContain("1 unpriced");
	});

	it("shows a retryable error without inventing zero usage when the API is unreachable", async () => {
		vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
		render(<App />);
		expect(await screen.findByText("Analytics unavailable")).toBeDefined();
		expect(screen.getByRole("alert").textContent).toContain(
			"No report is available",
		);
		expect(screen.queryByRole("region", { name: "Usage totals" })).toBeNull();
		expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
	});
});

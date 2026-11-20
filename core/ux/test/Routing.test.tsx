import { type ApiConfig, createServer } from "@autonomo.us/server";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { startOpenAIStub } from "../../server/test/openai-stub.js";
import { App } from "../src/App.js";
import { clearCredential } from "../src/api.js";
import { changeControl } from "./controls.js";
import {
	defaultWorkspaceId,
	routeToWorkspace,
	setUpOwner,
	stopServer,
} from "./session.js";

const cleanupTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
	cleanup();
	clearCredential();
	for (const task of cleanupTasks.splice(0)) await task();
	vi.unstubAllEnvs();
	window.history.replaceState(null, "", "/");
});
let owner: Record<string, string> = {};
let workspaceHash = "";
/**
 * Opens Routing, a tab of Models, at `hash`. Without `chat`, the workspace
 * has only Jev, which can decide but cannot answer.
 */
async function start({
	hash = "#/models/routing",
	chat = true,
}: {
	hash?: string;
	chat?: boolean;
} = {}) {
	const provider = await startOpenAIStub();
	const providers: ApiConfig["providers"] = [
		{
			kind: "openai-compatible",
			name: "work",
			models: ["chat"],
			baseURL: provider.url,
		},
		{
			kind: "openai-compatible",
			name: "personal",
			models: ["chat"],
			baseURL: provider.url,
		},
		{ kind: "typesafe", name: "jev", models: ["selector"], apiKey: "secret" },
	];
	const config: ApiConfig = {
		providers: chat
			? providers
			: providers.filter((item) => item.kind === "typesafe"),
		corsOrigins: ["*"],
	};
	const server = createServer({ config, logger: false });
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	cleanupTasks.push(
		() => stopServer(server),
		() => provider.close(),
	);
	vi.stubEnv("VITE_API_URL", url);
	const token = await setUpOwner(url);
	owner = { authorization: `Bearer ${token}` };
	const workspaceId = await defaultWorkspaceId(url, token);
	workspaceHash = `#/w/${encodeURIComponent(workspaceId)}`;
	routeToWorkspace(server, workspaceId);
	window.history.replaceState(null, "", hash);
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
	await screen.findByLabelText("Enable Auto routing");
	return server;
}
function change(label: string, value: string) {
	changeControl(screen.getByLabelText(label), { target: { value } });
}

it("saves a weighted account pool, uses it for a real request, and restores it when navigating back", async () => {
	const server = await start();
	expect(
		screen.getByRole("link", { name: "Models" }).getAttribute("aria-current"),
	).toBe("page");
	expect(
		screen.getByRole("tab", { name: "Routing", selected: true }),
	).toBeDefined();
	expect(window.location.hash).toBe(`${workspaceHash}/models/routing`);
	expect(screen.getByText(/Settings are temporary/)).toBeDefined();
	change("New pool name", "coding");
	fireEvent.click(screen.getByRole("button", { name: "Add pool" }));
	change("Pool member", "work/chat");
	fireEvent.click(screen.getByRole("button", { name: "Add member" }));
	change("Pool member", "personal/chat");
	fireEvent.click(screen.getByRole("button", { name: "Add member" }));
	change("Weight for work/chat", "3");
	expect(
		screen.getByLabelText("Routing mode").closest("fieldset")?.disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
	await screen.findByText("Routing saved");
	expect(
		(await server.inject({ url: "/v1/routing", headers: owner })).json().config
			.pools[0],
	).toMatchObject({
		id: "coding",
		members: [
			{ model: "work/chat", weight: 3 },
			{ model: "personal/chat", weight: 1 },
		],
	});
	change("Routing mode", "pool/coding");
	change("Request", "Hello");
	fireEvent.click(screen.getByRole("button", { name: "Send request" }));
	await screen.findByText("Hello there");
	expect(screen.getByText("work/chat", { selector: "strong" })).toBeDefined();
	fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
	await screen.findByRole("heading", { name: "Active models" });
	// Routing stays mounted but hidden while another tab shows.
	expect(
		screen.queryByRole("spinbutton", { name: "Weight for work/chat" }),
	).toBeNull();
	fireEvent.click(screen.getByRole("tab", { name: "Routing" }));
	await screen.findByRole("spinbutton", { name: "Weight for work/chat" });
	expect(
		(screen.getByLabelText("Weight for work/chat") as HTMLInputElement).value,
	).toBe("3");
});

it("selects Jev for Auto, limits its targets, and surfaces API validation failures", async () => {
	const server = await start();
	fireEvent.click(screen.getByLabelText("Enable Auto routing"));
	fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"Auto needs a decision model and at least two targets.",
	);
	change("Decision model", "jev/selector");
	for (const target of ["work/chat", "personal/chat"]) {
		change("Allowed target", target);
		fireEvent.click(screen.getByRole("button", { name: "Add target" }));
		change(
			`When to use ${target}`,
			target === "work/chat" ? "Coding" : "Writing",
		);
	}
	change("If the decision model fails, use", "personal/chat");
	fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
	await screen.findByText("Routing saved");
	expect(
		(await server.inject({ url: "/v1/routing", headers: owner })).json().config
			.auto,
	).toMatchObject({
		enabled: true,
		decisionModel: "jev/selector",
		fallbackTarget: "personal/chat",
	});
	const options = within(screen.getByLabelText("Allowed target")).queryByRole(
		"option",
		{ name: "jev/selector" },
	);
	expect(options).toBeNull();
});

it("saves an ordered model failover rule independently of the default", async () => {
	const server = await start();
	change("Model or pool for rule", "work/chat");
	fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
	const rule = within(
		screen.getByRole("region", { name: "Failover for work/chat" }),
	);
	changeControl(rule.getByLabelText("Fallback model"), {
		target: { value: "personal/chat" },
	});
	fireEvent.click(rule.getByRole("button", { name: "Add fallback" }));
	changeControl(rule.getByLabelText("Attempt timeout (ms)"), {
		target: { value: "5000" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
	await waitFor(() => expect(screen.getByText("Routing saved")).toBeDefined());
	const config = (
		await server.inject({ url: "/v1/routing", headers: owner })
	).json().config;
	expect(config.rules).toEqual([
		{
			model: "work/chat",
			enabled: true,
			targets: ["personal/chat"],
			timeoutMs: 5000,
		},
	]);
	expect(config.failover.enabled).toBe(false);
});

it("keeps Routing as a tab of Models, moved to with the arrow keys", async () => {
	await start();
	// Routing has no place of its own in the navigation any more.
	expect(screen.queryByRole("link", { name: "Routing" })).toBeNull();
	const routingTab = screen.getByRole("tab", { name: "Routing" });
	expect(routingTab.getAttribute("aria-controls")).toBe("models-panel");
	expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
		"models-tab-routing",
	);
	// The tabs, in order: language models, video, budgets, routing.
	expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
		"LLM",
		"Video",
		"Budget",
		"Routing",
	]);
	// Adding a model belongs to the LLM tab.
	expect(screen.queryByRole("button", { name: "Add model" })).toBeNull();
	routingTab.focus();
	fireEvent.keyDown(routingTab, { key: "ArrowLeft" });
	await waitFor(() =>
		expect(
			screen.getByRole("tab", { name: "Budget" }).getAttribute("aria-selected"),
		).toBe("true"),
	);
	expect(window.location.hash).toBe(`${workspaceHash}/models/budget`);
	fireEvent.keyDown(screen.getByRole("tab", { name: "Budget" }), {
		key: "Home",
	});
	const llmTab = screen.getByRole("tab", { name: "LLM" });
	await waitFor(() =>
		expect(llmTab.getAttribute("aria-selected")).toBe("true"),
	);
	expect(document.activeElement).toBe(llmTab);
	expect(llmTab.tabIndex).toBe(0);
	expect(screen.getByRole("tab", { name: "Routing" }).tabIndex).toBe(-1);
	expect(window.location.hash).toBe(`${workspaceHash}/models`);
	expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
		"models-tab-llm",
	);
	await screen.findByRole("button", { name: "Add model" });
	expect(
		screen.queryByRole("checkbox", { name: "Enable Auto routing" }),
	).toBeNull();
	fireEvent.keyDown(llmTab, { key: "End" });
	await screen.findByRole("checkbox", { name: "Enable Auto routing" });
	expect(document.activeElement).toBe(
		screen.getByRole("tab", { name: "Routing" }),
	);
	expect(window.location.hash).toBe(`${workspaceHash}/models/routing`);
});

it("opens the Routing tab from links to the former Routing view", async () => {
	await start({ hash: "#/routing" });
	expect(
		screen.getByRole("tab", { name: "Routing", selected: true }),
	).toBeDefined();
	await waitFor(() =>
		expect(window.location.hash).toBe(`${workspaceHash}/models/routing`),
	);
	fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
	await screen.findByRole("button", { name: "Add model" });
	// A link into the workspace, from before Routing joined Models.
	window.location.hash = `${workspaceHash}/routing`;
	await screen.findByRole("checkbox", { name: "Enable Auto routing" });
	expect(
		screen.getByRole("tab", { name: "Routing", selected: true }),
	).toBeDefined();
	await waitFor(() =>
		expect(window.location.hash).toBe(`${workspaceHash}/models/routing`),
	);
});

it("sends a workspace with no chat models to the LLM tab to add them", async () => {
	await start({ chat: false });
	fireEvent.click(
		screen.getByRole("link", {
			name: "Add a language model on the LLM tab",
		}),
	);
	expect(
		screen.getByRole("tab", { name: "LLM", selected: true }),
	).toBeDefined();
	expect(window.location.hash).toBe(`${workspaceHash}/models`);
	await screen.findByRole("button", { name: "Add model" });
});

import { type ApiConfig, createServer } from "@autonomo.us/api";
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
import { startOpenAIStub } from "../../api/test/openai-stub.js";
import { App } from "../src/App.js";

const cleanupTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
	cleanup();
	for (const task of cleanupTasks.splice(0)) await task();
	vi.unstubAllEnvs();
	window.history.replaceState(null, "", "/");
});
async function start() {
	const provider = await startOpenAIStub();
	const config: ApiConfig = {
		providers: [
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
		],
		corsOrigins: ["*"],
	};
	const server = createServer({ config, logger: false });
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	cleanupTasks.push(
		() => server.close(),
		() => provider.close(),
	);
	vi.stubEnv("VITE_API_URL", url);
	window.history.replaceState(null, "", "#/routing");
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
	await screen.findByLabelText("Enable Auto routing");
	return server;
}
function change(label: string, value: string) {
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

it("saves a weighted account pool, uses it for a real request, and restores it when navigating back", async () => {
	const server = await start();
	expect(
		screen.getByRole("link", { name: "Routing" }).getAttribute("aria-current"),
	).toBe("page");
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
		(await server.inject("/v1/routing")).json().config.pools[0],
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
	fireEvent.click(screen.getByRole("link", { name: "Models", exact: true }));
	fireEvent.click(screen.getByRole("link", { name: "Routing" }));
	await screen.findByLabelText("Weight for work/chat");
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
	expect((await server.inject("/v1/routing")).json().config.auto).toMatchObject(
		{
			enabled: true,
			decisionModel: "jev/selector",
			fallbackTarget: "personal/chat",
		},
	);
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
	fireEvent.change(rule.getByLabelText("Fallback model"), {
		target: { value: "personal/chat" },
	});
	fireEvent.click(rule.getByRole("button", { name: "Add fallback" }));
	fireEvent.change(rule.getByLabelText("Attempt timeout (ms)"), {
		target: { value: "5000" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
	await waitFor(() => expect(screen.getByText("Routing saved")).toBeDefined());
	const config = (await server.inject("/v1/routing")).json().config;
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

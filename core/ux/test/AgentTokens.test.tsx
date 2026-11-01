import { createServer } from "@autonomo.us/api";
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
import { App } from "../src/App.js";
import { clearOwnerCredential } from "../src/api.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	cleanup();
	clearOwnerCredential();
	for (const close of closers.splice(0)) await close();
	vi.unstubAllEnvs();
	window.history.replaceState(null, "", "/");
	window.localStorage.clear();
	window.sessionStorage.clear();
});
async function start(ownerToken?: string) {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"], ownerToken },
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => server.close());
	vi.stubEnv("VITE_API_URL", url);
	window.history.replaceState(null, "", "#/agent-tokens");
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
	return server;
}
const change = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
const create = () =>
	within(screen.getByRole("region", { name: "Create agent token" })).getByRole(
		"button",
		{ name: "Create token" },
	);

it("manages agent tokens with independent MCP permissions and a separate action log", async () => {
	const server = await start();
	await screen.findByText(/No agent tokens yet/);
	expect(
		screen
			.getByRole("link", { name: "Agent Tokens" })
			.getAttribute("aria-current"),
	).toBe("page");
	expect(screen.getByText(/MCP server is not available yet/)).toBeDefined();
	fireEvent.click(screen.getByRole("button", { name: "Create token" }));
	expect(screen.queryByRole("checkbox", { name: "Models: Read" })).toBeNull();
	for (const name of ["MCP: Read", "MCP: Call"])
		expect(
			(screen.getByRole("checkbox", { name }) as HTMLInputElement).checked,
		).toBe(false);
	change("Name", "Research agent");
	change("Description", "Weekly research through MCP");
	change("TTL", "never");
	fireEvent.click(screen.getByRole("checkbox", { name: "MCP: Read" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "MCP: Call" }));
	for (const name of ["MCP: Read", "MCP: Call"])
		expect(
			(screen.getByRole("checkbox", { name }) as HTMLInputElement).checked,
		).toBe(true);
	fireEvent.click(create());
	const first = (
		(await screen.findByLabelText("New agent token")) as HTMLTextAreaElement
	).value;
	expect(first).toMatch(/^agt_/);
	expect(JSON.stringify(window.localStorage)).not.toContain(first);
	expect(JSON.stringify(window.sessionStorage)).not.toContain(first);
	fireEvent.click(
		screen.getByRole("button", { name: "I’ve saved this token" }),
	);
	expect(screen.queryByLabelText("New agent token")).toBeNull();
	fireEvent.click(
		await screen.findByRole("button", { name: "Edit Research agent" }),
	);
	for (const name of ["MCP: Read", "MCP: Call"])
		expect(
			(screen.getByRole("checkbox", { name }) as HTMLInputElement).checked,
		).toBe(true);
	fireEvent.click(screen.getByRole("checkbox", { name: "MCP: Call" }));
	change("Name", "Research assistant");
	fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
	await screen.findByText("Token updated.");
	fireEvent.click(
		await screen.findByRole("button", { name: "Roll Research assistant" }),
	);
	change("New token TTL", "7");
	change("Keep previous token alive for", "custom");
	change("Overlap (hours)", "2");
	fireEvent.click(
		screen.getByRole("button", { name: "Roll token", exact: true }),
	);
	const second = (
		(await screen.findByLabelText("New agent token")) as HTMLTextAreaElement
	).value;
	expect(second).not.toBe(first);
	fireEvent.click(
		screen.getByRole("button", { name: "I’ve saved this token" }),
	);
	await waitFor(() =>
		expect(
			screen.getByRole("region", { name: "Your tokens" }).textContent,
		).toContain("Previous"),
	);
	const stored = (await server.inject("/v1/agent-tokens")).json();
	expect(stored.tokens[0]).toMatchObject({
		name: "Research assistant",
		permissions: ["mcp:read"],
		ttlDays: 7,
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Revoke Research assistant" }),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Revoke token", exact: true }),
	);
	await screen.findByText("Token revoked.");
	await waitFor(() =>
		expect(
			(
				screen.getByRole("button", {
					name: "Roll Research assistant",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true),
	);
	const log = screen.getByRole("region", { name: "Token action log" });
	for (const action of ["created", "updated", "rolled", "revoked"])
		expect(within(log).getByText(action)).toBeDefined();
	expect(log.textContent).not.toContain(first);
	expect(log.textContent).not.toContain(second);
	fireEvent.click(screen.getByRole("link", { name: "API Tokens" }));
	await screen.findByText(/No API tokens yet/);
	expect(screen.queryByText("Research assistant")).toBeNull();
	expect(screen.getByText("No token actions yet.")).toBeDefined();
});

it("clears an unsaved agent secret when navigating to API Tokens", async () => {
	await start();
	await screen.findByText(/No agent tokens yet/);
	fireEvent.click(screen.getByRole("button", { name: "Create token" }));
	change("Name", "Temporary agent");
	fireEvent.click(create());
	await screen.findByLabelText("New agent token");
	fireEvent.click(screen.getByRole("link", { name: "API Tokens" }));
	await screen.findByText(/No API tokens yet/);
	expect(screen.queryByLabelText("New agent token")).toBeNull();
	fireEvent.click(screen.getByRole("link", { name: "Agent Tokens" }));
	await screen.findByRole("button", { name: "Edit Temporary agent" });
	expect(screen.queryByLabelText("New agent token")).toBeNull();
});

it("requires owner sign-in and clears agent secrets when the dashboard locks", async () => {
	await start("owner-for-agents");
	await screen.findByLabelText("Owner credential");
	change("Owner credential", "owner-for-agents");
	fireEvent.click(screen.getByRole("button", { name: "Connect" }));
	await screen.findByText(/No agent tokens yet/);
	fireEvent.click(screen.getByRole("button", { name: "Create token" }));
	change("Name", "Owner agent");
	fireEvent.click(create());
	const secret = (
		(await screen.findByLabelText("New agent token")) as HTMLTextAreaElement
	).value;
	fireEvent.click(screen.getByRole("button", { name: "Lock dashboard" }));
	await screen.findByLabelText("Owner credential");
	expect(screen.queryByLabelText("New agent token")).toBeNull();
	expect(document.body.textContent).not.toContain(secret);
});

import { createServer } from "@autonomo.us/server";
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
import { clearCredential } from "../src/api.js";
import {
	defaultWorkspaceId,
	PASSWORD,
	setUpOwner,
	stopServer,
} from "./session.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	cleanup();
	clearCredential();
	for (const close of closers.splice(0)) await close();
	vi.unstubAllEnvs();
	window.localStorage.clear();
	window.history.replaceState(null, "", "/");
});

async function start(hash: string) {
	const server = createServer({
		config: {
			providers: [
				{
					kind: "openai-compatible",
					name: "envstub",
					baseURL: "http://127.0.0.1:1/v1",
					models: ["chat-model"],
				},
			],
			corsOrigins: ["*"],
		},
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => stopServer(server));
	vi.stubEnv("VITE_API_URL", url);
	const token = await setUpOwner(url);
	const defaultId = await defaultWorkspaceId(url, token);
	window.history.replaceState(null, "", hash);
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
	return { url, token, defaultId };
}

it("creates a workspace, switches to it, and scopes every view to it", async () => {
	const { defaultId } = await start("#/workspaces");
	// With one workspace the switcher shows its name without a menu.
	await screen.findByRole("heading", { name: "Workspaces" });
	expect(screen.queryByRole("button", { name: /Switch workspace/ })).toBeNull();
	fireEvent.click(await screen.findByRole("button", { name: "New workspace" }));
	const form = within(
		screen.getByRole("region", { name: "Create a workspace" }),
	);
	fireEvent.change(form.getByLabelText("Name"), {
		target: { value: "Hyphen" },
	});
	fireEvent.click(form.getByRole("button", { name: "Create workspace" }));
	expect((await screen.findByRole("status")).textContent).toContain(
		"Hyphen was created.",
	);
	const table = within(screen.getByRole("region", { name: "All workspaces" }));
	await table.findByText("Hyphen");

	// The switcher now lists both workspaces.
	const switcher = await screen.findByRole("button", {
		name: "Workspace: Default. Switch workspace",
	});
	fireEvent.click(switcher);
	fireEvent.click(screen.getByRole("link", { name: /Hyphen/ }));
	await screen.findByRole("button", {
		name: "Workspace: Hyphen. Switch workspace",
	});
	expect(window.location.hash).toMatch(/^#\/w\/[0-9a-f-]{36}\/dashboard$/);

	// Models in a new workspace start empty; environment keys stay in Default.
	window.location.hash = "#/models";
	expect(await screen.findByText("No active models yet")).toBeDefined();
	expect(
		screen.getByText(
			/Keys set as environment variables belong to the Default workspace/,
		),
	).toBeDefined();
	await waitFor(() => {
		expect(window.location.hash).toMatch(/^#\/w\/[0-9a-f-]{36}\/models$/);
		expect(window.location.hash).not.toContain(defaultId);
	});
	expect(
		screen.getByRole("button", { name: "Workspace: Hyphen. Switch workspace" }),
	).toBeDefined();

	// API tokens name their workspace and its base path.
	fireEvent.click(screen.getByRole("link", { name: "API Tokens" }));
	await screen.findByRole("heading", { name: "API Tokens" });
	const scope = await screen.findByText(/Tokens in the/);
	expect(scope.textContent).toContain("Hyphen");
	expect(scope.textContent).not.toContain(defaultId);

	// Switching back to Default shows its environment model.
	fireEvent.click(
		screen.getByRole("button", { name: "Workspace: Hyphen. Switch workspace" }),
	);
	fireEvent.click(screen.getByRole("link", { name: /Default/ }));
	await screen.findByRole("button", {
		name: "Workspace: Default. Switch workspace",
	});
	fireEvent.click(screen.getByRole("link", { name: "Models" }));
	expect(await screen.findByText("envstub/chat-model")).toBeDefined();
	expect(window.location.hash).toBe(`#/w/${defaultId}/models`);
});

it("adds a member to a workspace from Team and lists their access", async () => {
	const { url, token } = await start("#/team");
	const created = await fetch(`${url}/v1/workspaces`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ name: "Film" }),
	});
	expect(created.status).toBe(201);
	fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
	const form = within(screen.getByRole("region", { name: "Add a member" }));
	fireEvent.change(form.getByLabelText("Email"), {
		target: { value: "grace@example.com" },
	});
	fireEvent.change(form.getByLabelText("Name"), {
		target: { value: "Grace" },
	});
	// Members join the current workspace unless another is chosen.
	expect(
		(form.getByLabelText("Workspace") as HTMLSelectElement).value,
	).not.toBe("");
	fireEvent.change(form.getByLabelText("Workspace role"), {
		target: { value: "admin" },
	});
	for (const label of ["Initial password", "Confirm password"])
		fireEvent.change(form.getByLabelText(label), {
			target: { value: PASSWORD },
		});
	fireEvent.click(form.getByRole("button", { name: "Add member" }));
	const members = within(
		await screen.findByRole("region", { name: "Members" }),
	);
	const row = (await members.findByText("Grace")).closest("tr");
	await waitFor(() => expect(row?.textContent).toContain("Default (Admin)"));
	expect(members.getByText("Founder").closest("tr")?.textContent).toContain(
		"All workspaces",
	);
});

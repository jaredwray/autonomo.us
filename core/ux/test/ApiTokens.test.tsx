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
	window.history.replaceState(null, "", "#/api-tokens");
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
	return server;
}
const change = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });

it("creates, edits, rolls with custom overlap, and revokes a token with a bottom action log", async () => {
	const server = await start();
	await screen.findByText(/No API tokens yet/);
	expect(
		screen
			.getByRole("link", { name: "API Tokens" })
			.getAttribute("aria-current"),
	).toBe("page");
	expect(
		screen.getByText(/Tokens and action history are temporary/),
	).toBeDefined();
	fireEvent.click(
		screen.getByRole("button", { name: "Create token", exact: true }),
	);
	const form = within(screen.getByRole("region", { name: "Create API token" }));
	expect(
		(form.getByRole("button", { name: "Create token" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	expect(
		within(screen.getByLabelText("TTL"))
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["1 day", "7 days", "30 days", "180 days", "Never"]);
	change("Name", "Production");
	change("Description", "My gateway client");
	change("TTL", "never");
	fireEvent.click(form.getByRole("button", { name: "Create token" }));
	const first = (
		(await screen.findByLabelText("New API token")) as HTMLTextAreaElement
	).value;
	expect(first).toMatch(/^aut_/);
	expect(JSON.stringify(window.localStorage)).not.toContain(first);
	expect(JSON.stringify(window.sessionStorage)).not.toContain(first);
	fireEvent.click(
		screen.getByRole("button", { name: "I’ve saved this token" }),
	);
	expect(screen.queryByLabelText("New API token")).toBeNull();
	await screen.findByRole("button", { name: "Edit Production" });
	fireEvent.click(screen.getByRole("button", { name: "Edit Production" }));
	change("Name", "Production app");
	change("Description", "Updated client");
	fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
	await screen.findByText("Token updated.");
	fireEvent.click(
		await screen.findByRole("button", { name: "Roll Production app" }),
	);
	change("New token TTL", "7");
	change("Keep previous token alive for", "custom");
	change("Overlap (hours)", "2");
	fireEvent.click(
		screen.getByRole("button", { name: "Roll token", exact: true }),
	);
	const second = (
		(await screen.findByLabelText("New API token")) as HTMLTextAreaElement
	).value;
	expect(second).not.toBe(first);
	for (const secret of [first, second])
		expect(
			(
				await server.inject({
					url: "/v1/models",
					headers: { authorization: `Bearer ${secret}` },
				})
			).statusCode,
		).toBe(200);
	fireEvent.click(
		screen.getByRole("button", { name: "I’ve saved this token" }),
	);
	await waitFor(() =>
		expect(
			screen.getByRole("region", { name: "Your tokens" }).textContent,
		).toContain("Previous"),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Revoke Production app" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(
		(
			await server.inject({
				url: "/v1/models",
				headers: { authorization: `Bearer ${second}` },
			})
		).statusCode,
	).toBe(200);
	fireEvent.click(
		screen.getByRole("button", { name: "Revoke Production app" }),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Revoke token", exact: true }),
	);
	await screen.findByText("Token revoked.");
	await waitFor(() =>
		expect(
			(
				screen.getByRole("button", {
					name: "Roll Production app",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true),
	);
	for (const secret of [first, second])
		expect(
			(
				await server.inject({
					url: "/v1/models",
					headers: { authorization: `Bearer ${secret}` },
				})
			).statusCode,
		).toBe(401);
	const log = within(screen.getByRole("region", { name: "Token action log" }));
	for (const action of ["created", "updated", "rolled", "revoked"])
		expect(log.getByText(action)).toBeDefined();
	expect(
		screen.getByRole("region", { name: "Token action log" }).nextElementSibling,
	).toBeNull();
	expect(
		screen.getByRole("region", { name: "Token action log" }).textContent,
	).not.toContain(first);
	fireEvent.click(screen.getByRole("link", { name: "Models", exact: true }));
	fireEvent.click(screen.getByRole("link", { name: "API Tokens" }));
	await screen.findByRole("button", { name: "Roll Production app" });
	expect(screen.queryByLabelText("New API token")).toBeNull();
});

it("connects with the owner credential, rejects an invalid credential, and clears access when locked", async () => {
	await start("owner-test-secret");
	await screen.findByLabelText("Owner credential");
	change("Owner credential", "bad-credential");
	fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Enter a valid owner credential.",
	);
	change("Owner credential", "owner-test-secret");
	fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
	await screen.findByText(/No API tokens yet/);
	expect(screen.queryByText(/Authentication is disabled/)).toBeNull();
	expect(JSON.stringify(window.localStorage)).not.toContain(
		"owner-test-secret",
	);
	expect(JSON.stringify(window.sessionStorage)).not.toContain(
		"owner-test-secret",
	);
	fireEvent.click(screen.getByRole("link", { name: "Routing", exact: true }));
	await screen.findByLabelText("Enable Auto routing");
	fireEvent.click(screen.getByRole("button", { name: "Lock dashboard" }));
	await screen.findByLabelText("Owner credential");
	expect(
		(screen.getByLabelText("Owner credential") as HTMLInputElement).value,
	).toBe("");
});

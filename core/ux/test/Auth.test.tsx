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
import { clearCredential } from "../src/api.js";
import { PASSWORD, setUpOwner } from "./session.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	cleanup();
	clearCredential();
	for (const close of closers.splice(0)) await close();
	vi.unstubAllEnvs();
	window.history.replaceState(null, "", "/");
	window.localStorage.clear();
});
async function start(setupToken?: string) {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"], setupToken },
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => server.close());
	vi.stubEnv("VITE_API_URL", url);
	return { server, url };
}
function renderApp() {
	return render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
const change = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });

it("defaults a fresh gateway to first-run setup and keeps the owner signed in", async () => {
	await start();
	window.history.replaceState(null, "", "#/models");
	const rendered = renderApp();
	expect(
		await screen.findByRole("heading", { name: "Create your account" }),
	).toBeDefined();
	expect(screen.queryByRole("navigation")).toBeNull();
	expect(
		screen.getByText(/accounts last only until the API restarts/),
	).toBeDefined();
	change("Your name", "Ada Lovelace");
	change("Email", "ada@example.com");
	change("Password", "short");
	change("Confirm password", "short");
	fireEvent.click(screen.getByRole("button", { name: "Create account" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Use at least 12 characters.",
	);
	change("Password", PASSWORD);
	change("Confirm password", `${PASSWORD}!`);
	fireEvent.click(screen.getByRole("button", { name: "Create account" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"The passwords don't match.",
	);
	change("Confirm password", PASSWORD);
	fireEvent.click(screen.getByRole("button", { name: "Create account" }));

	// Setup lands on Team, signed in as the first owner.
	expect(await screen.findByRole("heading", { name: "Team" })).toBeDefined();
	const members = within(screen.getByRole("region", { name: "Members" }));
	const row = (await members.findByText("Ada Lovelace")).closest("tr");
	expect(row?.textContent).toContain("You");
	expect(row?.textContent).toContain("Owner");
	expect(row?.textContent).toContain("Created the gateway");
	expect(JSON.stringify(window.localStorage)).not.toContain(PASSWORD);
	expect(window.localStorage.getItem("autonomous.session")).toMatch(/^ses_/);

	// A reload keeps the session.
	rendered.unmount();
	renderApp();
	expect(await screen.findByRole("heading", { name: "Team" })).toBeDefined();
	expect(screen.getByText("ada@example.com")).toBeDefined();

	fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
	expect(await screen.findByRole("heading", { name: "Sign in" })).toBeDefined();
	expect(window.localStorage.getItem("autonomous.session")).toBeNull();
	change("Email", "ada@example.com");
	change("Password", "not my password");
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Incorrect email or password.",
	);
	expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
		"",
	);
	change("Password", PASSWORD);
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	expect(await screen.findByRole("heading", { name: "Team" })).toBeDefined();
});

it("asks for SETUP_TOKEN before setup when it is configured", async () => {
	await start("setup-secret");
	renderApp();
	expect(
		await screen.findByRole("heading", { name: "Welcome to autonomo.us" }),
	).toBeDefined();
	expect(screen.getByText("Step 1 of 2")).toBeDefined();
	change("Setup token", "wrong");
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Enter the SETUP_TOKEN configured on the API.",
	);
	change("Setup token", "setup-secret");
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	expect(
		await screen.findByRole("heading", { name: "Create your account" }),
	).toBeDefined();
	change("Your name", "Grace");
	change("Email", "grace@example.com");
	change("Password", PASSWORD);
	change("Confirm password", PASSWORD);
	fireEvent.click(screen.getByRole("button", { name: "Create account" }));
	expect(await screen.findByRole("heading", { name: "Team" })).toBeDefined();
	expect(JSON.stringify(window.localStorage)).not.toContain("setup-secret");
	expect(screen.queryByRole("button", { name: /Lock dashboard/ })).toBeNull();
});

it("invites a member with a one-time link that creates their account", async () => {
	const { url } = await start();
	await setUpOwner(url);
	window.history.replaceState(null, "", "#/team");
	renderApp();
	fireEvent.click(await screen.findByRole("button", { name: "Invite member" }));
	const form = within(
		screen.getByRole("region", { name: "Create an invite link" }),
	);
	fireEvent.change(form.getByLabelText("Role"), {
		target: { value: "admin" },
	});
	fireEvent.click(form.getByRole("button", { name: "Create link" }));
	const link = (
		(await screen.findByLabelText("Invite link")) as HTMLTextAreaElement
	).value;
	expect(link).toMatch(/#\/invite\/inv_[0-9a-f-]{36}_[\w-]{43}$/);
	fireEvent.click(screen.getByRole("button", { name: "Done" }));
	const invites = within(screen.getByRole("region", { name: "Invite links" }));
	await waitFor(() =>
		expect(invites.getByText("pending").closest("tr")?.textContent).toContain(
			"Admin",
		),
	);
	expect(document.body.textContent).not.toContain(link.split("/").at(-1));

	// The invitee opens the link in a fresh browser.
	fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
	await screen.findByRole("heading", { name: "Sign in" });
	cleanup();
	window.history.replaceState(null, "", link.slice(link.indexOf("#")));
	renderApp();
	expect(
		await screen.findByRole("heading", { name: "Join your team" }),
	).toBeDefined();
	await screen.findByLabelText("Your name (optional)");
	expect(
		screen.getByRole("region", { name: "Join your team" }).textContent,
	).toContain("Founder invited you to join as Admin");
	change("Your name (optional)", "Grace Hopper");
	change("Email", "founder@example.com");
	change("Password", PASSWORD);
	change("Confirm password", PASSWORD);
	fireEvent.click(screen.getByRole("button", { name: "Join team" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"A team member with this email already exists.",
	);
	change("Email", "grace@example.com");
	fireEvent.click(screen.getByRole("button", { name: "Join team" }));
	expect(
		await screen.findByRole("heading", { name: "Dashboard" }),
	).toBeDefined();
	expect(window.location.hash).toBe("#/dashboard");
	fireEvent.click(screen.getByRole("link", { name: "Team" }));
	const row = (
		await within(
			await screen.findByRole("region", { name: "Members" }),
		).findByText("Grace Hopper")
	).closest("tr");
	expect(row?.textContent).toContain("You");
	expect(row?.textContent).toContain("Admin");
	expect(row?.textContent).toContain("Invited by Founder");

	// The link works once.
	cleanup();
	window.history.replaceState(null, "", link.slice(link.indexOf("#")));
	renderApp();
	expect(
		await screen.findByRole("heading", { name: "Invite unavailable" }),
	).toBeDefined();
	fireEvent.click(screen.getByRole("button", { name: "Go to sign in" }));
	expect(
		await screen.findByRole("heading", { name: "Dashboard" }),
	).toBeDefined();
});

it("shows a replacement invite after an invalid link in the same tab", async () => {
	const { server, url } = await start();
	const owner = await setUpOwner(url, { signIn: false });
	const { token } = (
		await server.inject({
			method: "POST",
			url: "/v1/team/invites",
			headers: { authorization: `Bearer ${owner}` },
			payload: { role: "member", ttlDays: 1 },
		})
	).json();
	window.history.replaceState(null, "", "#/invite/inv_not-a-real-token");
	renderApp();
	expect(
		await screen.findByRole("heading", { name: "Invite unavailable" }),
	).toBeDefined();
	window.location.hash = `#/invite/${token}`;
	expect(
		await screen.findByRole("heading", { name: "Join your team" }),
	).toBeDefined();
	expect(await screen.findByLabelText("Your name (optional)")).toBeDefined();
	expect(screen.queryByRole("alert")).toBeNull();
});

it("adds, edits, resets, and removes members and changes your own password", async () => {
	const { server, url } = await start();
	await setUpOwner(url);
	window.history.replaceState(null, "", "#/team");
	renderApp();
	fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
	let form = within(screen.getByRole("region", { name: "Add a member" }));
	fireEvent.change(form.getByLabelText("Email"), {
		target: { value: "linus@example.com" },
	});
	fireEvent.change(form.getByLabelText("Name"), { target: { value: "Linus" } });
	fireEvent.change(form.getByLabelText("Initial password"), {
		target: { value: PASSWORD },
	});
	fireEvent.change(form.getByLabelText("Confirm password"), {
		target: { value: PASSWORD },
	});
	fireEvent.click(form.getByRole("button", { name: "Add member" }));
	expect((await screen.findByRole("status")).textContent).toContain(
		"Linus was added.",
	);
	const members = within(screen.getByRole("region", { name: "Members" }));
	expect(
		(await members.findByText("Linus")).closest("tr")?.textContent,
	).toContain("Added by Founder");

	fireEvent.click(screen.getByRole("button", { name: "Edit Linus" }));
	form = within(screen.getByRole("region", { name: "Edit Linus" }));
	fireEvent.change(form.getByLabelText("Role"), {
		target: { value: "admin" },
	});
	fireEvent.click(form.getByRole("button", { name: "Save changes" }));
	await screen.findByText("Member updated.");
	await waitFor(() =>
		expect(members.getByText("Linus").closest("tr")?.textContent).toContain(
			"Admin",
		),
	);

	fireEvent.click(
		screen.getByRole("button", { name: "Reset password for Linus" }),
	);
	form = within(
		screen.getByRole("region", { name: "Reset password for Linus" }),
	);
	fireEvent.change(form.getByLabelText("New password"), {
		target: { value: "a reset passphrase" },
	});
	fireEvent.change(form.getByLabelText("Confirm password"), {
		target: { value: "a reset passphrase" },
	});
	fireEvent.click(form.getByRole("button", { name: "Reset password" }));
	await screen.findByText(/Password reset for Linus/);
	const signIn = await server.inject({
		method: "POST",
		url: "/v1/auth/session",
		payload: { email: "linus@example.com", password: "a reset passphrase" },
	});
	expect(signIn.statusCode).toBe(201);

	fireEvent.click(screen.getByRole("button", { name: "Remove Linus" }));
	form = within(screen.getByRole("region", { name: "Remove Linus" }));
	fireEvent.click(form.getByRole("button", { name: "Remove member" }));
	await screen.findByText("Linus was removed.");
	await waitFor(() => expect(members.queryByText("Linus")).toBeNull());
	// The owner cannot remove or reset themselves from the table.
	expect(screen.queryByRole("button", { name: "Remove Founder" })).toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "Change password" }));
	form = within(screen.getByRole("region", { name: "Change your password" }));
	fireEvent.change(form.getByLabelText("Current password"), {
		target: { value: "wrong password" },
	});
	fireEvent.change(form.getByLabelText("New password"), {
		target: { value: "my new passphrase" },
	});
	fireEvent.change(form.getByLabelText("Confirm password"), {
		target: { value: "my new passphrase" },
	});
	fireEvent.click(form.getByRole("button", { name: "Change password" }));
	expect((await form.findByRole("alert")).textContent).toBe(
		"Your current password is incorrect.",
	);
	fireEvent.change(form.getByLabelText("Current password"), {
		target: { value: PASSWORD },
	});
	fireEvent.click(form.getByRole("button", { name: "Change password" }));
	await screen.findByText(/Password changed/);
	expect(
		(
			await server.inject({
				method: "POST",
				url: "/v1/auth/session",
				payload: {
					email: "founder@example.com",
					password: "my new passphrase",
				},
			})
		).statusCode,
	).toBe(201);
});

it("shows members a read-only team and sends signed-out users back to sign in", async () => {
	const { server, url } = await start();
	const owner = await setUpOwner(url, { signIn: false });
	await server.inject({
		method: "POST",
		url: "/v1/team",
		headers: { authorization: `Bearer ${owner}` },
		payload: {
			email: "member@example.com",
			name: "Member",
			role: "member",
			password: PASSWORD,
		},
	});
	window.history.replaceState(null, "", "#/team");
	renderApp();
	await screen.findByRole("heading", { name: "Sign in" });
	change("Email", "member@example.com");
	change("Password", PASSWORD);
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	expect(await screen.findByRole("heading", { name: "Team" })).toBeDefined();
	expect(
		await screen.findByText("Only owners and admins can change the team."),
	).toBeDefined();
	expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Edit Founder" })).toBeNull();
	expect(screen.getByRole("button", { name: "Change password" })).toBeDefined();
	// Members don't manage tokens: the pages are hidden and their links fall back.
	expect(screen.queryByRole("link", { name: "API Tokens" })).toBeNull();
	expect(screen.queryByRole("link", { name: "Agent Tokens" })).toBeNull();

	// Removing the member ends their session on the next request.
	const team = (
		await server.inject({
			url: "/v1/team",
			headers: { authorization: `Bearer ${owner}` },
		})
	).json();
	const member = team.members.find(
		(item: { email: string }) => item.email === "member@example.com",
	);
	await server.inject({
		method: "DELETE",
		url: `/v1/team/${member.id}`,
		headers: { authorization: `Bearer ${owner}` },
	});
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	expect(await screen.findByRole("heading", { name: "Sign in" })).toBeDefined();
});

it("explains when the gateway cannot be reached and retries", async () => {
	vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
	renderApp();
	expect(
		await screen.findByRole("heading", { name: "Can't reach the gateway" }),
	).toBeDefined();
	expect(screen.getByRole("alert").textContent).toBe(
		"The gateway API could not be reached.",
	);
	const { url } = await start();
	vi.stubEnv("VITE_API_URL", url);
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(
		await screen.findByRole("heading", { name: "Create your account" }),
	).toBeDefined();
});

import type {
	ProxyConnection,
	ProxyList,
	WebFetchResult,
	WebPolicy,
} from "@autonomo.us/common";
import { createServer } from "@autonomo.us/server";
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
import { clearCredential, setCurrentWorkspace } from "../src/api.js";
import {
	normalizeHost,
	ProxiesView,
	policyProblem,
	usd,
} from "../src/ProxiesView.js";
import { changeControl } from "./controls.js";
import { defaultWorkspaceId, setUpOwner, stopServer } from "./session.js";

// The Proxies view against a fake gateway: each test holds the workspace's
// proxy state and answers the dashboard's requests from it, recording what
// was sent. No provider is ever called.

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const base = `/v1/${WORKSPACE}`;

function connection(
	overrides: Partial<ProxyConnection> & Pick<ProxyConnection, "name" | "kind">,
): ProxyConnection {
	return {
		keyConfigured: true,
		enabled: true,
		monthlyRequestCap: null,
		source: "saved",
		usage: { month: "2026-11", requests: 0, costUsd: 0 },
		problem: null,
		...overrides,
	};
}

function policy(overrides: Partial<WebPolicy> = {}): WebPolicy {
	return {
		ladder: [{ kind: "direct" }],
		domains: [],
		allowOnly: false,
		callerProxyRequestsPerDay: 100,
		monthlyBudgetUsd: 25,
		revision: 3,
		...overrides,
	};
}

function list(overrides: Partial<ProxyList> = {}): ProxyList {
	return {
		connections: [],
		policy: policy(),
		budget: { month: "2026-11", spentUsd: 0, limitUsd: 25 },
		persistence: "memory",
		available: true,
		...overrides,
	};
}

type Call = { method: string; path: string; body?: Record<string, unknown> };
type Handler = (call: Call) => Response | undefined;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
const failure = (status: number, message: string) =>
	json({ error: { message } }, status);

/** Answers GET /proxies from `state` and anything else from `handler`. */
function fakeGateway(
	state: { list: ProxyList },
	handler: Handler = () => undefined,
) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		const method = init?.method ?? "GET";
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const call = { method, path, body };
		calls.push(call);
		const answer = handler(call);
		if (answer) return answer;
		if (method === "GET" && path === `${base}/proxies`)
			return json(structuredClone(state.list));
		return failure(404, `Unexpected ${method} ${path}`);
	});
	return calls;
}
const sent = (calls: Call[], method: string) =>
	calls.filter((call) => call.method === method);

function show(role: "admin" | "member" = "admin") {
	setCurrentWorkspace(WORKSPACE);
	render(<ProxiesView workspace={{ isDefault: true, role }} />);
}
function type(
	label: string,
	value: string,
	scope: HTMLElement = document.body,
) {
	changeControl(within(scope).getByLabelText(label), {
		target: { value },
	});
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	setCurrentWorkspace(null);
});

describe("Proxies view", () => {
	it("lists connections with their usage, problems, and the ladder", async () => {
		fakeGateway({
			list: list({
				connections: [
					connection({
						name: "zenrows",
						kind: "zenrows",
						source: "environment",
						country: "us",
						monthlyRequestCap: 5000,
						usage: { month: "2026-11", requests: 1234, costUsd: 1.25 },
					}),
					connection({
						name: "cloudflare",
						kind: "cloudflare-browser",
						accountId: "a".repeat(32),
						enabled: false,
						problem: {
							kind: "key",
							detail: "Cloudflare refused the token.",
							at: "2026-11-14T10:00:00.000Z",
						},
					}),
				],
				policy: policy({
					ladder: [
						{ kind: "direct" },
						{ kind: "proxy", connection: "cloudflare", level: "render" },
						{ kind: "proxy", connection: "zenrows", level: "auto" },
					],
				}),
				budget: { month: "2026-11", spentUsd: 1.25, limitUsd: 25 },
			}),
		});
		show();
		const table = await screen.findByRole("table");
		const rows = within(table).getAllByRole("row");
		expect(rows).toHaveLength(3);
		expect(rows[1].textContent).toContain("zenrows");
		expect(rows[1].textContent).toContain("ZenRows · environment variable");
		expect(rows[1].textContent).toContain("US");
		expect(rows[1].textContent).toContain("1,234 / 5,000 requests · $1.25");
		// An environment connection is switched off, never edited or deleted here.
		expect(screen.queryByLabelText("Use zenrows")).toBeNull();
		expect(rows[1].textContent).toContain(
			"Take it out of the ladder to stop using it.",
		);
		expect(screen.queryByRole("button", { name: "Edit zenrows" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete zenrows" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Delete cloudflare" }),
		).toBeDefined();
		expect(rows[2].textContent).toContain("Cloudflare Browser Run");
		expect(rows[2].textContent).toContain("Cloudflare refused the token.");
		expect(
			(screen.getByLabelText("Use cloudflare") as HTMLInputElement).checked,
		).toBe(false);
		expect(screen.getByText("$1.25 / $25.00")).toBeDefined();
		expect(
			screen.getByText(/temporary and last until the API restarts/),
		).toBeDefined();

		const ladder = within(screen.getByRole("list", { name: "Ladder steps" }));
		expect(
			ladder
				.getAllByRole("listitem")
				.map((item) => item.querySelector("code")?.textContent),
		).toEqual(["direct", "cloudflare:render", "zenrows:auto"]);
		expect(ladder.getByText("Plain request · free")).toBeDefined();
		expect(
			ladder.getByText(
				"Renders JavaScript · billed for browser time · switched off",
			),
		).toBeDefined();
		expect(
			ladder.getByText(
				"Gets past blocks and renders JavaScript · 1–25 credits, billed only for what worked",
			),
		).toBeDefined();
	});

	it("says when the operator turned web access off", async () => {
		fakeGateway({ list: list({ available: false, persistence: "mongodb" }) });
		show();
		expect(
			await screen.findByText(/Web access is turned off on this gateway/),
		).toBeDefined();
		expect(
			screen.getByText("Proxy settings are saved in MongoDB."),
		).toBeDefined();
		expect(screen.getByText("No proxies yet")).toBeDefined();
	});

	it("adds a ZenRows proxy and puts it in the ladder", async () => {
		const state = { list: list() };
		const calls = fakeGateway(state, (call) => {
			if (call.method === "POST" && call.path === `${base}/proxies`) {
				const added = connection({ name: "zenrows", kind: "zenrows" });
				state.list.connections.push(added);
				return json(added, 201);
			}
			if (call.method === "PUT" && call.path === `${base}/web/policy`) {
				const { revision, ...rest } = call.body as unknown as WebPolicy;
				state.list.policy = { ...rest, revision: revision + 1 };
				return json(state.list.policy);
			}
		});
		show();
		await screen.findByText("No proxies yet");
		fireEvent.click(screen.getByRole("button", { name: "Add proxy" }));
		const form = screen.getByRole("region", { name: "Add a proxy" });
		expect(within(form).getByLabelText("Provider").textContent).toBe("ZenRows");
		expect(
			(within(form).getByLabelText("Name") as HTMLInputElement).value,
		).toBe("zenrows");
		expect(
			within(form).getByText(/bills only the one that worked/),
		).toBeDefined();
		const submit = within(form).getByRole("button", { name: "Add proxy" });
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		type("API key", "zr-secret", form);
		type("Country (optional)", "DE", form);
		fireEvent.click(submit);

		expect(
			await screen.findByText(
				"Added zenrows. Fetches can now use zenrows:auto.",
			),
		).toBeDefined();
		expect(sent(calls, "POST")[0].body).toEqual({
			name: "zenrows",
			kind: "zenrows",
			apiKey: "zr-secret",
			country: "de",
			monthlyRequestCap: null,
		});
		expect(sent(calls, "PUT")[0].body).toEqual({
			ladder: [
				{ kind: "direct" },
				{ kind: "proxy", connection: "zenrows", level: "auto" },
			],
			domains: [],
			allowOnly: false,
			callerProxyRequestsPerDay: 100,
			monthlyBudgetUsd: 25,
			revision: 3,
		});
		await waitFor(() =>
			expect(
				within(screen.getByRole("list", { name: "Ladder steps" }))
					.getAllByRole("listitem")
					.map((item) => item.querySelector("code")?.textContent),
			).toEqual(["direct", "zenrows:auto"]),
		);
		// The key is never shown back.
		expect(document.body.textContent).not.toContain("zr-secret");
	});

	it("asks each provider for its own fields", async () => {
		const state = { list: list() };
		const calls = fakeGateway(state, (call) => {
			if (call.method === "POST" && call.path === `${base}/proxies`) {
				const body = call.body as Record<string, string>;
				const added = connection({
					name: body.name,
					kind: body.kind as ProxyConnection["kind"],
				});
				state.list.connections.push(added);
				return json(added, 201);
			}
		});
		show();
		await screen.findByText("No proxies yet");

		fireEvent.click(screen.getByRole("button", { name: "Add proxy" }));
		let form = screen.getByRole("region", { name: "Add a proxy" });
		type("Provider", "cloudflare-browser", form);
		expect(
			(within(form).getByLabelText("Name") as HTMLInputElement).value,
		).toBe("cloudflare");
		expect(
			within(form).getByText(/cannot get past CAPTCHAs or bot protection/),
		).toBeDefined();
		expect(within(form).queryByLabelText("Country (optional)")).toBeNull();
		type("API token", "cf-token", form);
		type("Cloudflare Account ID", "not-an-id", form);
		expect(
			within(form).getByText("Enter the 32-character Cloudflare account ID."),
		).toBeDefined();
		type("Cloudflare Account ID", "b".repeat(32), form);
		fireEvent.click(within(form).getByLabelText(/Add it to the ladder/));
		fireEvent.click(within(form).getByRole("button", { name: "Add proxy" }));
		expect(await screen.findByText("Added cloudflare.")).toBeDefined();
		expect(sent(calls, "POST")[0].body).toEqual({
			name: "cloudflare",
			kind: "cloudflare-browser",
			apiKey: "cf-token",
			accountId: "b".repeat(32),
			monthlyRequestCap: null,
		});
		expect(sent(calls, "PUT")).toEqual([]);

		fireEvent.click(screen.getByRole("button", { name: "Add proxy" }));
		form = screen.getByRole("region", { name: "Add a proxy" });
		type("Provider", "brightdata", form);
		expect(
			(
				within(form).getByLabelText(
					"Price per 1,000 requests (USD)",
				) as HTMLInputElement
			).value,
		).toBe("1.5");
		type("Name", "unlocker", form);
		type("API key", "bd-key", form);
		type("Zone", "web_unlocker1", form);
		type("Price per 1,000 requests (USD)", "2", form);
		type("Monthly request cap (optional)", "1000", form);
		fireEvent.click(within(form).getByLabelText(/Add it to the ladder/));
		fireEvent.click(within(form).getByRole("button", { name: "Add proxy" }));
		expect(await screen.findByText("Added unlocker.")).toBeDefined();
		expect(sent(calls, "POST")[1].body).toEqual({
			name: "unlocker",
			kind: "brightdata",
			apiKey: "bd-key",
			zone: "web_unlocker1",
			pricePer1000Usd: 2,
			monthlyRequestCap: 1000,
		});
	});

	it("shows the gateway's reason when it refuses a connection", async () => {
		fakeGateway({ list: list() }, (call) =>
			call.method === "POST"
				? failure(409, "A proxy named zenrows already exists.")
				: undefined,
		);
		show();
		await screen.findByText("No proxies yet");
		fireEvent.click(screen.getByRole("button", { name: "Add proxy" }));
		const form = screen.getByRole("region", { name: "Add a proxy" });
		type("API key", "zr-secret", form);
		fireEvent.click(within(form).getByRole("button", { name: "Add proxy" }));
		expect((await within(form).findByRole("alert")).textContent).toBe(
			"A proxy named zenrows already exists.",
		);
	});

	it("edits a saved connection, keeping its key unless a new one is typed", async () => {
		const state = {
			list: list({
				connections: [
					connection({ name: "zenrows", kind: "zenrows", country: "us" }),
				],
			}),
		};
		const calls = fakeGateway(state, (call) => {
			if (call.method === "PATCH")
				return json({ ...state.list.connections[0], ...call.body });
		});
		show();
		fireEvent.click(
			await screen.findByRole("button", { name: "Edit zenrows" }),
		);
		const form = screen.getByRole("region", { name: "Edit zenrows" });
		type("Country (optional)", "", form);
		type("Monthly request cap (optional)", "200", form);
		fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
		expect(await screen.findByText("Saved zenrows.")).toBeDefined();
		expect(sent(calls, "PATCH")[0]).toEqual({
			method: "PATCH",
			path: `${base}/proxies/zenrows`,
			body: { monthlyRequestCap: 200, country: "" },
		});
	});

	it("switches a connection off and deletes one after confirming", async () => {
		const state = {
			list: list({
				connections: [connection({ name: "zenrows", kind: "zenrows" })],
				policy: policy({
					ladder: [
						{ kind: "direct" },
						{ kind: "proxy", connection: "zenrows", level: "auto" },
					],
				}),
			}),
		};
		const calls = fakeGateway(state, (call) => {
			if (call.method === "PATCH") {
				state.list.connections[0] = {
					...state.list.connections[0],
					...call.body,
				};
				return json(state.list.connections[0]);
			}
			if (call.method === "DELETE") {
				state.list.connections = [];
				state.list.policy = policy({ revision: 4 });
				return new Response(null, { status: 204 });
			}
		});
		show();
		fireEvent.click(await screen.findByLabelText("Use zenrows"));
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Use zenrows") as HTMLInputElement).checked,
			).toBe(false),
		);
		expect(sent(calls, "PATCH")[0].body).toEqual({ enabled: false });

		fireEvent.click(screen.getByRole("button", { name: "Delete zenrows" }));
		expect(sent(calls, "DELETE")).toEqual([]);
		fireEvent.click(
			screen.getByRole("button", { name: "Confirm delete zenrows" }),
		);
		expect(
			await screen.findByText("Deleted zenrows and took it out of the ladder."),
		).toBeDefined();
		expect(sent(calls, "DELETE")[0].path).toBe(`${base}/proxies/zenrows`);
		await waitFor(() =>
			expect(
				within(screen.getByRole("list", { name: "Ladder steps" })).getAllByRole(
					"listitem",
				),
			).toHaveLength(1),
		);
	});

	it("saves the ladder, rules, and limits with the revision it read", async () => {
		const state = {
			list: list({
				connections: [connection({ name: "zenrows", kind: "zenrows" })],
			}),
		};
		let conflict = true;
		const calls = fakeGateway(state, (call) => {
			if (call.method === "PUT") {
				if (conflict) {
					conflict = false;
					state.list.policy = policy({ revision: 4, monthlyBudgetUsd: 50 });
					return failure(409, "The web policy changed. Reload and try again.");
				}
				const { revision, ...rest } = call.body as unknown as WebPolicy;
				state.list.policy = { ...rest, revision: revision + 1 };
				return json(state.list.policy);
			}
		});
		show();
		const editor = within(
			(await screen.findByRole("heading", { name: "Ladder" })).closest(
				"form",
			) as HTMLElement,
		);
		const save = () =>
			editor.getByRole("button", {
				name: "Save ladder and limits",
			}) as HTMLButtonElement;
		expect(save().disabled).toBe(true);
		type("Step to add", "zenrows:premium");
		fireEvent.click(editor.getByRole("button", { name: "Add step" }));
		fireEvent.click(
			editor.getByRole("button", { name: "Move zenrows:premium up" }),
		);
		type("Domain", "https://Example.com/pricing");
		type("Rule", "start-at-proxy");
		fireEvent.click(editor.getByRole("button", { name: "Add rule" }));
		changeControl(editor.getByLabelText("Proxied requests a day"), {
			target: { value: "10" },
		});
		expect(editor.getByText("Unsaved changes")).toBeDefined();
		fireEvent.click(save());
		const expected = {
			ladder: [
				{ kind: "proxy", connection: "zenrows", level: "premium" },
				{ kind: "direct" },
			],
			domains: [{ match: "example.com", rule: "start-at-proxy" }],
			allowOnly: false,
			callerProxyRequestsPerDay: 10,
			monthlyBudgetUsd: 25,
			revision: 3,
		};
		// Someone else saved first: nothing is merged, and the person reloads.
		const alert = await editor.findByRole("alert");
		expect(alert.textContent).toContain("The ladder changed elsewhere");
		expect(sent(calls, "PUT")[0].body).toEqual(expected);
		fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
		await waitFor(() =>
			expect(
				(editor.getByLabelText("Monthly budget (USD)") as HTMLInputElement)
					.value,
			).toBe("50"),
		);
		expect(editor.queryByRole("alert")).toBeNull();

		// Again, on the fresh revision.
		fireEvent.click(
			editor.getByRole("checkbox", { name: /Only fetch listed domains/ }),
		);
		fireEvent.click(save());
		expect(await editor.findByText("Saved")).toBeDefined();
		expect(sent(calls, "PUT")[1].body).toMatchObject({
			allowOnly: true,
			monthlyBudgetUsd: 50,
			revision: 4,
		});
	});

	it("tries a URL and shows every attempt and the page as text", async () => {
		const result: WebFetchResult = {
			url: "https://shop.example/pricing",
			finalUrl: "https://shop.example/pricing",
			status: 200,
			ok: true,
			contentType: "text/html",
			format: "markdown",
			content: "# Pricing\n\n<script>alert(1)</script> Plans start at $10.",
			truncated: false,
			via: "zenrows:auto",
			attempts: [
				{
					step: { kind: "direct" },
					outcome: "blocked",
					status: 403,
					latencyMs: 420,
					costUsd: 0,
					detail: "Cloudflare challenge",
				},
				{
					step: { kind: "proxy", connection: "zenrows", level: "auto" },
					outcome: "ok",
					status: 200,
					latencyMs: 8200,
					costUsd: 0.005,
				},
			],
			cached: false,
			costUsd: 0.005,
		};
		const calls = fakeGateway({ list: list() }, (call) =>
			call.method === "POST" && call.path === `${base}/web/fetch`
				? json(result)
				: undefined,
		);
		show();
		const panel = within(
			(await screen.findByRole("heading", { name: "Try a URL" })).closest(
				"section",
			) as HTMLElement,
		);
		expect(panel.getByText(/Proxied requests are billed/)).toBeDefined();
		type("Address to fetch", "https://shop.example/pricing");
		fireEvent.click(panel.getByLabelText("Skip the plain request"));
		fireEvent.click(panel.getByRole("button", { name: "Fetch" }));
		await panel.findByText("Result");
		expect(sent(calls, "POST")[0].body).toEqual({
			url: "https://shop.example/pricing",
			skipDirect: true,
		});
		const rows = panel.getAllByRole("row").slice(1);
		expect(rows.map((row) => row.textContent)).toEqual([
			"directBlocked4030.4 s$0Cloudflare challenge",
			"zenrows:autoOK2008.2 s$0.005",
		]);
		expect(panel.getByText(/via/).textContent).toContain("zenrows:auto");
		expect(panel.getByText(/Cost: \$0.005/)).toBeDefined();
		// The page is shown as text; nothing in it runs or renders.
		const preview = panel.getByRole("region", { name: "Fetched content" });
		expect(preview.querySelector("pre")?.textContent).toBe(result.content);
		expect(preview.querySelector("script")).toBeNull();
	});

	it("says why nothing came back", async () => {
		fakeGateway({ list: list() }, (call) =>
			call.path === `${base}/web/fetch`
				? json({
						url: "https://blocked.example/",
						finalUrl: "https://blocked.example/",
						status: 0,
						ok: false,
						contentType: "",
						format: "markdown",
						content: "",
						truncated: false,
						via: "",
						attempts: [
							{
								step: { kind: "direct" },
								outcome: "blocked",
								status: 403,
								latencyMs: 300,
								costUsd: 0,
								detail: "DataDome",
							},
						],
						cached: false,
						costUsd: 0,
						reason:
							"The site blocked every step. Add a proxy that gets past blocks.",
					} satisfies WebFetchResult)
				: undefined,
		);
		show();
		const panel = within(
			(await screen.findByRole("heading", { name: "Try a URL" })).closest(
				"section",
			) as HTMLElement,
		);
		type("Address to fetch", "https://blocked.example/");
		fireEvent.click(panel.getByRole("button", { name: "Fetch" }));
		expect(
			await panel.findByText(/Nothing fetched. The site blocked every step/),
		).toBeDefined();
		expect(panel.queryByRole("region", { name: "Fetched content" })).toBeNull();
	});

	it("tests one connection with a billable request at a chosen level", async () => {
		const calls = fakeGateway(
			{
				list: list({
					connections: [connection({ name: "zenrows", kind: "zenrows" })],
				}),
			},
			(call) =>
				call.path === `${base}/proxies/zenrows/test`
					? json({
							url: "https://example.com/",
							finalUrl: "https://example.com/",
							status: 200,
							ok: true,
							contentType: "text/html",
							format: "markdown",
							content: "Example Domain",
							truncated: false,
							via: "zenrows:render",
							attempts: [
								{
									step: {
										kind: "proxy",
										connection: "zenrows",
										level: "render",
									},
									outcome: "ok",
									status: 200,
									latencyMs: 3000,
									costUsd: 0.005,
								},
							],
							cached: false,
							costUsd: 0.005,
						} satisfies WebFetchResult)
					: undefined,
		);
		show();
		fireEvent.click(
			await screen.findByRole("button", { name: "Test zenrows" }),
		);
		const panel = within(screen.getByRole("region", { name: "Test zenrows" }));
		expect(panel.getByText(/billed like any other/)).toBeDefined();
		type("Level", "render");
		fireEvent.click(panel.getByRole("button", { name: "Run billable test" }));
		await panel.findByText("Test of zenrows");
		expect(sent(calls, "POST")[0]).toEqual({
			method: "POST",
			path: `${base}/proxies/zenrows/test`,
			body: { level: "render" },
		});
	});

	it("shows a member everything and lets them change nothing", async () => {
		const calls = fakeGateway({
			list: list({
				connections: [connection({ name: "zenrows", kind: "zenrows" })],
				policy: policy({
					ladder: [
						{ kind: "direct" },
						{ kind: "proxy", connection: "zenrows", level: "auto" },
					],
					domains: [{ match: "example.com", rule: "deny" }],
				}),
			}),
		});
		show("member");
		await screen.findByRole("table");
		expect(screen.getByText(/Ask a workspace admin/)).toBeDefined();
		for (const name of [
			"Add proxy",
			"Test zenrows",
			"Edit zenrows",
			"Delete zenrows",
			"Save ladder and limits",
			"Add step",
			"Add rule",
			"Fetch",
		])
			expect(screen.queryByRole("button", { name })).toBeNull();
		expect(screen.queryByLabelText("Use zenrows")).toBeNull();
		expect(screen.queryByRole("heading", { name: "Try a URL" })).toBeNull();
		expect(screen.getByText("Never fetch")).toBeDefined();
		expect(
			// Disabled through its fieldset, so read-only for a member.
			screen.getByLabelText("Monthly budget (USD)").matches(":disabled"),
		).toBe(true);
		expect(calls.every((call) => call.method === "GET")).toBe(true);
	});
});

describe("Proxy helpers", () => {
	it("formats fractions of a cent", () => {
		expect([0, 0.005, 0.000125, 0.01, 1.5, 25].map(usd)).toEqual([
			"$0",
			"$0.005",
			"$0.00013",
			"$0.01",
			"$1.50",
			"$25.00",
		]);
	});

	it("turns what people type into a host", () => {
		expect(
			[
				"Example.com",
				"https://www.Example.com/path?q=1",
				"*.example.com",
				".example.com.",
			].map(normalizeHost),
		).toEqual(["example.com", "www.example.com", "example.com", "example.com"]);
	});

	it("checks a policy against the gateway's limits", () => {
		expect(policyProblem(policy())).toBeNull();
		expect(policyProblem(policy({ ladder: [] }))).toBe(
			"The ladder needs at least one step.",
		);
		expect(policyProblem(policy({ callerProxyRequestsPerDay: 1.5 }))).toMatch(
			/whole number/,
		);
		expect(policyProblem(policy({ monthlyBudgetUsd: -1 }))).toMatch(
			/monthly budget/,
		);
	});
});

describe("Proxies against the gateway", () => {
	const closers: Array<() => Promise<void>> = [];
	afterEach(async () => {
		cleanup();
		clearCredential();
		for (const close of closers.splice(0)) await close();
		vi.unstubAllEnvs();
		window.history.replaceState(null, "", "/");
		window.localStorage.clear();
	});

	it("adds a proxy, puts it in the ladder, and saves a domain rule", async () => {
		const server = createServer({
			config: { providers: [], corsOrigins: ["*"] },
			logger: false,
		});
		const url = await server.listen({ host: "127.0.0.1", port: 0 });
		closers.push(() => stopServer(server));
		vi.stubEnv("VITE_API_URL", url);
		const owner = await setUpOwner(url);
		const workspaceId = await defaultWorkspaceId(url, owner);
		const read = async () =>
			(await (
				await fetch(`${url}/v1/${workspaceId}/proxies`, {
					headers: { authorization: `Bearer ${owner}` },
				})
			).json()) as ProxyList;
		window.history.replaceState(null, "", "#/proxies");
		render(<App />);
		await screen.findByText("No proxies yet");
		expect(
			screen
				.getByRole("link", { name: "Proxies" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(window.location.hash).toBe(`#/w/${workspaceId}/proxies`);

		fireEvent.click(screen.getByRole("button", { name: "Add proxy" }));
		const form = screen.getByRole("region", { name: "Add a proxy" });
		type("API key", "zr-secret", form);
		fireEvent.click(within(form).getByRole("button", { name: "Add proxy" }));
		expect(
			await screen.findByText(
				"Added zenrows. Fetches can now use zenrows:auto.",
			),
		).toBeDefined();
		const saved = await read();
		expect(saved.connections).toMatchObject([
			{ name: "zenrows", kind: "zenrows", keyConfigured: true, enabled: true },
		]);
		expect(saved.policy.ladder).toEqual([
			{ kind: "direct" },
			{ kind: "proxy", connection: "zenrows", level: "auto" },
		]);
		expect(JSON.stringify(saved)).not.toContain("zr-secret");

		type("Domain", "example.com");
		fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Save ladder and limits" }),
		);
		expect(await screen.findByText("Saved")).toBeDefined();
		expect((await read()).policy.domains).toEqual([
			{ match: "example.com", rule: "deny" },
		]);
	});
});

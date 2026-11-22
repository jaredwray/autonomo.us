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
import { agentTokenConfig, grantsText } from "../src/AgentMcp.js";
import { App } from "../src/App.js";
import { clearCredential } from "../src/api.js";
import { FLAG_PAGE } from "../src/SynapseFlags.js";
import { changeControl } from "./controls.js";
import {
	defaultWorkspaceId,
	routeToWorkspace,
	setUpOwner,
	stopServer,
} from "./session.js";

// The Flags tab runs against a real gateway API server (no fetch mocks), as
// the other Synapse dashboard tests do.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	cleanup();
	clearCredential();
	for (const close of closers.splice(0)) await close();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
	window.localStorage.clear();
	window.sessionStorage.clear();
});

async function start(hash = "#/synapse/flags") {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => stopServer(server));
	vi.stubEnv("VITE_API_URL", url);
	const token = await setUpOwner(url);
	const workspace = await defaultWorkspaceId(url, token);
	routeToWorkspace(server, workspace);
	const owner = { authorization: `Bearer ${token}` };
	const inject = async (
		method: "GET" | "POST",
		path: string,
		payload?: unknown,
	) => {
		const response = await server.inject({
			method,
			url: path,
			headers: owner,
			...(payload === undefined ? {} : { payload: payload as object }),
		});
		expect(response.statusCode, response.body).toBeLessThan(300);
		return response.json();
	};
	const agent = async (name: string, permissions: string[]) =>
		(
			(await inject("POST", `/v1/${workspace}/agent-tokens`, {
				name,
				description: "",
				ttlDays: "never",
				permissions: ["mcp:read", "mcp:call", ...permissions],
			})) as { secret: string }
		).secret;
	/** Calls a Synapse tool the way an agent does: JSON-RPC over the MCP endpoint. */
	const mcp = async (
		secret: string,
		name: string,
		args: Record<string, unknown>,
	) => {
		const response = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const body = await response.json();
		if (body.error || body.result?.isError)
			throw new Error(`${name} failed: ${JSON.stringify(body)}`);
		return body.result.structuredContent;
	};
	const open = () => {
		window.history.replaceState(null, "", hash);
		render(
			<StrictMode>
				<App />
			</StrictMode>,
		);
	};
	return { inject, agent, mcp, open };
}
const flagsOf = async (inject: Awaited<ReturnType<typeof start>>["inject"]) =>
	(
		(await inject("GET", "/v1/synapse/flags")) as {
			flags: Array<{ problem: string; status: string; resolution?: string }>;
		}
	).flags.map((flag) => [flag.problem, flag.status, flag.resolution ?? null]);

it("shows the flags agents filed and lets a person settle one by hand", async () => {
	const { inject, agent, mcp, open } = await start();
	const scout = await agent("Scout", []);
	await inject("POST", "/v1/synapse/spaces/shared/notes", {
		title: "Revenue by month",
		template: "Datasets",
		body: "Query the revenue column.",
	});
	await mcp(scout, "synapse_flag", {
		kind: "wrong",
		title: "Revenue by month",
		problem: "The revenue column was renamed to net_revenue.",
		suggestion: "Query the net_revenue column.",
		task: "Monthly revenue report",
	});
	await mcp(scout, "synapse_flag", {
		kind: "missing",
		problem: "No note says how refunds are counted.",
	});
	open();
	const renamed = within(
		await screen.findByRole("article", {
			name: "Wrong: Revenue by month",
		}),
	);
	expect(
		screen.getByRole("tab", { name: "Flags" }).getAttribute("aria-selected"),
	).toBe("true");
	expect(
		renamed.getByText("The revenue column was renamed to net_revenue."),
	).toBeDefined();
	expect(renamed.getByText("Query the net_revenue column.")).toBeDefined();
	expect(
		renamed.getByText(/Flagged by Scout on .* while working on: Monthly/),
	).toBeDefined();
	expect(renamed.getByText("Open")).toBeDefined();
	expect(
		renamed
			.getByRole("link", { name: "Revenue by month" })
			.getAttribute("href"),
	).toMatch(/synapse\/shared\/Revenue%20by%20month$/);
	const missing = within(screen.getByRole("article", { name: "Missing" }));

	// Dismissing needs a reason, and can be called off.
	fireEvent.click(
		missing.getByRole("button", {
			name: "Dismiss the flag about the shared space",
		}),
	);
	const confirm = missing.getByRole("button", { name: "Confirm dismissal" });
	expect((confirm as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(missing.getByRole("button", { name: "Cancel" }));
	expect(missing.queryByLabelText("Why nothing is to be done")).toBeNull();
	fireEvent.click(
		missing.getByRole("button", {
			name: "Dismiss the flag about the shared space",
		}),
	);
	fireEvent.change(missing.getByLabelText("Why nothing is to be done"), {
		target: { value: "Refunds are out of scope for agents." },
	});
	fireEvent.click(missing.getByRole("button", { name: "Confirm dismissal" }));
	expect((await screen.findByRole("status")).textContent).toBe(
		"Flag dismissed.",
	);
	// The list shows open flags, so the dismissed one leaves it.
	await waitFor(() =>
		expect(screen.queryByRole("article", { name: "Missing" })).toBeNull(),
	);
	expect(await flagsOf(inject)).toEqual([
		[
			"No note says how refunds are counted.",
			"dismissed",
			"Refunds are out of scope for agents.",
		],
		["The revenue column was renamed to net_revenue.", "open", null],
	]);

	fireEvent.click(
		renamed.getByRole("button", {
			name: "Mark the flag about Revenue by month resolved",
		}),
	);
	fireEvent.change(renamed.getByLabelText("What was done about it"), {
		target: { value: "Edited the note." },
	});
	fireEvent.click(renamed.getByRole("button", { name: "Confirm resolved" }));
	await screen.findByText("No open flags.");
	expect((await screen.findByRole("status")).textContent).toBe(
		"Flag resolved.",
	);

	// Settled flags are a filter away, with what was done about them.
	changeControl(screen.getByLabelText("Status"), {
		target: { value: "dismissed" },
	});
	const dismissed = within(
		await screen.findByRole("article", { name: "Missing" }),
	);
	expect(
		dismissed.getByText("Refunds are out of scope for agents."),
	).toBeDefined();
	expect(
		dismissed.getByText(/Dismissed by .* on \d{4}-\d{2}-\d{2}:/),
	).toBeDefined();
	expect(dismissed.queryByRole("button")).toBeNull();
	changeControl(screen.getByLabelText("Status"), { target: { value: "" } });
	await screen.findByRole("article", { name: "Wrong: Revenue by month" });
	expect(screen.getAllByRole("article")).toHaveLength(2);
});

it("files a flag from the dashboard and follows a curator's proposal", async () => {
	const { inject, agent, mcp, open } = await start();
	const curator = await agent("Curator", ["synapse:curate"]);
	open();
	await screen.findByText("No open flags.");
	fireEvent.click(screen.getByRole("button", { name: "New flag" }));
	const form = within(await screen.findByRole("form", { name: "New flag" }));
	expect(
		(form.getByRole("button", { name: "File flag" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.click(form.getByRole("button", { name: "Cancel" }));
	expect(screen.queryByRole("form", { name: "New flag" })).toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "New flag" }));
	changeControl(screen.getByLabelText("What is the matter"), {
		target: { value: "outdated" },
	});
	fireEvent.change(screen.getByLabelText("Note (optional)"), {
		target: { value: "Brand voice" },
	});
	fireEvent.change(screen.getByLabelText("What is missing or wrong"), {
		target: { value: "It still describes the 2025 tone." },
	});
	fireEvent.change(screen.getByLabelText("What it should say (optional)"), {
		target: { value: "Plain, short sentences." },
	});
	fireEvent.click(screen.getByRole("button", { name: "File flag" }));
	const card = within(
		await screen.findByRole("article", { name: "Out of date: Brand voice" }),
	);
	expect((await screen.findByRole("status")).textContent).toBe("Flag filed.");
	expect(card.getByText("Plain, short sentences.")).toBeDefined();

	// The curator sees the person's flag and answers it with a proposal.
	const [flag] = (
		(await mcp(curator, "synapse_flags", { status: "open" })) as {
			flags: Array<{ id: string; problem: string }>;
		}
	).flags;
	expect(flag.problem).toBe("It still describes the 2025 tone.");
	await mcp(curator, "synapse_propose", {
		action: "create",
		title: "Brand voice",
		body: "Plain, short sentences.",
		reason: "A person flagged the old tone.",
		flags: [flag.id],
	});
	changeControl(screen.getByLabelText("Status"), {
		target: { value: "proposed" },
	});
	// The open list stays on screen until the proposed one has loaded.
	await screen.findByText(/A proposal answers this flag/);
	const proposed = within(
		screen.getByRole("article", { name: "Out of date: Brand voice" }),
	);
	fireEvent.click(
		proposed.getByRole("link", { name: "Review it in Proposals" }),
	);
	const proposal = within(
		await screen.findByRole("article", { name: "Create Brand voice" }),
	);
	fireEvent.click(
		proposal.getByRole("button", { name: "Approve Brand voice" }),
	);
	await screen.findByText(/No pending proposals/);
	fireEvent.click(screen.getByRole("tab", { name: "Flags" }));
	await screen.findByText("No open flags.");
	expect(await flagsOf(inject)).toEqual([
		[
			"It still describes the 2025 tone.",
			"resolved",
			"The proposal that answers it was approved.",
		],
	]);
});

it("says what went wrong when a flag cannot be loaded, filed, or settled", async () => {
	const { inject, open } = await start();
	await inject("POST", "/v1/synapse/flags", {
		kind: "missing",
		problem: "No refund policy.",
	});
	open();
	const card = within(await screen.findByRole("article", { name: "Missing" }));
	// Someone else settles it first: the dashboard reports the conflict.
	const [{ id }] = (
		(await inject("GET", "/v1/synapse/flags")) as {
			flags: Array<{ id: string }>;
		}
	).flags;
	await inject("POST", `/v1/synapse/flags/${id}/resolve`, {
		status: "dismissed",
		reason: "Elsewhere.",
	});
	fireEvent.click(
		card.getByRole("button", {
			name: "Mark the flag about the shared space resolved",
		}),
	);
	fireEvent.change(card.getByLabelText("What was done about it"), {
		target: { value: "Done." },
	});
	fireEvent.click(card.getByRole("button", { name: "Confirm resolved" }));
	expect((await card.findByRole("alert")).textContent).toBe(
		"This flag was already dismissed.",
	);

	// A title Synapse cannot use is refused by the server, and said so.
	fireEvent.click(screen.getByRole("button", { name: "New flag" }));
	fireEvent.change(screen.getByLabelText("Note (optional)"), {
		target: { value: "a/b" },
	});
	fireEvent.change(screen.getByLabelText("What is missing or wrong"), {
		target: { value: "Something." },
	});
	fireEvent.click(screen.getByRole("button", { name: "File flag" }));
	const form = within(screen.getByRole("form", { name: "New flag" }));
	expect((await form.findByRole("alert")).textContent).toMatch(/Titles/);

	// The list itself failing is reported too.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("The gateway is unreachable.");
		}),
	);
	changeControl(screen.getByLabelText("Status"), {
		target: { value: "resolved" },
	});
	await screen.findByText("The gateway is unreachable.");
});

it("loads older flags a page at a time", async () => {
	const { inject, agent, mcp, open } = await start();
	// More than a page, from two reporters: each may have 50 open at most.
	const scout = await agent("Scout", []);
	for (let index = 0; index < 30; index++)
		await inject("POST", "/v1/synapse/flags", {
			kind: "missing",
			problem: `Gap ${index} from a person.`,
		});
	for (let index = 0; index < 25; index++)
		await mcp(scout, "synapse_flag", {
			kind: "missing",
			problem: `Gap ${index} from an agent.`,
		});
	open();
	const older = await screen.findByRole("button", {
		name: "Show older flags",
	});
	expect(screen.getAllByRole("article")).toHaveLength(FLAG_PAGE);
	expect(screen.queryByText("Gap 0 from a person.")).toBeNull();
	fireEvent.click(older);
	await screen.findByText("Gap 0 from a person.");
	expect(screen.getAllByRole("article")).toHaveLength(55);
	// The last page was not full, so there is nothing further back.
	expect(screen.queryByRole("button", { name: "Show older flags" })).toBeNull();

	// A failure to load more is said, and what is shown stays.
	changeControl(screen.getByLabelText("Status"), { target: { value: "" } });
	const again = await screen.findByRole("button", { name: "Show older flags" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("The gateway is unreachable.");
		}),
	);
	fireEvent.click(again);
	await screen.findByText("The gateway is unreachable.");
	expect(screen.getAllByRole("article")).toHaveLength(FLAG_PAGE);
});

it("offers the curator grant when creating an agent", () => {
	const group = agentTokenConfig.permissionGroups?.find(
		(item) => item.resource === "synapse",
	);
	expect(group?.choices).toEqual(["synapse:curate"]);
	expect(group?.hint).toMatch(/only through proposals a person approves/);
	expect(grantsText(["mcp:call", "synapse:curate"])).toBe(
		"MCP: Call, Synapse: Curate flags",
	);
});

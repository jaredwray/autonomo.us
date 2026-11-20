import type {
	AgentSummary,
	BudgetList,
	BudgetPolicyView,
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
import { BudgetPanel, budgetSentence } from "../src/BudgetView.js";
import { ModelsView } from "../src/ModelsView.js";
import { changeControl } from "./controls.js";
import { defaultWorkspaceId, setUpOwner, stopServer } from "./session.js";

// The Budget tab against a fake gateway that answers from `state` and
// records what the page sent.

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const base = `/v1/${WORKSPACE}`;
const OPUS = "anthropic/claude-opus-4-8";

function agent(id: string, name: string): AgentSummary {
	return {
		id,
		kind: "token",
		name,
		description: "",
		status: "active",
		permissions: [],
		model: null,
		connections: 0,
		createdAt: "2026-11-01T00:00:00.000Z",
	};
}
let counter = 0;
function budget(overrides: Partial<BudgetPolicyView> = {}): BudgetPolicyView {
	counter += 1;
	return {
		id: `b${counter}`,
		appliesTo: { kind: "everyone" },
		covers: { kind: "all" },
		limitUsd: 100,
		period: "month",
		enabled: true,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
		usage: {
			period: "2026-11",
			spentUsd: 0,
			resetsAt: "2026-12-01T00:00:00.000Z",
		},
		...overrides,
	};
}

type Call = { method: string; path: string; body?: Record<string, unknown> };
type State = { budgets: BudgetPolicyView[]; agents?: AgentSummary[] };
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

function fakeGateway(
	state: State,
	handler: (call: Call) => Response | undefined = () => undefined,
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
		if (method === "GET" && path === `${base}/budgets`)
			return json({
				policies: structuredClone(state.budgets),
				persistence: "memory",
			} satisfies BudgetList);
		if (method === "GET" && path === `${base}/agents`)
			return json({ agents: state.agents ?? [], persistence: "memory" });
		if (method === "GET" && path === `${base}/models`)
			return json({
				models: [
					{ id: OPUS, provider: "anthropic", model: "claude-opus-4-8" },
					{
						id: "anthropic/judge",
						provider: "anthropic",
						model: "judge",
						capability: "decisions",
					},
				],
				providers: [],
			});
		return json({ error: { message: `Unexpected ${method} ${path}` } }, 404);
	});
	return calls;
}
const sent = (calls: Call[], method: string) =>
	calls.filter((call) => call.method === method);

function show(role: "admin" | "member" = "admin") {
	setCurrentWorkspace(WORKSPACE);
	return render(<BudgetPanel workspace={{ isDefault: true, role }} />);
}
function change(label: string, value: string, scope: HTMLElement) {
	changeControl(within(scope).getByLabelText(label), { target: { value } });
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

describe("Budget tab", () => {
	it("lists budgets with who, what, the limit, and what is spent", async () => {
		fakeGateway({
			agents: [agent("a1", "Researcher"), agent("a2", "Writer")],
			budgets: [
				budget({ covers: { kind: "video" }, limitUsd: 25 }),
				budget({
					appliesTo: { kind: "agents", agentIds: ["a1", "a2"] },
					covers: { kind: "llm-model", model: OPUS },
					limitUsd: 5,
					period: "day",
					usage: {
						period: "2026-11-20",
						spentUsd: 5.5,
						resetsAt: "2026-11-21T00:00:00.000Z",
					},
				}),
			],
		});
		show();
		const table = await screen.findByRole("table");
		const rows = within(table).getAllByRole("row");
		expect(rows[1].textContent).toContain("Everyone");
		expect(rows[1].textContent).toContain("All video models");
		expect(rows[1].textContent).toContain("$25.00 a month");
		expect(rows[1].textContent).toContain("$0.00 of $25.00");
		expect(rows[2].textContent).toContain("Researcher and Writer");
		expect(rows[2].textContent).toContain("Shared by 2 agents");
		expect(rows[2].textContent).toContain(OPUS);
		expect(rows[2].textContent).toContain("$5.00 a day");
		expect(rows[2].textContent).toContain("$5.50 of $5.00");
		expect(rows[2].textContent).toContain("Used up · resets 21 Nov");
		expect(
			within(screen.getByRole("region", { name: "Budget overview" })).getByText(
				"Used up now",
			).parentElement?.textContent,
		).toContain("1");
	});

	it("adds a budget that agents share on one language model, reading back what it does", async () => {
		const state: State = {
			agents: [agent("a1", "Researcher"), agent("a2", "Writer")],
			budgets: [],
		};
		const calls = fakeGateway(state, (call) => {
			if (call.method !== "POST") return undefined;
			const added = budget(call.body as Partial<BudgetPolicyView>);
			state.budgets.push(added);
			return json(added, 201);
		});
		show();
		await screen.findByText("No budgets");
		fireEvent.click(screen.getByRole("button", { name: "Add budget" }));
		const form = screen.getByRole("region", { name: "Add a budget" });
		const add = within(form).getByRole("button", {
			name: "Add budget",
		}) as HTMLButtonElement;
		expect(
			within(form).getByText("Enter a limit in US dollars."),
		).toBeDefined();
		expect(add.disabled).toBe(true);
		fireEvent.click(within(form).getByLabelText(/Specific agents/));
		fireEvent.change(within(form).getByLabelText("Limit (USD)"), {
			target: { value: "20" },
		});
		expect(within(form).getByText("Pick at least one agent.")).toBeDefined();
		fireEvent.click(within(form).getByLabelText(/Researcher/));
		fireEvent.click(within(form).getByLabelText(/Writer/));
		change("Covers", "llm-model", form);
		// Decision models answer decisions, not chat: only chat models are offered.
		fireEvent.click(within(form).getByLabelText("Language model"));
		expect(
			screen.getAllByRole("option").map((option) => option.textContent),
		).toEqual([OPUS]);
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
		change("Resets", "day", form);
		expect(
			within(form).getByText(
				`Researcher and Writer can together spend up to $20.00 a day (UTC) on ${OPUS}.`,
			),
		).toBeDefined();
		fireEvent.click(add);
		expect(await screen.findByText("Budget added.")).toBeDefined();
		expect(sent(calls, "POST")[0]).toMatchObject({
			path: `${base}/budgets`,
			body: {
				appliesTo: { kind: "agents", agentIds: ["a1", "a2"] },
				covers: { kind: "llm-model", model: OPUS },
				limitUsd: 20,
				period: "day",
			},
		});
		// Focus goes back to the button that opened the form.
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add budget" }),
			),
		);
	});

	it("edits a budget, switches it off, and deletes it after confirming", async () => {
		const existing = budget({ covers: { kind: "llm" }, limitUsd: 50 });
		const state: State = { budgets: [existing] };
		const calls = fakeGateway(state, (call) => {
			if (call.method === "PATCH") {
				const next = { ...state.budgets[0], ...call.body };
				state.budgets = [next as BudgetPolicyView];
				return json(next);
			}
			if (call.method === "DELETE") {
				state.budgets = [];
				return new Response(null, { status: 204 });
			}
		});
		show();
		const label = "Everyone in this workspace on all language models";
		fireEvent.click(
			await screen.findByRole("button", {
				name: `Edit the budget for ${label}`,
			}),
		);
		const form = screen.getByRole("region", { name: "Edit budget" });
		expect(
			(within(form).getByLabelText("Limit (USD)") as HTMLInputElement).value,
		).toBe("50");
		fireEvent.change(within(form).getByLabelText("Limit (USD)"), {
			target: { value: "0" },
		});
		expect(
			within(form).getByText(
				"Everyone in this workspace cannot use all language models: a budget of $0 refuses every request it covers.",
			),
		).toBeDefined();
		fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
		expect(await screen.findByText("Budget saved.")).toBeDefined();
		expect(sent(calls, "PATCH")[0]).toMatchObject({
			path: `${base}/budgets/${existing.id}`,
			body: { limitUsd: 0, covers: { kind: "llm" } },
		});
		fireEvent.click(
			screen.getByRole("checkbox", { name: `Use the budget for ${label}` }),
		);
		await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(2));
		expect(sent(calls, "PATCH")[1].body).toEqual({ enabled: false });
		fireEvent.click(
			screen.getByRole("button", { name: `Delete the budget for ${label}` }),
		);
		const confirm = screen.getByRole("button", {
			name: `Confirm delete the budget for ${label}`,
		});
		expect(document.activeElement).toBe(confirm);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: `Delete the budget for ${label}` }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: `Delete the budget for ${label}` }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: `Confirm delete the budget for ${label}`,
			}),
		);
		expect(await screen.findByText("Budget deleted.")).toBeDefined();
		expect(sent(calls, "DELETE")[0].path).toBe(
			`${base}/budgets/${existing.id}`,
		);
	});

	it("shows a member the budgets without ways to change them", async () => {
		fakeGateway({ budgets: [budget()] });
		show("member");
		await screen.findByRole("table");
		expect(screen.queryByRole("button", { name: "Add budget" })).toBeNull();
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
		expect(
			screen.getByText("Ask a workspace admin to change budgets."),
		).toBeDefined();
	});

	it("words what a budget does", () => {
		const names = {
			agent: (id: string) => ({ a1: "Researcher" })[id],
			llm: (id: string) => id,
		};
		expect(
			budgetSentence(
				{
					appliesTo: { kind: "everyone" },
					covers: { kind: "all" },
					limitUsd: 100,
					period: "month",
				},
				names,
			),
		).toBe(
			"Everyone in this workspace can spend up to $100.00 a month (UTC) on all models.",
		);
		expect(
			budgetSentence(
				{
					appliesTo: { kind: "agents", agentIds: ["a1"] },
					covers: { kind: "video-model", model: "gen4.5" },
					limitUsd: 7.5,
					period: "day",
				},
				names,
			),
		).toBe("Researcher can spend up to $7.50 a day (UTC) on Runway Gen-4.5.");
		expect(
			budgetSentence(
				{
					appliesTo: { kind: "agents", agentIds: ["a1", "gone"] },
					covers: { kind: "video" },
					limitUsd: 3,
					period: "month",
				},
				names,
			),
		).toBe(
			"Researcher and a removed agent can together spend up to $3.00 a month (UTC) on all video models.",
		);
	});
});

describe("Models page tabs", () => {
	it("opens the Budget tab from the Video tab's limits", async () => {
		setCurrentWorkspace(WORKSPACE);
		window.history.replaceState(null, "", `#/w/${WORKSPACE}/models/video`);
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const path = String(input instanceof Request ? input.url : input).replace(
				/^https?:\/\/[^/]+/,
				"",
			);
			if (path === `${base}/video`)
				return json({
					available: true,
					configured: false,
					connections: [],
					policy: {
						order: [],
						callerVideosPerDay: 10,
						maxDurationSeconds: 10,
						revision: 0,
					},
					spend: { month: "2026-11", spentUsd: 0 },
					persistence: "memory",
				});
			if (path === `${base}/budgets`)
				return json({ policies: [], persistence: "memory" });
			if (path === `${base}/agents`)
				return json({ agents: [], persistence: "memory" });
			if (path.endsWith("/video/jobs"))
				return json({ jobs: [], nextBefore: null });
			return json({ error: { message: "not here" } }, 404);
		});
		render(<ModelsView workspace={{ isDefault: true, role: "admin" }} />);
		expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
			"LLM",
			"Video",
			"Budget",
			"Routing",
		]);
		expect(
			screen.getByRole("tab", { name: "Video", selected: true }),
		).toBeDefined();
		fireEvent.click(
			await screen.findByRole("button", { name: "Open the Budget tab" }),
		);
		expect(
			screen.getByRole("tab", { name: "Budget", selected: true }),
		).toBeDefined();
		expect(window.location.hash).toBe(`#/w/${WORKSPACE}/models/budget`);
		expect(await screen.findByText("No budgets")).toBeDefined();
	});
});

describe("Budget tab against the gateway", () => {
	const closers: Array<() => Promise<void>> = [];
	afterEach(async () => {
		cleanup();
		clearCredential();
		for (const close of closers.splice(0)) await close();
		vi.unstubAllEnvs();
		window.history.replaceState(null, "", "/");
		window.localStorage.clear();
	});

	it("starts with the video budget, and adds one for everyone", async () => {
		const server = createServer({
			config: { providers: [], corsOrigins: ["*"] },
			logger: false,
		});
		const url = await server.listen({ host: "127.0.0.1", port: 0 });
		closers.push(() => stopServer(server));
		vi.stubEnv("VITE_API_URL", url);
		const owner = await setUpOwner(url);
		const workspaceId = await defaultWorkspaceId(url, owner);
		window.history.replaceState(null, "", "#/models/budget");
		render(<App />);
		const table = await screen.findByRole("table");
		expect(within(table).getAllByRole("row")[1].textContent).toContain(
			"All video models",
		);
		expect(window.location.hash).toBe(`#/w/${workspaceId}/models/budget`);
		fireEvent.click(screen.getByRole("button", { name: "Add budget" }));
		const form = screen.getByRole("region", { name: "Add a budget" });
		fireEvent.change(within(form).getByLabelText("Limit (USD)"), {
			target: { value: "150" },
		});
		fireEvent.click(within(form).getByRole("button", { name: "Add budget" }));
		expect(await screen.findByText("Budget added.")).toBeDefined();
		const saved = (await (
			await fetch(`${url}/v1/${workspaceId}/budgets`, {
				headers: { authorization: `Bearer ${owner}` },
			})
		).json()) as BudgetList;
		expect(
			saved.policies.map((item) => [item.covers.kind, item.limitUsd]),
		).toEqual([
			["video", 25],
			["all", 150],
		]);
	});
});

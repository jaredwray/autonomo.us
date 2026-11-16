import type { BotDetails, BotWebRequest } from "@autonomo.us/common";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	approvedSiteProblem,
	InstructionsAgent,
	InstructionsForm,
} from "../src/AgentInstructions.js";
import { setCurrentWorkspace } from "../src/api.js";
import { changeControl } from "./controls.js";

// The web scope of an agent with instructions against a fake gateway: each
// test holds the bot and its approval requests and answers the dashboard's
// requests from them, recording what was sent.

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const BOT = "33333333-3333-4333-8333-333333333333";
const base = `/v1/${WORKSPACE}`;
const CHOICES = [{ value: "stub/chat-model", label: "stub/chat-model" }];

function bot(overrides: Partial<BotDetails> = {}): BotDetails {
	return {
		id: BOT,
		workspaceId: WORKSPACE,
		name: "Scout",
		instructions: "Read what people link.",
		model: "stub/chat-model",
		enabled: true,
		agentHops: 0,
		tools: false,
		web: true,
		webScope: "mentioned",
		webFollowUps: "same-site",
		webHosts: [],
		limits: {
			repliesPerHour: 30,
			tokensPerDay: 500_000,
			maxOutputTokens: 1500,
			contextMessages: 30,
			proxyRequestsPerDay: 20,
		},
		createdAt: "2026-11-14T10:00:00.000Z",
		createdBy: "Ada",
		updatedAt: "2026-11-14T10:00:00.000Z",
		revision: 1,
		repliesLastHour: 0,
		tokensToday: 0,
		runs: [],
		...overrides,
	};
}

function request(overrides: Partial<BotWebRequest>): BotWebRequest {
	return {
		id: "r1",
		botId: BOT,
		workspaceId: WORKSPACE,
		host: "docs.example.com",
		url: "https://docs.example.com/guide",
		channelId: null,
		status: "pending",
		count: 1,
		requestedAt: "2026-11-14T11:00:00.000Z",
		decidedAt: null,
		decidedBy: null,
		...overrides,
	};
}

type Call = { method: string; path: string; body?: Record<string, unknown> };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** Answers the bot and web request routes from `state`, recording each call. */
function fakeGateway(state: { bot: BotDetails; requests: BotWebRequest[] }) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		const method = init?.method ?? "GET";
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body });
		if (method === "POST" && path === `${base}/bots`) {
			state.bot = bot({ ...body, revision: 1 });
			return json(state.bot, 201);
		}
		if (method === "GET" && path === `${base}/bots/${BOT}`)
			return json(structuredClone(state.bot));
		if (method === "GET" && path === `${base}/bots/${BOT}/web-requests`)
			return json({ requests: structuredClone(state.requests) });
		const decide = new RegExp(
			`^${base}/bots/${BOT}/web-requests/([^/]+)/decide$`,
		);
		const match = decide.exec(path);
		if (method === "POST" && match) {
			const found = state.requests.find((item) => item.id === match[1]);
			if (!found) return json({ error: { message: "Not found." } }, 404);
			found.status = body.approve ? "approved" : "denied";
			found.decidedAt = "2026-11-14T12:00:00.000Z";
			found.decidedBy = "Ada";
			if (body.approve)
				state.bot = {
					...state.bot,
					webHosts: [...state.bot.webHosts, found.host],
					revision: state.bot.revision + 1,
				};
			return json(found);
		}
		return json({ error: { message: `Unexpected ${method} ${path}` } }, 404);
	});
	return calls;
}

const field = (label: string) =>
	screen.getByLabelText(label) as HTMLInputElement;
const radio = (name: string) =>
	screen.getByRole("radio", {
		name: new RegExp(`^${name}`),
	}) as HTMLInputElement;

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	setCurrentWorkspace(null);
});

describe("an agent's web scope", () => {
	it("shows the scope only with web access on and sends it with a new agent", async () => {
		const calls = fakeGateway({ bot: bot(), requests: [] });
		setCurrentWorkspace(WORKSPACE);
		const saved = vi.fn();
		render(<InstructionsForm choices={CHOICES} onSaved={saved} />);
		expect(screen.queryByText("Web scope")).toBeNull();
		fireEvent.click(field("Web access"));
		expect(screen.getByText("Web scope")).toBeDefined();
		// A new agent starts with links people post and same-site follow-ups.
		expect(radio("Only links people post").checked).toBe(true);
		expect(field("Follow-up fetches in one reply").textContent).toBe(
			"Only the same site",
		);
		expect(screen.getByText("No approved sites yet.")).toBeDefined();

		fireEvent.click(radio("Only approved sites"));
		changeControl(field("Follow-up fetches in one reply"), {
			target: { value: "none" },
		});
		const site = field("Site to approve");
		const add = () =>
			fireEvent.click(screen.getByRole("button", { name: "Add site" }));
		changeControl(site, { target: { value: "https://example.org/page" } });
		add();
		expect(screen.getByRole("alert").textContent).toMatch(/without https:\/\//);
		changeControl(site, { target: { value: " Docs.Example.com. " } });
		add();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("docs.example.com")).toBeDefined();
		changeControl(site, { target: { value: "docs.example.com" } });
		add();
		expect(screen.getByRole("alert").textContent).toBe(
			"docs.example.com is already approved.",
		);
		changeControl(site, { target: { value: "example.org" } });
		fireEvent.keyDown(site, { key: "Enter" });
		fireEvent.click(
			screen.getByRole("button", { name: "Remove docs.example.com" }),
		);
		expect(screen.queryByText("docs.example.com")).toBeNull();

		changeControl(field("Name"), { target: { value: "Scout" } });
		fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
		await waitFor(() => expect(saved).toHaveBeenCalled());
		const created = calls.find((call) => call.method === "POST")?.body;
		expect(created).toMatchObject({
			name: "Scout",
			web: true,
			webScope: "approved",
			webFollowUps: "none",
			webHosts: ["example.org"],
		});
	});

	it("lists sites waiting for approval and approves one into the approved sites", async () => {
		const state = {
			bot: bot(),
			requests: [
				request({ id: "r1", count: 3 }),
				request({
					id: "r0",
					host: "old.example.net",
					url: "https://old.example.net/",
					status: "denied",
					decidedAt: "2026-11-14T09:00:00.000Z",
					decidedBy: "Ada",
				}),
			],
		};
		const calls = fakeGateway(state);
		setCurrentWorkspace(WORKSPACE);
		render(
			<InstructionsAgent
				id={BOT}
				admin
				choices={CHOICES}
				channels={new Map()}
				created={false}
				onSaved={() => {}}
				onDeleted={() => {}}
				onError={() => {}}
			/>,
		);
		const waiting = within(
			await screen.findByRole("region", { name: "Waiting for approval" }),
		);
		const row = (await waiting.findByText("docs.example.com")).closest("tr");
		if (!row) throw new Error("No request row");
		expect(
			within(row).getByText("https://docs.example.com/guide"),
		).toBeDefined();
		expect(within(row).getByText("3 times")).toBeDefined();
		expect(
			within(waiting.getByRole("list", { name: "Recently decided" })).getByText(
				"old.example.net",
			),
		).toBeDefined();

		fireEvent.click(
			waiting.getByRole("button", { name: "Approve docs.example.com" }),
		);
		await waitFor(() =>
			expect(waiting.getByText("No sites waiting for approval.")).toBeDefined(),
		);
		expect(
			calls.find((call) => call.path.endsWith("/web-requests/r1/decide")),
		).toMatchObject({ method: "POST", body: { approve: true } });
		// The agent is read again, so its form shows the newly approved site.
		await waitFor(() =>
			expect(
				screen.getByRole("list", { name: "Approved sites" }).textContent,
			).toContain("docs.example.com"),
		);
	});

	it("shows a member the scope and requests without a way to decide", async () => {
		fakeGateway({
			bot: bot({ webScope: "approved", webHosts: ["example.org"] }),
			requests: [request({ id: "r1" })],
		});
		setCurrentWorkspace(WORKSPACE);
		render(
			<InstructionsAgent
				id={BOT}
				admin={false}
				choices={CHOICES}
				channels={new Map()}
				created={false}
				onSaved={() => {}}
				onDeleted={() => {}}
				onError={() => {}}
			/>,
		);
		const waiting = within(
			await screen.findByRole("region", { name: "Waiting for approval" }),
		);
		expect(await waiting.findByText("docs.example.com")).toBeDefined();
		expect(waiting.queryByRole("button")).toBeNull();
		expect(screen.getByText("Only approved sites")).toBeDefined();
		expect(screen.getByText("Only the same site")).toBeDefined();
		expect(screen.getByText("example.org")).toBeDefined();
		expect(screen.queryByRole("radio")).toBeNull();
	});

	it("starts an agent saved before web scopes at the defaults", async () => {
		const older = bot();
		for (const key of ["webScope", "webFollowUps", "webHosts"] as const)
			delete (older as Partial<BotDetails>)[key];
		fakeGateway({ bot: older, requests: [] });
		setCurrentWorkspace(WORKSPACE);
		render(
			<InstructionsAgent
				id={BOT}
				admin
				choices={CHOICES}
				channels={new Map()}
				created={false}
				onSaved={() => {}}
				onDeleted={() => {}}
				onError={() => {}}
			/>,
		);
		await screen.findByText("Web scope");
		expect(radio("Only links people post").checked).toBe(true);
		expect(field("Follow-up fetches in one reply").textContent).toBe(
			"Only the same site",
		);
		// Nothing has changed yet, so there is nothing to save.
		expect(
			(
				screen.getByRole("button", {
					name: "Save changes",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			await screen.findByText("No sites waiting for approval."),
		).toBeDefined();
	});

	it("checks a site before it is added", () => {
		expect(approvedSiteProblem("example.com", [])).toBeNull();
		expect(approvedSiteProblem("EXAMPLE.com.", [])).toBeNull();
		expect(approvedSiteProblem("", [])).toMatch(/Enter a site/);
		expect(approvedSiteProblem("localhost", [])).toMatch(/not a site name/);
		expect(approvedSiteProblem("example.com/path", [])).toMatch(/without/);
		expect(approvedSiteProblem("a.com", ["a.com"])).toMatch(/already approved/);
		const full = Array.from({ length: 100 }, (_, index) => `s${index}.com`);
		expect(approvedSiteProblem("new.com", full)).toMatch(/at most 100/);
	});
});

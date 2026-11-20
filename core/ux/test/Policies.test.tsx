import type {
	AgentSummary,
	VideoConnection,
	VideoLimit,
	VideoSettings,
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
import { PoliciesPanel } from "../src/PoliciesView.js";
import { videoLimitSentence } from "../src/VideoLimitsView.js";
import { changeControl, dropdownOptions } from "./controls.js";
import { defaultWorkspaceId, setUpOwner, stopServer } from "./session.js";

// Video limits on the Policies tab, and choosing which kind of policy to
// add, against a fake gateway that answers from `state` and records what
// the page sent. Budgets have their own tests in Budget.test.tsx.

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const base = `/v1/${WORKSPACE}`;

function connection(
	overrides: Partial<VideoConnection> & Pick<VideoConnection, "name" | "kind">,
): VideoConnection {
	return {
		keyConfigured: true,
		enabled: true,
		source: "saved",
		usage: { month: "2026-11", videos: 0, costUsd: 0 },
		problem: null,
		...overrides,
	};
}
function limit(overrides: Partial<VideoLimit> = {}): VideoLimit {
	return {
		id: "lim-1",
		appliesTo: { kind: "everyone" },
		covers: { kind: "video" },
		videosPerDay: 10,
		maxDurationSeconds: 10,
		enabled: true,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
		...overrides,
	};
}
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
function settings(overrides: Partial<VideoSettings> = {}): VideoSettings {
	return {
		available: true,
		configured: true,
		connections: [],
		policy: { order: [], revision: 2 },
		limits: [],
		spend: { month: "2026-11", spentUsd: 0 },
		persistence: "memory",
		...overrides,
	};
}

type Call = { method: string; path: string; body?: Record<string, unknown> };
type Handler = (call: Call) => Response | Promise<Response> | undefined;
type State = { settings: VideoSettings; agents?: AgentSummary[] };
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
const failure = (status: number, message: string) =>
	json({ error: { message } }, status);

/** Answers the page's reads from `state`, and anything else from `handler`. */
function fakeGateway(state: State, handler: Handler = () => undefined) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		const method = init?.method ?? "GET";
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const call = { method, path, body };
		calls.push(call);
		const answer = await handler(call);
		if (answer) return answer;
		if (method === "GET" && path === `${base}/video`)
			return json(structuredClone(state.settings));
		if (method === "GET" && path === `${base}/budgets`)
			return json({ policies: [], persistence: "memory" });
		if (method === "GET" && path === `${base}/agents`)
			return json({ agents: state.agents ?? [], persistence: "memory" });
		if (method === "GET" && path === `${base}/models`)
			return json({ models: [], providers: [] });
		return failure(404, `Unexpected ${method} ${path}`);
	});
	return calls;
}
const sent = (calls: Call[], method: string) =>
	calls.filter((call) => call.method === method);

function show(role: "admin" | "member" = "admin") {
	setCurrentWorkspace(WORKSPACE);
	return render(<PoliciesPanel workspace={{ isDefault: true, role }} />);
}
function type(label: string, value: string, scope: HTMLElement) {
	changeControl(within(scope).getByLabelText(label), { target: { value } });
}
/** Opens Add policy and picks Video limit. */
async function addVideoLimit() {
	fireEvent.click(await screen.findByRole("button", { name: "Add policy" }));
	fireEvent.click(screen.getByRole("radio", { name: /^Video limit/ }));
	return screen.getByRole("region", { name: "Add a video limit" });
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

describe("Add policy", () => {
	it("starts as a budget and swaps to a video limit, keeping the focus on the type", async () => {
		fakeGateway({ settings: settings() });
		show();
		await screen.findByText("No video limits");
		fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
		expect(
			(screen.getByRole("button", { name: "Add policy" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		const budget = screen.getByRole("region", { name: "Add a budget" });
		const budgetType = within(budget).getByRole("radio", { name: /^Budget/ });
		expect(document.activeElement).toBe(budgetType);
		fireEvent.click(
			within(budget).getByRole("radio", { name: /^Video limit/ }),
		);
		expect(screen.queryByRole("region", { name: "Add a budget" })).toBeNull();
		const video = screen.getByRole("region", { name: "Add a video limit" });
		const videoType = within(video).getByRole("radio", {
			name: /^Video limit/,
		}) as HTMLInputElement;
		expect(videoType.checked).toBe(true);
		expect(document.activeElement).toBe(videoType);
		fireEvent.click(
			within(video).getByRole("button", { name: "Close add video limit" }),
		);
		expect(
			screen.queryByRole("region", { name: "Add a video limit" }),
		).toBeNull();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add policy" }),
			),
		);
	});

	it("keeps the type while a save is on its way", async () => {
		let answer: (response: Response) => void = () => {};
		fakeGateway({ settings: settings() }, (call) =>
			call.method === "POST"
				? new Promise<Response>((resolve) => {
						answer = resolve;
					})
				: undefined,
		);
		show();
		await screen.findByText("No video limits");
		const form = await addVideoLimit();
		type("Videos a day (optional)", "5", form);
		fireEvent.click(within(form).getByRole("button", { name: "Add limit" }));
		await waitFor(() =>
			expect(
				(
					within(form).getByRole("radio", {
						name: /^Budget/,
					}) as HTMLInputElement
				).closest("fieldset:disabled"),
			).not.toBeNull(),
		);
		answer(json(limit({ id: "lim-9", videosPerDay: 5 }), 201));
		expect(await screen.findByText("Limit added.")).toBeDefined();
	});

	it("opens on a video limit from the empty list", async () => {
		fakeGateway({ settings: settings() });
		show();
		fireEvent.click(
			await screen.findByRole("button", { name: "Add a video limit" }),
		);
		expect(
			(screen.getByRole("radio", { name: /^Video limit/ }) as HTMLInputElement)
				.checked,
		).toBe(true);
		expect(
			screen.getByRole("region", { name: "Add a video limit" }),
		).toBeDefined();
	});

	it("cannot add a video limit while video is turned off, and shows limits read-only", async () => {
		fakeGateway({
			settings: settings({ available: false, limits: [limit()] }),
		});
		show();
		await screen.findByRole("table");
		expect(
			screen.getByText(
				"Video generation is turned off on this gateway, so video limits cannot be changed.",
			),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /^Edit the limit/ }),
		).toBeNull();
		expect(screen.queryByRole("checkbox")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
		const videoType = screen.getByRole("radio", {
			name: /^Video limit/,
		}) as HTMLInputElement;
		expect(videoType.disabled).toBe(true);
		expect(videoType.closest("label")?.textContent).toContain(
			"so video limits cannot be added",
		);
	});
});

describe("One policy form at a time", () => {
	it("closes an edit when Add policy opens, and the add form when an edit opens", async () => {
		const budget = {
			id: "b1",
			appliesTo: { kind: "everyone" as const },
			covers: { kind: "all" as const },
			limitUsd: 100,
			period: "month" as const,
			enabled: true,
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
			usage: {
				period: "2026-11",
				spentUsd: 0,
				resetsAt: "2026-12-01T00:00:00.000Z",
			},
		};
		fakeGateway({ settings: settings({ limits: [limit()] }) }, (call) =>
			call.method === "GET" && call.path === `${base}/budgets`
				? json({ policies: [budget], persistence: "memory" })
				: undefined,
		);
		show();
		const forms = () =>
			screen.queryAllByRole("region", { name: /^(Add a|Edit) / });
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Edit the budget for Everyone in this workspace on all models",
			}),
		);
		expect(screen.getByRole("region", { name: "Edit budget" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
		expect(screen.queryByRole("region", { name: "Edit budget" })).toBeNull();
		expect(screen.getByRole("region", { name: "Add a budget" })).toBeDefined();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Edit the limit for Everyone in this workspace on all video models",
			}),
		);
		expect(screen.queryByRole("region", { name: "Add a budget" })).toBeNull();
		expect(
			screen.getByRole("region", { name: "Edit video limit" }),
		).toBeDefined();
		expect(forms()).toHaveLength(1);
		// Add policy is free again once its form has closed.
		expect(
			(screen.getByRole("button", { name: "Add policy" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("adds a video limit when budgets cannot be read", async () => {
		fakeGateway({ settings: settings({ limits: [limit()] }) }, (call) =>
			call.method === "GET" && call.path === `${base}/budgets`
				? failure(503, "The database is unavailable.")
				: undefined,
		);
		show();
		await screen.findByRole("table");
		const add = (await screen.findByRole("button", {
			name: "Add policy",
		})) as HTMLButtonElement;
		await waitFor(() => expect(add.disabled).toBe(false));
		fireEvent.click(add);
		expect(
			screen.getByRole("region", { name: "Add a video limit" }),
		).toBeDefined();
		const budgetType = screen.getByRole("radio", {
			name: /^Budget/,
		}) as HTMLInputElement;
		expect(budgetType.disabled).toBe(true);
		expect(budgetType.closest("label")?.textContent).toContain(
			"Budgets could not be loaded",
		);
	});
});

describe("Video limits on the Policies tab", () => {
	it("adds a limit for chosen agents on one model, reading back what it does", async () => {
		const state: State = {
			settings: settings(),
			agents: [agent("a1", "Researcher"), agent("a2", "Writer")],
		};
		const calls = fakeGateway(state, (call) => {
			if (call.method !== "POST" || call.path !== `${base}/video/limits`)
				return undefined;
			const added = limit({
				id: "lim-2",
				...(call.body as Partial<VideoLimit>),
			});
			state.settings.limits.push(added);
			return json(added, 201);
		});
		show();
		await screen.findByText("No video limits");
		const form = await addVideoLimit();
		const add = within(form).getByRole("button", {
			name: "Add limit",
		}) as HTMLButtonElement;
		// Nothing is connected, so every model says so.
		type("Covers", "video-model", form);
		expect(
			dropdownOptions(within(form).getByLabelText("Video model"))[0]
				.textContent,
		).toBe("Gemini Omni 1.2 Flash (Google Gemini Omni, not connected)");
		type("Covers", "video", form);
		expect(
			within(form).getByText("Set videos a day, the longest video, or both."),
		).toBeDefined();
		expect(add.disabled).toBe(true);
		fireEvent.click(within(form).getByLabelText(/Specific agents/));
		type("Videos a day (optional)", "2", form);
		expect(within(form).getByText("Pick at least one agent.")).toBeDefined();
		fireEvent.click(within(form).getByLabelText(/Researcher/));
		fireEvent.click(within(form).getByLabelText(/Writer/));
		type("Covers", "video-model", form);
		type("Video model", "gen4.5", form);
		expect(
			within(form).getByText(
				"Researcher and Writer can each start up to 2 videos a day (UTC) on Runway Gen-4.5.",
			),
		).toBeDefined();
		type("Longest video (seconds) (optional)", "45", form);
		expect(
			within(form).getByText(
				/The longest video is a whole number of seconds from 2 to 30/,
			),
		).toBeDefined();
		type("Longest video (seconds) (optional)", "6", form);
		expect(
			within(form).getByText(
				"Researcher and Writer can each start up to 2 videos a day (UTC) on Runway Gen-4.5, each up to 6 seconds long.",
			),
		).toBeDefined();
		fireEvent.click(add);
		expect(await screen.findByText("Limit added.")).toBeDefined();
		expect(sent(calls, "POST")[0]).toMatchObject({
			path: `${base}/video/limits`,
			body: {
				appliesTo: { kind: "agents", agentIds: ["a1", "a2"] },
				covers: { kind: "video-model", model: "gen4.5" },
				videosPerDay: 2,
				maxDurationSeconds: 6,
			},
		});
		const row = within(await screen.findByRole("table"))
			.getAllByRole("row")
			.find((item) => item.textContent?.includes("Researcher and Writer"));
		expect(row?.textContent).toContain("Runway Gen-4.5");
		expect(row?.textContent).toContain("2per agent");
		expect(row?.textContent).toContain("6 seconds");
		expect(
			within(screen.getByRole("region", { name: "Policy overview" })).getByText(
				"Video limits",
			).parentElement?.textContent,
		).toContain("1");
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add policy" }),
			),
		);
	});

	it("edits a limit, switches it off, and deletes it after confirming", async () => {
		const state: State = { settings: settings({ limits: [limit()] }) };
		const calls = fakeGateway(state, (call) => {
			if (call.path !== `${base}/video/limits/lim-1`) return undefined;
			if (call.method === "PATCH") {
				const saved = { ...state.settings.limits[0], ...call.body };
				state.settings.limits = [saved as VideoLimit];
				return json(saved);
			}
			if (call.method === "DELETE") {
				state.settings.limits = [];
				return new Response(null, { status: 204 });
			}
		});
		show();
		const label =
			"the limit for Everyone in this workspace on all video models";
		const edit = await screen.findByRole("button", { name: `Edit ${label}` });
		fireEvent.click(edit);
		const form = screen.getByRole("region", { name: "Edit video limit" });
		// Editing has no type to choose.
		expect(within(form).queryByRole("radio", { name: /^Budget/ })).toBeNull();
		expect(
			within(form).getByText(
				"Each person, API token, and agent can start up to 10 videos a day (UTC) on any video model, each up to 10 seconds long.",
			),
		).toBeDefined();
		type("Videos a day (optional)", "", form);
		expect(
			within(form).getByText(
				"Videos anyone in this workspace starts on any video model can be up to 10 seconds long.",
			),
		).toBeDefined();
		fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
		expect(await screen.findByText("Limit saved.")).toBeDefined();
		// Only what changed is sent.
		expect(sent(calls, "PATCH")[0].body).toEqual({ videosPerDay: null });
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: `Edit ${label}` }),
			),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: `Use ${label}` }));
		await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(2));
		expect(sent(calls, "PATCH")[1].body).toEqual({ enabled: false });
		fireEvent.click(screen.getByRole("button", { name: `Delete ${label}` }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: `Confirm delete ${label}` }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: `Delete ${label}` }),
		);
		fireEvent.click(screen.getByRole("button", { name: `Delete ${label}` }));
		fireEvent.click(
			screen.getByRole("button", { name: `Confirm delete ${label}` }),
		);
		expect(await screen.findByText("Limit deleted.")).toBeDefined();
		expect(sent(calls, "DELETE")).toHaveLength(1);
		expect(await screen.findByText("No video limits")).toBeDefined();
		// Its row is gone, so the focus goes to the list's heading.
		expect(document.activeElement).toBe(
			screen.getByRole("heading", { name: "Video limits" }),
		);
	});

	it("offers the connected providers' models first, and starts on one", async () => {
		fakeGateway({
			settings: settings({
				connections: [connection({ name: "runway", kind: "runway" })],
			}),
		});
		show();
		await screen.findByText("No video limits");
		const form = await addVideoLimit();
		type("Covers", "video-model", form);
		const options = dropdownOptions(within(form).getByLabelText("Video model"));
		expect(options[0].textContent).toBe("Seedance 2.5 (Runway)");
		expect(options.at(-1)?.textContent).toContain(", not connected)");
		type("Videos a day (optional)", "1", form);
		expect(
			within(form).getByText(
				"Each person, API token, and agent can start up to 1 video a day (UTC) on Seedance 2.5.",
			),
		).toBeDefined();
	});

	it("shows the gateway's reason when a limit cannot be saved", async () => {
		fakeGateway({ settings: settings() }, (call) =>
			call.method === "POST"
				? failure(409, "A workspace holds at most 50 video limits.")
				: undefined,
		);
		show();
		await screen.findByText("No video limits");
		const form = await addVideoLimit();
		type("Videos a day (optional)", "5", form);
		fireEvent.click(within(form).getByRole("button", { name: "Add limit" }));
		expect(
			await within(form).findByText(
				"A workspace holds at most 50 video limits.",
			),
		).toBeDefined();
	});

	it("shows a member the limits without ways to change them", async () => {
		fakeGateway({ settings: settings({ limits: [limit()] }) });
		show("member");
		await screen.findByRole("table");
		expect(screen.queryByRole("button", { name: "Add policy" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /^Edit the limit/ }),
		).toBeNull();
		expect(screen.queryByRole("checkbox")).toBeNull();
		// The note for members is about policies, not video being off.
		expect(screen.queryByText(/so video limits cannot be changed/)).toBeNull();
	});

	it("keeps budgets working when the video settings cannot be read", async () => {
		fakeGateway({ settings: settings() }, (call) =>
			call.path === `${base}/video`
				? failure(503, "The database is unavailable.")
				: undefined,
		);
		show();
		expect(await screen.findByText("No budgets")).toBeDefined();
		expect(screen.getByText("Video limits could not be loaded.")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
		expect(
			(screen.getByRole("radio", { name: /^Video limit/ }) as HTMLInputElement)
				.disabled,
		).toBe(true);
	});

	it("says what a limit does", () => {
		const names = { agent: (id: string) => ({ a1: "Researcher" })[id] };
		const sentence = (overrides: Partial<VideoLimit>) =>
			videoLimitSentence({ ...limit(), ...overrides }, names);
		expect(sentence({ maxDurationSeconds: null, videosPerDay: 1 })).toBe(
			"Each person, API token, and agent can start up to 1 video a day (UTC) on any video model.",
		);
		expect(
			sentence({
				appliesTo: { kind: "agents", agentIds: ["a1"] },
				covers: { kind: "video-model", model: "seedance2_5" },
				videosPerDay: 0,
			}),
		).toBe(
			"Researcher cannot start videos on Seedance 2.5: a limit of 0 a day refuses every one.",
		);
		expect(sentence({ videosPerDay: 0 })).toContain(
			"No one in this workspace can start videos",
		);
		expect(
			sentence({
				appliesTo: { kind: "agents", agentIds: ["a1", "gone"] },
				videosPerDay: null,
				maxDurationSeconds: 6,
			}),
		).toBe(
			"Videos Researcher and a removed agent start on any video model can be up to 6 seconds long.",
		);
	});
});

describe("Policies against the gateway", () => {
	const closers: Array<() => Promise<void>> = [];
	afterEach(async () => {
		cleanup();
		clearCredential();
		for (const close of closers.splice(0)) await close();
		vi.unstubAllEnvs();
		window.history.replaceState(null, "", "/");
		window.localStorage.clear();
	});

	it("changes the starting video limit on the Policies tab", async () => {
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
				await fetch(`${url}/v1/${workspaceId}/video`, {
					headers: { authorization: `Bearer ${owner}` },
				})
			).json()) as VideoSettings;
		window.history.replaceState(null, "", "#/models/policies");
		render(<App />);
		// Every workspace starts with one limit for everyone on every model.
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Edit the limit for Everyone in this workspace on all video models",
			}),
		);
		const edit = screen.getByRole("region", { name: "Edit video limit" });
		type("Videos a day (optional)", "3", edit);
		fireEvent.click(within(edit).getByRole("button", { name: "Save changes" }));
		expect(await screen.findByText("Limit saved.")).toBeDefined();
		expect((await read()).limits).toMatchObject([
			{
				appliesTo: { kind: "everyone" },
				covers: { kind: "video" },
				videosPerDay: 3,
				maxDurationSeconds: 10,
			},
		]);
	});
});

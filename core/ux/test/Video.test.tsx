import type {
	VideoConnection,
	VideoLimit,
	VideoPolicy,
	VideoSettings,
} from "@autonomo.us/common";
import { createServer } from "@autonomo.us/server";
import {
	act,
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
import { modelsHash, parseModelsTab } from "../src/models-route.js";
import { VideoPanel } from "../src/VideoView.js";
import { changeControl, dropdownOptions } from "./controls.js";
import { defaultWorkspaceId, setUpOwner, stopServer } from "./session.js";

// The Video view against a fake gateway: each test holds the workspace's
// video state and answers the dashboard's requests from it, recording what
// was sent. No provider is ever called.

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
function policy(overrides: Partial<VideoPolicy> = {}): VideoPolicy {
	return { order: [], revision: 2, ...overrides };
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
function settings(overrides: Partial<VideoSettings> = {}): VideoSettings {
	return {
		available: true,
		configured: true,
		connections: [],
		policy: policy(),
		limits: [],
		spend: { month: "2026-11", spentUsd: 0 },
		persistence: "memory",
		...overrides,
	};
}
type Call = {
	method: string;
	path: string;
	body?: Record<string, unknown>;
	signal?: AbortSignal;
};
type Handler = (call: Call) => Response | Promise<Response> | undefined;
type State = { settings: VideoSettings };

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
		const call: Call = {
			method,
			path,
			body,
			...(init?.signal ? { signal: init.signal } : {}),
		};
		calls.push(call);
		const answer = await handler(call);
		if (answer) return answer;
		if (method === "GET" && path === `${base}/video`)
			return json(structuredClone(state.settings));
		return failure(404, `Unexpected ${method} ${path}`);
	});
	return calls;
}
const sent = (calls: Call[], method: string) =>
	calls.filter((call) => call.method === method);

function show(role: "admin" | "member" = "admin", hash = "") {
	setCurrentWorkspace(WORKSPACE);
	window.history.replaceState(null, "", hash || "/");
	return render(<VideoPanel workspace={{ isDefault: true, role }} />);
}
function type(
	label: string,
	value: string,
	scope: HTMLElement = document.body,
) {
	changeControl(within(scope).getByLabelText(label), { target: { value } });
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

describe("Video view: settings", () => {
	it("lists connections with their kind, key, model, price, usage and problem", async () => {
		fakeGateway({
			settings: settings({
				connections: [
					connection({
						name: "runway",
						kind: "runway",
						source: "environment",
						usage: { month: "2026-11", videos: 3, costUsd: 4.5 },
					}),
					connection({
						name: "luma",
						kind: "luma",
						defaultModel: "ray-3.2",
						creditPriceUsd: 0.008,
						enabled: false,
						problem: {
							kind: "key",
							detail: "Luma: the API key was refused (HTTP 401)",
							at: "2026-11-19T00:00:00Z",
						},
					}),
				],
				spend: { month: "2026-11", spentUsd: 4.5 },
			}),
		});
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		const table = await screen.findByRole("table");
		const rows = within(table).getAllByRole("row");
		expect(rows[1].textContent).toContain("Runway · environment variable");
		expect(rows[1].textContent).toContain("Provider default (Seedance 2.5)");
		expect(rows[1].textContent).toContain("3 videos · $4.50");
		expect(
			within(rows[1]).queryByRole("button", { name: "Edit runway" }),
		).toBeNull();
		expect(rows[2].textContent).toContain("Luma Ray 3.2");
		expect(rows[2].textContent).toContain("$0.008");
		expect(rows[2].textContent).toContain("the API key was refused");
		expect(screen.getByText("$4.50")).toBeDefined();
		expect(
			screen.getByText(/temporary and last until the API restarts/),
		).toBeDefined();
	});

	it("turned off: warns, disables changes, and asks for nothing more", async () => {
		const calls = fakeGateway({
			settings: settings({
				available: false,
				connections: [connection({ name: "runway", kind: "runway" })],
			}),
		});
		show("admin");
		expect(
			await screen.findAllByText(
				/Video generation is turned off on this gateway/,
			),
		).toHaveLength(1);
		expect(
			(
				screen.getByRole("button", {
					name: "Add video provider",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(screen.queryByRole("checkbox", { name: "Use runway" })).toBeNull();
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(calls.some((call) => call.path.includes("/video/models"))).toBe(
			false,
		);
		expect(calls.some((call) => call.path.includes("/video/jobs"))).toBe(false);
	});

	it("adds a Luma provider with a suggested name, its models, and a credit price", async () => {
		const state = { settings: settings() };
		const calls = fakeGateway(state, (call) => {
			if (call.method === "POST" && call.path === `${base}/video/connections`) {
				const added = connection({
					name: "luma",
					kind: "luma",
					creditPriceUsd: 0.005,
				});
				state.settings.connections = [added];
				return json(added, 201);
			}
		});
		show("admin");
		await screen.findByText("No video providers yet");
		fireEvent.click(screen.getByRole("button", { name: "Add video provider" }));
		const form = screen.getByRole("region", { name: "Add a video provider" });
		expect(within(form).queryByLabelText(/Credit price/)).toBeNull();
		type("Provider", "luma", form);
		expect(
			(within(form).getByLabelText("Name") as HTMLInputElement).value,
		).toBe("luma");
		const options = dropdownOptions(
			within(form).getByLabelText("Default model"),
		);
		expect(options.map((option) => option.textContent)).toEqual([
			"Provider default (Luma Ray 3.2)",
			"Luma Ray 3.2",
		]);
		type("API key", "luma-secret", form);
		type("Credit price (USD) (optional)", "0.005", form);
		fireEvent.click(within(form).getByRole("button", { name: "Add provider" }));
		expect(await screen.findByText("Added luma.")).toBeDefined();
		expect(sent(calls, "POST")[0].body).toEqual({
			name: "luma",
			kind: "luma",
			apiKey: "luma-secret",
			creditPriceUsd: 0.005,
		});
	});

	it("disables Add video provider while its form is open, and focuses it on close", async () => {
		fakeGateway({ settings: settings() });
		show("admin");
		await screen.findByText("No video providers yet");
		const add = screen.getByRole("button", {
			name: "Add video provider",
		}) as HTMLButtonElement;
		fireEvent.click(add);
		expect(add.disabled).toBe(true);
		const form = screen.getByRole("region", { name: "Add a video provider" });
		fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
		expect(
			screen.queryByRole("region", { name: "Add a video provider" }),
		).toBeNull();
		expect(document.activeElement).toBe(add);
	});

	it("shows the gateway's reason when a provider cannot be added", async () => {
		fakeGateway({ settings: settings() }, (call) =>
			call.method === "POST"
				? failure(409, "A workspace holds at most 10 video connections.")
				: undefined,
		);
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		await screen.findByText("No video providers yet");
		fireEvent.click(screen.getByRole("button", { name: "Add video provider" }));
		const form = screen.getByRole("region", { name: "Add a video provider" });
		type("API key", "k", form);
		fireEvent.click(within(form).getByRole("button", { name: "Add provider" }));
		expect(
			await within(form).findByText(
				"A workspace holds at most 10 video connections.",
			),
		).toBeDefined();
	});

	it("edits a provider: keeps the key when blank and clears the default model", async () => {
		const state = {
			settings: settings({
				connections: [
					connection({
						name: "runway",
						kind: "runway",
						defaultModel: "gen4.5",
					}),
				],
			}),
		};
		const calls = fakeGateway(state, (call) =>
			call.method === "PATCH"
				? json(connection({ name: "runway", kind: "runway" }))
				: undefined,
		);
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		fireEvent.click(await screen.findByRole("button", { name: "Edit runway" }));
		const form = screen.getByRole("region", { name: "Edit runway" });
		type("Default model", "", form);
		fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
		expect(await screen.findByText("Saved runway.")).toBeDefined();
		expect(sent(calls, "PATCH")[0]).toMatchObject({
			path: `${base}/video/connections/runway`,
			body: { defaultModel: "" },
		});
		expect(sent(calls, "PATCH")[0].body).not.toHaveProperty("apiKey");
	});

	it("switches a provider off, and deletes one after confirming", async () => {
		const state = {
			settings: settings({
				connections: [connection({ name: "runway", kind: "runway" })],
			}),
		};
		const calls = fakeGateway(state, (call) => {
			if (call.method === "PATCH")
				return json(
					connection({ name: "runway", kind: "runway", enabled: false }),
				);
			if (call.method === "DELETE") {
				state.settings.connections = [];
				return new Response(null, { status: 204 });
			}
		});
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		fireEvent.click(
			await screen.findByRole("checkbox", { name: "Use runway" }),
		);
		await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(1));
		expect(sent(calls, "PATCH")[0].body).toEqual({ enabled: false });
		fireEvent.click(screen.getByRole("button", { name: "Delete runway" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Confirm delete runway" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Delete runway" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Delete runway" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Confirm delete runway" }),
		);
		expect(await screen.findByText("Deleted runway.")).toBeDefined();
		expect(sent(calls, "DELETE")).toHaveLength(1);
		expect(sent(calls, "DELETE")[0].path).toBe(
			`${base}/video/connections/runway`,
		);
	});

	it("saves each move with the revision it read, keeps focus on the moved row, and handles a stale one", async () => {
		const state = {
			settings: settings({
				connections: [
					connection({ name: "runway", kind: "runway" }),
					connection({ name: "luma", kind: "luma" }),
				],
				// The stored order can name a connection removed since.
				policy: policy({ order: ["google-video"] }),
			}),
		};
		let stale = false;
		const calls = fakeGateway(state, (call) => {
			if (call.method !== "PUT") return undefined;
			if (stale) return failure(409, "changed");
			state.settings.policy = {
				...(call.body as VideoPolicy),
				revision: 3,
			};
			return json(state.settings.policy);
		});
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		const order = await screen.findByRole("list", { name: "Provider order" });
		expect(
			within(order)
				.getAllByRole("listitem")
				.map((item) => item.querySelector("code")?.textContent),
		).toEqual(["runway", "luma"]);
		fireEvent.click(screen.getByRole("button", { name: "Move luma up" }));
		expect(
			await screen.findByText("Saved. Videos try luma first."),
		).toBeDefined();
		expect(sent(calls, "PUT")[0]).toMatchObject({
			path: `${base}/video/policy`,
			body: { order: ["luma", "runway"], revision: 2 },
		});
		// Luma is first, so its up button is off: focus moves to its down button.
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Move luma down" }),
		);
		stale = true;
		const reads = calls.filter(
			(call) => call.method === "GET" && call.path === `${base}/video`,
		).length;
		fireEvent.click(screen.getByRole("button", { name: "Move luma down" }));
		expect(
			await screen.findByText(/The order was changed elsewhere/),
		).toBeDefined();
		expect(sent(calls, "PUT")[1].body).toEqual({
			order: ["runway", "luma"],
			revision: 3,
		});
		// The latest order is read again, and the list goes back to it.
		await waitFor(() =>
			expect(
				calls.filter(
					(call) => call.method === "GET" && call.path === `${base}/video`,
				).length,
			).toBeGreaterThan(reads),
		);
		expect(
			within(order)
				.getAllByRole("listitem")
				.map((item) => item.querySelector("code")?.textContent),
		).toEqual(["luma", "runway"]);
	});

	it("has no sections for making or listing videos, and points to Policies", async () => {
		const calls = fakeGateway({
			settings: settings({
				connections: [connection({ name: "runway", kind: "runway" })],
				limits: [limit()],
			}),
		});
		const open = vi.fn();
		setCurrentWorkspace(WORKSPACE);
		render(
			<VideoPanel
				workspace={{ isDefault: true, role: "admin" }}
				onShowPolicies={open}
			/>,
		);
		await screen.findByRole("button", { name: "Edit runway" });
		expect(screen.queryByRole("heading", { name: "Make a video" })).toBeNull();
		expect(screen.queryByRole("heading", { name: "Videos" })).toBeNull();
		expect(screen.queryByRole("heading", { name: "Video limits" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Open Policies" }));
		expect(open).toHaveBeenCalledOnce();
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(
			calls
				.filter((call) => call.path !== `${base}/video`)
				.map((call) => call.path),
		).toEqual([]);
	});

	it("shows no order with one provider", async () => {
		fakeGateway({
			settings: settings({
				connections: [connection({ name: "runway", kind: "runway" })],
			}),
		});
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		await screen.findByRole("button", { name: "Edit runway" });
		expect(screen.queryByRole("list", { name: "Provider order" })).toBeNull();
	});

	it("shows a member the providers only, without asking for models or jobs", async () => {
		const calls = fakeGateway({
			settings: settings({
				connections: [
					connection({ name: "runway", kind: "runway" }),
					connection({ name: "luma", kind: "luma" }),
				],
				limits: [limit()],
			}),
		});
		show("member", `#/w/${WORKSPACE}/video`);
		expect(await screen.findAllByRole("table")).toHaveLength(1);
		expect(screen.queryByRole("tab")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Add video provider" }),
		).toBeNull();
		expect(screen.queryByRole("checkbox", { name: "Use runway" })).toBeNull();
		// One note says why there is nothing to change.
		expect(
			screen.getAllByText(/Only workspace admins change video settings/),
		).toHaveLength(1);
		expect(screen.queryByText(/Ask a workspace admin/)).toBeNull();
		// Limits are policies now: the Video tab only points to them.
		expect(screen.queryByRole("heading", { name: "Video limits" })).toBeNull();
		// The order is shown, not changed.
		expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
		expect(
			screen.getByRole("list", { name: "Provider order" }).textContent,
		).toContain("luma");
		expect(calls.some((call) => call.path.includes("/video/jobs"))).toBe(false);
		expect(calls.some((call) => call.path.includes("/video/models"))).toBe(
			false,
		);
	});
});

describe("Video helpers", () => {
	it("keeps the tab in the address", () => {
		setCurrentWorkspace(WORKSPACE);
		expect(parseModelsTab(`#/w/${WORKSPACE}/models`)).toBe("llm");
		expect(parseModelsTab(`#/w/${WORKSPACE}/models/video`)).toBe("video");
		expect(parseModelsTab(`#/w/${WORKSPACE}/models/policies`)).toBe("policies");
		// Policies was the Budget tab.
		expect(parseModelsTab(`#/w/${WORKSPACE}/models/budget`)).toBe("policies");
		expect(parseModelsTab(`#/w/${WORKSPACE}/models/routing`)).toBe("routing");
		// Links to the Video page before it became a tab of Models.
		expect(parseModelsTab(`#/w/${WORKSPACE}/video/settings`)).toBe("video");
		expect(parseModelsTab("#/video")).toBe("video");
		expect(modelsHash("video")).toBe(`#/w/${WORKSPACE}/models/video`);
		expect(modelsHash("llm")).toBe(`#/w/${WORKSPACE}/models`);
		expect(modelsHash("policies")).toBe(`#/w/${WORKSPACE}/models/policies`);
	});
});

describe("Video against the gateway", () => {
	const closers: Array<() => Promise<void>> = [];
	afterEach(async () => {
		cleanup();
		clearCredential();
		for (const close of closers.splice(0)) await close();
		vi.unstubAllEnvs();
		window.history.replaceState(null, "", "/");
		window.localStorage.clear();
	});

	it("opens from the sidebar and adds a provider", async () => {
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
		// A link to the Video page from before it became a tab of Models.
		window.history.replaceState(null, "", "#/video/settings");
		render(<App />);
		await screen.findByText("No video providers yet");
		expect(screen.queryByRole("link", { name: "Video" })).toBeNull();
		expect(
			screen.getByRole("link", { name: "Models" }).getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen.getByRole("tab", { name: "Video", selected: true }),
		).toBeDefined();
		expect(window.location.hash).toBe(`#/w/${workspaceId}/models/video`);

		fireEvent.click(screen.getByRole("button", { name: "Add video provider" }));
		const form = screen.getByRole("region", { name: "Add a video provider" });
		type("API key", "rw-secret", form);
		fireEvent.click(within(form).getByRole("button", { name: "Add provider" }));
		expect(await screen.findByText("Added runway.")).toBeDefined();
		const saved = await read();
		expect(saved.connections).toMatchObject([
			{ name: "runway", kind: "runway", keyConfigured: true, enabled: true },
		]);
		expect(JSON.stringify(saved)).not.toContain("rw-secret");
	});
});

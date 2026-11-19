import {
	VIDEO_MODELS,
	type VideoConnection,
	type VideoJob,
	type VideoKind,
	type VideoModelList,
	type VideoPolicy,
	type VideoSettings,
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
import {
	formChoices,
	VideoView,
	videoPolicyProblem,
	videoRequestProblem,
} from "../src/VideoView.js";
import { parseVideoTab, videoHash } from "../src/video-route.js";
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
	return {
		order: [],
		callerVideosPerDay: 10,
		monthlyBudgetUsd: 25,
		maxDurationSeconds: 10,
		revision: 2,
		...overrides,
	};
}
function settings(overrides: Partial<VideoSettings> = {}): VideoSettings {
	return {
		available: true,
		configured: true,
		connections: [],
		policy: policy(),
		budget: { month: "2026-11", spentUsd: 0, limitUsd: 25 },
		persistence: "memory",
		...overrides,
	};
}
function provider(name: string, kind: VideoKind, defaultModel?: string) {
	return {
		name,
		kind,
		defaultModel: defaultModel ?? VIDEO_MODELS[kind][0].id,
		models: [...VIDEO_MODELS[kind]],
	};
}
function models(overrides: Partial<VideoModelList> = {}): VideoModelList {
	return {
		available: true,
		canGenerate: true,
		providers: [
			provider("runway", "runway"),
			provider("google-video", "google"),
			provider("luma", "luma"),
		],
		limits: { maxDurationSeconds: 10, promptLength: 4000 },
		...overrides,
	};
}
let counter = 0;
function job(overrides: Partial<VideoJob> = {}): VideoJob {
	counter += 1;
	return {
		id: `vid_00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
		status: "succeeded",
		progress: null,
		provider: "runway",
		kind: "runway",
		model: "seedance2_5",
		prompt: "A lighthouse at dusk",
		durationSeconds: 5,
		aspectRatio: "16:9",
		resolution: "720p",
		hasImage: false,
		createdBy: { id: "user:1", name: "Founder", kind: "user" },
		createdAt: new Date(Date.now() - 60_000).toISOString(),
		updatedAt: new Date().toISOString(),
		completedAt: null,
		costUsd: 1.5,
		video: null,
		error: null,
		attempts: [],
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
type State = {
	settings: VideoSettings;
	models?: VideoModelList;
	jobs?: VideoJob[];
	nextBefore?: string | null;
};

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
		if (method === "GET" && path === `${base}/video/models`)
			return json(structuredClone(state.models ?? models()));
		if (method === "GET" && path.startsWith(`${base}/video/jobs?`))
			return json({ jobs: state.jobs ?? [], nextBefore: null });
		if (method === "GET" && path === `${base}/video/jobs`)
			return json({
				jobs: state.jobs ?? [],
				nextBefore: state.nextBefore ?? null,
			});
		const one = /\/video\/jobs\/([^/?]+)\?wait=10$/.exec(path);
		if (method === "GET" && one) {
			const found = (state.jobs ?? []).find((item) => item.id === one[1]);
			return found ? json(found) : failure(404, "Video job not found.");
		}
		return failure(404, `Unexpected ${method} ${path}`);
	});
	return calls;
}
const sent = (calls: Call[], method: string) =>
	calls.filter((call) => call.method === method);

function show(role: "admin" | "member" = "admin", hash = "") {
	setCurrentWorkspace(WORKSPACE);
	window.history.replaceState(null, "", hash || "/");
	return render(<VideoView workspace={{ isDefault: true, role }} />);
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
				budget: { month: "2026-11", spentUsd: 4.5, limitUsd: 25 },
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
		expect(screen.getByText("$4.50 / $25.00")).toBeDefined();
		expect(
			screen.getByText(/temporary and last until the API restarts/),
		).toBeDefined();
	});

	it("turned off: warns, disables changes, and asks for no models or jobs", async () => {
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
		).toHaveLength(2);
		expect(
			(
				screen.getByRole("button", {
					name: "Add provider",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
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
		await screen.findByText("No videos yet");
		fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
		const form = screen.getByRole("region", { name: "Add a video provider" });
		expect(window.location.hash).toBe(`#/w/${WORKSPACE}/video/settings`);
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

	it("keeps Add provider working after its form is left, and focuses it on close", async () => {
		fakeGateway({ settings: settings() });
		show("admin");
		await screen.findByText("No videos yet");
		// The page's own button; the form's submit button shares its name.
		const add = screen.getByRole("button", {
			name: "Add provider",
		}) as HTMLButtonElement;
		fireEvent.click(add);
		expect(add.disabled).toBe(true);
		fireEvent.click(screen.getByRole("tab", { name: "Videos" }));
		expect(add.disabled).toBe(false);
		fireEvent.click(add);
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
		fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
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
				state.settings.policy = policy({ revision: 3 });
				return new Response(null, { status: 204 });
			}
			if (call.method === "PUT")
				return json({ ...(call.body as VideoPolicy), revision: 4 });
		});
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		fireEvent.click(
			await screen.findByRole("checkbox", { name: "Use runway" }),
		);
		await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(1));
		expect(sent(calls, "PATCH")[0].body).toEqual({ enabled: false });
		type("Videos a day", "4");
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
		// The unsaved limit survives the delete and saves on the new revision.
		expect(
			(screen.getByLabelText("Videos a day") as HTMLInputElement).value,
		).toBe("4");
		fireEvent.click(
			screen.getByRole("button", { name: "Save limits and order" }),
		);
		await waitFor(() => expect(sent(calls, "PUT")).toHaveLength(1));
		expect(sent(calls, "PUT")[0].body).toMatchObject({
			callerVideosPerDay: 4,
			revision: 3,
			order: [],
		});
	});

	it("saves the limits without a connection the stored order still names", async () => {
		const calls = fakeGateway(
			{
				settings: settings({
					connections: [connection({ name: "runway", kind: "runway" })],
					policy: policy({ order: ["google-video", "runway"] }),
				}),
			},
			(call) =>
				call.method === "PUT"
					? json({ ...(call.body as VideoPolicy), revision: 3 })
					: undefined,
		);
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		await screen.findByRole("table");
		type("Videos a day", "4");
		fireEvent.click(
			screen.getByRole("button", { name: "Save limits and order" }),
		);
		await waitFor(() => expect(sent(calls, "PUT")).toHaveLength(1));
		expect(sent(calls, "PUT")[0].body).toMatchObject({
			order: ["runway"],
			callerVideosPerDay: 4,
		});
	});

	it("saves the order and limits with the revision it read, and handles a stale one", async () => {
		const state = {
			settings: settings({
				connections: [
					connection({ name: "runway", kind: "runway" }),
					connection({ name: "luma", kind: "luma" }),
				],
			}),
		};
		let stale = false;
		const calls = fakeGateway(state, (call) => {
			if (call.method !== "PUT") return undefined;
			if (stale) return failure(409, "changed");
			return json({ ...(call.body as VideoPolicy), revision: 3 });
		});
		show("admin", `#/w/${WORKSPACE}/video/settings`);
		fireEvent.click(
			await screen.findByRole("button", { name: "Move luma up" }),
		);
		type("Videos a day", "4");
		type("Longest video (seconds)", "8");
		fireEvent.click(
			screen.getByRole("button", { name: "Save limits and order" }),
		);
		expect(
			await within(
				screen.getByRole("form", { name: "Limits and order" }),
			).findByText("Saved"),
		).toBeDefined();
		expect(sent(calls, "PUT")[0].body).toEqual({
			order: ["luma", "runway"],
			callerVideosPerDay: 4,
			monthlyBudgetUsd: 25,
			maxDurationSeconds: 8,
			revision: 2,
		});
		stale = true;
		type("Monthly budget (USD)", "40");
		fireEvent.click(
			screen.getByRole("button", { name: "Save limits and order" }),
		);
		expect(
			await screen.findByText(/The video settings changed elsewhere/),
		).toBeDefined();
		expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
		type("Longest video (seconds)", "45");
		expect(
			screen.getByText(
				/The longest video is a whole number of seconds from 2 to 30/,
			),
		).toBeDefined();
	});

	it("shows a member the providers and limits only, without asking for jobs", async () => {
		const calls = fakeGateway({
			settings: settings({
				connections: [connection({ name: "runway", kind: "runway" })],
			}),
		});
		show("member", `#/w/${WORKSPACE}/video`);
		await screen.findByRole("table");
		expect(screen.queryByRole("tab")).toBeNull();
		expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
		expect(screen.queryByRole("checkbox", { name: "Use runway" })).toBeNull();
		expect(
			screen.getByText("Only workspace admins see and make videos."),
		).toBeDefined();
		expect(
			screen.getByLabelText("Videos a day").closest("fieldset")?.disabled,
		).toBe(true);
		expect(calls.some((call) => call.path.includes("/video/jobs"))).toBe(false);
		expect(calls.some((call) => call.path.includes("/video/models"))).toBe(
			false,
		);
	});
});

describe("Video view: making and following videos", () => {
	it("narrows the form to what the chosen model makes", async () => {
		fakeGateway({ settings: settings(), models: models() });
		show("admin");
		await screen.findByRole("heading", { name: "Make a video" });
		type("Provider", "runway");
		type("Model", "gen4.5");
		expect(
			dropdownOptions(screen.getByLabelText("Resolution")).map(
				(option) => option.textContent,
			),
		).toEqual(["720p"]);
		const duration = screen.getByLabelText(
			"Duration (seconds)",
		) as HTMLInputElement;
		expect([duration.min, duration.max]).toEqual(["2", "10"]);
		expect(screen.getByLabelText(/Start from an image/)).toBeDefined();
		type("Provider", "google-video");
		expect(screen.queryByLabelText(/Start from an image/)).toBeNull();
		expect(
			dropdownOptions(screen.getByLabelText("Aspect ratio")).map((option) =>
				option.getAttribute("data-value"),
			),
		).toEqual(["16:9", "9:16"]);
	});

	it("refuses a model that cannot fit the workspace's longest video", async () => {
		fakeGateway({
			settings: settings(),
			models: models({
				providers: [provider("luma", "luma")],
				limits: { maxDurationSeconds: 4, promptLength: 4000 },
			}),
		});
		show("admin");
		expect(
			await screen.findAllByText(
				"Luma Ray 3.2 makes videos of at least 5 seconds, longer than this workspace allows (4 s).",
			),
		).not.toHaveLength(0);
		expect(
			(screen.getByRole("button", { name: "Make video" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("on Automatic, follows the first provider whose default fits the longest video", async () => {
		const calls = fakeGateway(
			{
				settings: settings(),
				models: models({
					providers: [provider("luma", "luma"), provider("runway", "runway")],
					limits: { maxDurationSeconds: 4, promptLength: 4000 },
				}),
			},
			(call) =>
				call.method === "POST" && call.path === `${base}/video/jobs`
					? json(job({ status: "queued", durationSeconds: 4 }), 202)
					: undefined,
		);
		show("admin");
		await screen.findByRole("heading", { name: "Make a video" });
		expect(screen.queryByText(/makes videos of at least/)).toBeNull();
		expect(screen.getByText(/These choices follow Seedance 2.5 on runway/));
		type("Prompt", "A paper boat");
		const make = screen.getByRole("button", {
			name: "Make video",
		}) as HTMLButtonElement;
		expect(make.disabled).toBe(false);
		fireEvent.click(make);
		await waitFor(() => expect(sent(calls, "POST")).toHaveLength(1));
		expect(sent(calls, "POST")[0].body).toEqual({
			prompt: "A paper boat",
			durationSeconds: 4,
			aspectRatio: "16:9",
			resolution: "720p",
		});
	});

	it("keeps a video started during a list read, and lists it only once", async () => {
		const old = job({ prompt: "An old video" });
		const failed = (prompt: string) =>
			job({
				status: "failed",
				prompt,
				error: { code: "provider_error", message: "Runway: outage" },
			});
		const state: State = { settings: settings(), jobs: [old] };
		const held: { list?: () => void; post?: () => void } = {};
		let next = failed("First");
		let reads = 0;
		fakeGateway(state, (call) => {
			if (call.method === "GET" && call.path === `${base}/video/jobs`) {
				reads += 1;
				if (reads === 1) return undefined;
				const snapshot = structuredClone(state.jobs ?? []);
				return new Promise<Response>((resolve) => {
					held.list = () => resolve(json({ jobs: snapshot, nextBefore: null }));
				});
			}
			if (call.method === "POST" && call.path === `${base}/video/jobs`) {
				const answer = next;
				return new Promise<Response>((resolve) => {
					held.post = () => resolve(json(answer, 202));
				});
			}
		});
		show("admin");
		await screen.findByRole("list", { name: "Videos" });
		const prompts = () =>
			within(screen.getByRole("list", { name: "Videos" }))
				.getAllByRole("listitem")
				.map((item) => item.querySelector(".video-prompt")?.textContent ?? "");

		// A list read sent before the video was saved answers after it started.
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		type("Prompt", "First");
		fireEvent.click(screen.getByRole("button", { name: "Make video" }));
		await waitFor(() => expect(held.post).toBeDefined());
		state.jobs = [next, old];
		await act(async () => held.post?.());
		await act(async () => held.list?.());
		expect(prompts()).toEqual(["First", "An old video"]);

		// A list read that already has the video answers before the start does.
		const first = next;
		next = failed("Second");
		held.post = undefined;
		type("Prompt", "Second");
		fireEvent.click(screen.getByRole("button", { name: "Make video" }));
		await waitFor(() => expect(held.post).toBeDefined());
		state.jobs = [next, first, old];
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await act(async () => held.list?.());
		await act(async () => held.post?.());
		expect(prompts()).toEqual(["Second", "First", "An old video"]);
	});

	it("starts a video with exactly what was chosen and lists it first", async () => {
		const state: State = { settings: settings(), jobs: [job()] };
		const started = job({
			status: "failed",
			error: { code: "provider_error", message: "Runway: outage" },
		});
		const calls = fakeGateway(state, (call) =>
			call.method === "POST" && call.path === `${base}/video/jobs`
				? json(started, 202)
				: undefined,
		);
		show("admin");
		await screen.findByRole("heading", { name: "Make a video" });
		type("Prompt", "  A paper boat on a stream  ");
		fireEvent.click(screen.getByRole("button", { name: "Make video" }));
		expect(
			await screen.findByText(
				"The video could not be started. The list says why.",
			),
		).toBeDefined();
		expect(sent(calls, "POST")[0].body).toEqual({
			prompt: "A paper boat on a stream",
			durationSeconds: 5,
			aspectRatio: "16:9",
			resolution: "720p",
		});
		const items = within(
			screen.getByRole("list", { name: "Videos" }),
		).getAllByRole("listitem");
		expect(items[0].textContent).toContain("Runway: outage");
		expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
			"",
		);
	});

	it("shows the gateway's refusal when a limit is reached", async () => {
		fakeGateway({ settings: settings() }, (call) =>
			call.method === "POST"
				? failure(429, "Your videos for today are used up.")
				: undefined,
		);
		show("admin");
		await screen.findByRole("heading", { name: "Make a video" });
		type("Prompt", "x");
		fireEvent.click(screen.getByRole("button", { name: "Make video" }));
		expect(
			await screen.findByText("Your videos for today are used up."),
		).toBeDefined();
	});

	it("says video is not set up and offers the settings", async () => {
		fakeGateway({
			settings: settings({ configured: false }),
			models: models({
				available: false,
				reason:
					"This workspace has no video provider. A workspace admin can add one.",
				providers: [],
			}),
		});
		show("admin");
		expect(await screen.findByText("Video is not set up")).toBeDefined();
		expect(
			screen.getByText(/This workspace has no video provider/),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
		expect(window.location.hash).toBe(`#/w/${WORKSPACE}/video/settings`);
	});

	it("shows each job's status, error, link and player, and loads more", async () => {
		const done = job({
			status: "succeeded",
			video: {
				url: "https://gateway.example.com/video/downloads/token",
				contentType: "video/mp4",
				expiresAt: "2026-11-20T12:00:00.000Z",
			},
		});
		const failed = job({
			status: "failed",
			error: {
				code: "moderated",
				message: "Runway: Runway refused the prompt",
			},
		});
		const state: State = {
			settings: settings(),
			jobs: [
				done,
				failed,
				job({ status: "canceled" }),
				job({ status: "expired" }),
			],
			nextBefore: "vid_last",
		};
		const calls = fakeGateway(state);
		show("admin");
		const list = await screen.findByRole("list", { name: "Videos" });
		const text = list.textContent ?? "";
		for (const label of ["Done", "Failed", "Canceled", "Expired"])
			expect(text).toContain(label);
		expect(text).toContain("Runway: Runway refused the prompt");
		expect(text).toContain("The provider no longer keeps this video.");
		expect(
			within(list)
				.getByRole("link", { name: "Open video" })
				.getAttribute("href"),
		).toBe(done.video?.url);
		fireEvent.click(
			within(list).getByRole("button", { name: "Play A lighthouse at dusk" }),
		);
		const video = list.querySelector("video") as HTMLVideoElement;
		expect(video.getAttribute("src")).toBe(done.video?.url);
		fireEvent.error(video);
		expect(
			within(list).getByText("This video cannot play here. Open it instead."),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await waitFor(() =>
			expect(
				calls.some(
					(call) => call.path === `${base}/video/jobs?before=vid_last`,
				),
			).toBe(true),
		);
	});

	it("follows a running job until it is done, and stops when the page goes", async () => {
		const running = job({ status: "running", progress: 40 });
		const state: State = { settings: settings(), jobs: [running] };
		const calls = fakeGateway(state, (call) => {
			if (call.path === `${base}/video/jobs/${running.id}?wait=10`)
				return json({
					...running,
					status: "succeeded",
					progress: 100,
					video: {
						url: "https://gateway.example.com/video/downloads/x",
						contentType: "video/mp4",
						expiresAt: "2026-11-20T12:00:00.000Z",
					},
				});
		});
		show("admin");
		const list = await screen.findByRole("list", { name: "Videos" });
		await waitFor(() => expect(list.textContent).toContain("Done"));
		expect(
			calls.some(
				(call) => call.path === `${base}/video/jobs/${running.id}?wait=10`,
			),
		).toBe(true);
		cleanup();
		vi.restoreAllMocks();

		// A wait the gateway is still holding is cut off when the page goes.
		const pending = job({ status: "queued" });
		let held: AbortSignal | undefined;
		fakeGateway({ settings: settings(), jobs: [pending] }, (call) => {
			if (!call.path.endsWith("?wait=10")) return undefined;
			held = call.signal;
			return new Promise<Response>((resolve) =>
				call.signal?.addEventListener("abort", () =>
					resolve(failure(499, "aborted")),
				),
			);
		});
		const view = show("admin");
		await waitFor(() => expect(held).toBeDefined());
		view.unmount();
		expect(held?.aborted).toBe(true);
	});

	it("follows at most three jobs at once, the newest", async () => {
		const queued = [1, 2, 3, 4].map(() => job({ status: "queued" }));
		const asked = new Set<string>();
		fakeGateway({ settings: settings(), jobs: queued }, (call) => {
			const one = /\/video\/jobs\/([^/?]+)\?wait=10$/.exec(call.path);
			if (!one) return undefined;
			asked.add(one[1]);
			return new Promise<Response>((resolve) =>
				call.signal?.addEventListener("abort", () =>
					resolve(failure(499, "aborted")),
				),
			);
		});
		show("admin");
		await waitFor(() => expect(asked.size).toBe(3));
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
		expect([...asked].sort()).toEqual(
			queued
				.slice(0, 3)
				.map((item) => item.id)
				.sort(),
		);
	});

	it("drops a job the gateway no longer has, and re-reads the settings when video is turned off", async () => {
		const gone = job({ status: "queued", prompt: "Gone" });
		fakeGateway({ settings: settings(), jobs: [gone] }, (call) =>
			call.path.endsWith(`${gone.id}?wait=10`)
				? failure(404, "Video job not found.")
				: undefined,
		);
		show("admin");
		expect(await screen.findByText("No videos yet")).toBeDefined();
		cleanup();
		vi.restoreAllMocks();

		const running = job({ status: "running" });
		const state: State = { settings: settings(), jobs: [running] };
		const calls = fakeGateway(state, (call) => {
			if (!call.path.endsWith(`${running.id}?wait=10`)) return undefined;
			state.settings = settings({ available: false });
			return failure(503, "Video generation is turned off on this gateway.");
		});
		show("admin");
		expect(
			await screen.findAllByText(
				/Video generation is turned off on this gateway/,
			),
		).toHaveLength(2);
		expect(calls.filter((call) => call.path.endsWith("?wait=10"))).toHaveLength(
			1,
		);
	});

	it("stops a video after confirming", async () => {
		const running = job({ status: "running", progress: null });
		const state: State = { settings: settings(), jobs: [running] };
		const calls = fakeGateway(state, (call) => {
			if (call.method === "POST" && call.path.endsWith("/cancel"))
				return json({ ...running, status: "canceled" });
		});
		show("admin");
		const stop = await screen.findByRole("button", {
			name: "Stop A lighthouse at dusk",
		});
		fireEvent.click(stop);
		expect(
			screen.getByText("Stopping does not give back the estimated cost."),
		).toBeDefined();
		const confirm = screen.getByRole("button", {
			name: "Confirm stop A lighthouse at dusk",
		});
		expect(document.activeElement).toBe(confirm);
		fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Stop A lighthouse at dusk" }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Stop A lighthouse at dusk" }),
		);
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", {
					name: "Confirm stop A lighthouse at dusk",
				}),
			);
		});
		await waitFor(() =>
			expect(
				screen.getByRole("list", { name: "Videos" }).textContent,
			).toContain("Canceled"),
		);
		expect(sent(calls, "POST")[0].path).toBe(
			`${base}/video/jobs/${running.id}/cancel`,
		);
	});
});

describe("Video helpers", () => {
	it("checks the limits against the gateway's bounds", () => {
		expect(videoPolicyProblem(policy())).toBeNull();
		expect(videoPolicyProblem(policy({ callerVideosPerDay: -1 }))).toContain(
			"Videos a day",
		);
		expect(videoPolicyProblem(policy({ monthlyBudgetUsd: 200_000 }))).toContain(
			"monthly budget",
		);
		expect(videoPolicyProblem(policy({ maxDurationSeconds: 1 }))).toContain(
			"longest video",
		);
	});

	it("caps a model's choices by the workspace's longest video", () => {
		const seedance = VIDEO_MODELS.runway[0];
		const ray = VIDEO_MODELS.luma[0];
		expect(formChoices(seedance, 10).durations).toEqual({
			kind: "range",
			min: 4,
			max: 10,
		});
		expect(formChoices(ray, 7).durations).toEqual({
			kind: "list",
			values: [5],
		});
		expect(formChoices(ray, 4).fits).toBe(false);
		expect(formChoices(VIDEO_MODELS.google[0], 10).image).toBe(false);
		const want = {
			prompt: "x",
			durationSeconds: 5,
			aspectRatio: "16:9" as const,
			resolution: "720p" as const,
			imageUrl: "",
		};
		expect(videoRequestProblem(seedance, 10, want)).toBeNull();
		expect(videoRequestProblem(seedance, 10, { ...want, prompt: " " })).toBe(
			"Describe the video.",
		);
		expect(
			videoRequestProblem(seedance, 10, {
				...want,
				imageUrl: "http://example.com/a.png",
			}),
		).toBe("The image URL must start with https://.");
		expect(
			videoRequestProblem(VIDEO_MODELS.google[0], 10, {
				...want,
				imageUrl: "https://example.com/a.png",
			}),
		).toContain("does not start from an image");
		expect(
			videoRequestProblem(seedance, 10, { ...want, resolution: "540p" }),
		).toContain("makes 480p, 720p, 1080p videos");
	});

	it("keeps the tab in the address", () => {
		setCurrentWorkspace(WORKSPACE);
		expect(parseVideoTab(`#/w/${WORKSPACE}/video`)).toBe("videos");
		expect(parseVideoTab(`#/w/${WORKSPACE}/video/settings`)).toBe("settings");
		expect(parseVideoTab("#/video/settings")).toBe("settings");
		expect(videoHash("settings")).toBe(`#/w/${WORKSPACE}/video/settings`);
		expect(videoHash("videos")).toBe(`#/w/${WORKSPACE}/video`);
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

	it("opens from the sidebar, adds a provider, and saves a limit", async () => {
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
		window.history.replaceState(null, "", "#/video/settings");
		render(<App />);
		await screen.findByText("No video providers yet");
		expect(
			screen.getByRole("link", { name: "Video" }).getAttribute("aria-current"),
		).toBe("page");
		expect(window.location.hash).toBe(`#/w/${workspaceId}/video/settings`);

		fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
		const form = screen.getByRole("region", { name: "Add a video provider" });
		type("API key", "rw-secret", form);
		fireEvent.click(within(form).getByRole("button", { name: "Add provider" }));
		expect(await screen.findByText("Added runway.")).toBeDefined();
		const saved = await read();
		expect(saved.connections).toMatchObject([
			{ name: "runway", kind: "runway", keyConfigured: true, enabled: true },
		]);
		expect(JSON.stringify(saved)).not.toContain("rw-secret");

		type("Videos a day", "3");
		fireEvent.click(
			screen.getByRole("button", { name: "Save limits and order" }),
		);
		expect(
			await within(
				screen.getByRole("form", { name: "Limits and order" }),
			).findByText("Saved"),
		).toBeDefined();
		expect((await read()).policy.callerVideosPerDay).toBe(3);
	});
});

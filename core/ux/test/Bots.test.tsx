import type {
	BotDetails,
	BotList,
	ChannelDetails,
	ChannelEntryList,
	ChannelMessage,
	CreateBotRequest,
} from "@autonomo.us/common";
import { createServer } from "@autonomo.us/server";
import {
	cleanup,
	configure,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startOpenAIStub } from "../../server/test/openai-stub.js";
import { App } from "../src/App.js";
import { clearCredential, setSessionToken } from "../src/api.js";
import { parseBotsRoute } from "../src/bots-route.js";
import { replyingLine } from "../src/ChannelRoom.js";
import { setChannelTimings } from "../src/channels-state.js";
import { defaultWorkspaceId, PASSWORD, setUpOwner } from "./session.js";

// The Bots view runs against a real gateway whose default workspace has a
// real provider: an OpenAI-compatible stub server. `stub/chat-model` answers
// "Hello there", `stub/slow-model` stalls 1.5 s before "Slow reply", and
// `stub/broken-model` fails with "provider exploded".

vi.setConfig({ testTimeout: 30_000 });
// The suite runs its files side by side, each with a real server, so a wait
// that takes milliseconds alone can take more than the default second.
configure({ asyncUtilTimeout: 5000 });

const closers: Array<() => Promise<unknown>> = [];
beforeEach(() => {
	setChannelTimings({
		waitSeconds: 1,
		retryMs: 50,
		listIntervalMs: 150,
		readDelayMs: 10,
		activityIntervalMs: 100,
	});
});
afterEach(async () => {
	cleanup();
	clearCredential();
	for (const close of closers.splice(0)) await close();
	setChannelTimings(null);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
	window.localStorage.clear();
});

const SOON = { timeout: 8000 };

async function boot() {
	const stub = await startOpenAIStub();
	const server = createServer({
		config: {
			providers: [
				{
					name: "stub",
					kind: "openai-compatible",
					baseURL: stub.url,
					models: ["chat-model", "slow-model", "broken-model"],
				},
			],
			corsOrigins: ["*"],
		},
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(
		() => server.close(),
		() => stub.close(),
	);
	vi.stubEnv("VITE_API_URL", url);
	const owner = await setUpOwner(url);
	const workspaceId = await defaultWorkspaceId(url, owner);
	const call = (method: string, path: string, body?: unknown, token = owner) =>
		fetch(`${url}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const api = async <T,>(
		method: string,
		path: string,
		body?: unknown,
		token = owner,
	): Promise<T> => {
		const response = await call(method, path, body, token);
		const text = await response.text();
		if (!response.ok) throw new Error(`${method} ${path}: ${text}`);
		return (text ? JSON.parse(text) : undefined) as T;
	};
	const base = `/v1/${workspaceId}`;
	const bot = (input: Partial<CreateBotRequest> & { name: string }) =>
		api<BotDetails>("POST", `${base}/bots`, {
			instructions: "Answer briefly.",
			model: "stub/chat-model",
			...input,
		});
	const bots = async () => (await api<BotList>("GET", `${base}/bots`)).bots;
	const details = (id: string) => api<BotDetails>("GET", `${base}/bots/${id}`);
	const channel = (name: string) =>
		api<ChannelDetails>("POST", `${base}/channels`, { name });
	const addAgent = (channelId: string, agentId: string) =>
		api("PUT", `${base}/channels/${channelId}/agents/${agentId}`, {
			access: "post",
		});
	const post = (channelId: string, body: string) =>
		api<ChannelMessage>("POST", `${base}/channels/${channelId}/messages`, {
			body,
		});
	/** Waits until the channel holds `count` messages, the bots' included. */
	const messages = async (channelId: string, count: number) => {
		let found: ChannelMessage[] = [];
		await waitFor(async () => {
			found = (
				await api<ChannelEntryList>(
					"GET",
					`${base}/channels/${channelId}/messages?after=0&limit=100`,
				)
			).entries.filter(
				(entry): entry is ChannelMessage => entry.type === "message",
			);
			expect(found).toHaveLength(count);
		}, SOON);
		return found;
	};
	/** Another person in the workspace, with their own session. */
	const join = async (name: string, role: "member" | "admin") => {
		const invite = await api<{ token: string }>("POST", "/v1/team/invites", {
			role: "member",
			ttlDays: 7,
			workspace: { workspaceId, role },
		});
		return api<{ token: string; user: { id: string } }>(
			"POST",
			"/v1/invites/accept",
			{
				token: invite.token,
				email: `${name.toLowerCase()}@example.com`,
				name,
				password: PASSWORD,
			},
		);
	};
	return {
		owner,
		workspaceId,
		base,
		call,
		api,
		bot,
		bots,
		details,
		channel,
		addAgent,
		post,
		messages,
		join,
	};
}
function renderAt(hash: string) {
	window.history.replaceState(null, "", hash);
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
const type = (element: HTMLElement, value: string) =>
	fireEvent.change(element, { target: { value } });
const botList = () =>
	within(screen.getByRole("complementary", { name: "Bot list" }));
const field = (scope: ReturnType<typeof within>, label: string) =>
	scope.getByLabelText(label) as HTMLInputElement;
/** The row of the runs table whose status reads `status`. */
const runRow = async (status: string) => {
	const row = (await screen.findByText(status, {}, SOON)).closest("tr");
	if (!row) throw new Error(`No run with status ${status}`);
	return row;
};

it("creates a bot from the UI, edits and pauses it, and deletes it", async () => {
	const running = await boot();
	renderAt("#/bots");
	expect(await screen.findByRole("heading", { name: "Bots" })).toBeDefined();
	expect(
		screen.getByText(/A bot answers in channels when someone mentions it/),
	).toBeDefined();
	expect(
		screen.getByRole("link", { name: "Bots" }).getAttribute("aria-current"),
	).toBe("page");
	expect(await screen.findByText(/No bots yet\. Create one/)).toBeDefined();

	fireEvent.click(screen.getByRole("button", { name: "New bot" }));
	const form = within(screen.getByRole("region", { name: "New bot" }));
	type(field(form, "Name"), "Helper");
	type(field(form, "Instructions"), "Answer briefly.");
	expect(form.getByText("15 / 20,000 characters")).toBeDefined();
	// The workspace's chat models, then auto and its pools from routing.
	await waitFor(() =>
		expect(field(form, "Model").value).toBe("stub/chat-model"),
	);
	expect(
		within(field(form, "Model"))
			.getAllByRole("option")
			.map((option) => [
				option.textContent,
				(option as HTMLOptionElement).disabled,
			]),
	).toEqual([
		["stub/chat-model", false],
		["stub/slow-model", false],
		["stub/broken-model", false],
		["auto (Auto routing is off)", true],
	]);
	expect(field(form, "Model").value).toBe("stub/chat-model");
	// The limits start from the gateway's defaults.
	expect(
		[
			"Replies an hour",
			"Tokens a day",
			"Output tokens per reply",
			"Context messages",
		].map((label) => field(form, label).value),
	).toEqual(["30", "500000", "1500", "30"]);
	expect(field(form, "Active").checked).toBe(true);
	expect(field(form, "Use tools").checked).toBe(false);
	expect(
		form.getByText(
			"Lets a reply search and write this bot's own Synapse space, propose changes to the shared space, and read its other channels.",
		),
	).toBeDefined();
	expect(
		within(field(form, "Bot-to-bot replies"))
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["0", "1", "2", "3"]);
	expect(
		form.getByText(
			"0 answers people only. Higher values let a chain of bots answer each other that many steps.",
		),
	).toBeDefined();
	fireEvent.click(field(form, "Use tools"));
	type(field(form, "Bot-to-bot replies"), "1");
	fireEvent.click(form.getByRole("button", { name: "Create bot" }));

	expect((await screen.findByRole("status")).textContent).toBe(
		"Created Helper.",
	);
	const [created] = await running.bots();
	expect(created).toMatchObject({
		name: "Helper",
		instructions: "Answer briefly.",
		model: "stub/chat-model",
		enabled: true,
		tools: true,
		agentHops: 1,
		limits: { repliesPerHour: 30, tokensPerDay: 500_000 },
		revision: 1,
	});
	expect(window.location.hash).toBe(
		`#/w/${running.workspaceId}/bots/${created.id}`,
	);
	// What to do with a new bot, with the way there.
	const view = within(await screen.findByRole("region", { name: "Helper" }));
	expect(
		view.getByText(/Next: add it to a channel from the channel's Details/),
	).toBeDefined();
	expect(
		view.getByRole("link", { name: "Open Channels" }).getAttribute("href"),
	).toBe(`#/w/${running.workspaceId}/channels`);
	const item = () => botList().getByRole("link", { name: /^Helper/ });
	expect(item().textContent).toContain("stub/chat-model");
	expect(item().textContent).toContain(
		"0 / 30 replies this hour · 0 / 500,000 tokens today",
	);
	expect(view.getByText(/No runs yet/)).toBeDefined();

	// Editing: a tighter limit, and paused.
	const save = () => view.getByRole("button", { name: "Save changes" });
	expect((save() as HTMLButtonElement).disabled).toBe(true);
	type(field(view, "Replies an hour"), "5");
	fireEvent.click(field(view, "Active"));
	expect(view.getByText("Answers nothing.")).toBeDefined();
	fireEvent.click(save());
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toBe("Saved Helper."),
	);
	expect(item().textContent).toContain("Paused");
	expect(item().textContent).toContain("0 / 5 replies this hour");
	expect((await running.bots())[0]).toMatchObject({
		enabled: false,
		limits: { repliesPerHour: 5, tokensPerDay: 500_000 },
		revision: 2,
	});

	// The gateway's own words when it refuses: a taken name, then a bot that
	// changed since it was read.
	await running.bot({ name: "Other" });
	type(field(view, "Name"), "other");
	fireEvent.click(save());
	expect((await view.findByRole("alert")).textContent).toBe(
		"A bot named other already exists.",
	);
	await running.api("PATCH", `${running.base}/bots/${created.id}`, {
		instructions: "Changed elsewhere.",
	});
	type(field(view, "Name"), "Helper two");
	fireEvent.click(save());
	await waitFor(() =>
		expect(view.getByRole("alert").textContent).toBe(
			"This bot changed during your request. Refresh and try again.",
		),
	);
	fireEvent.click(view.getByRole("button", { name: "Refresh" }));
	await waitFor(() =>
		expect(field(view, "Instructions").value).toBe("Changed elsewhere."),
	);
	expect(field(view, "Name").value).toBe("Helper");

	// Deleting asks first.
	fireEvent.click(view.getByRole("button", { name: "Delete" }));
	expect(
		view.getByText(
			/It stays listed in channels it was added to until removed there, and answers nothing\./,
		),
	).toBeDefined();
	fireEvent.click(view.getByRole("button", { name: "Cancel" }));
	fireEvent.click(view.getByRole("button", { name: "Delete" }));
	fireEvent.click(view.getByRole("button", { name: "Delete bot" }));
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toBe("Deleted Helper."),
	);
	expect(window.location.hash).toBe(`#/w/${running.workspaceId}/bots`);
	await waitFor(() =>
		expect(botList().queryByRole("link", { name: /^Helper/ })).toBeNull(),
	);
	expect(botList().getByRole("link", { name: /^Other/ })).toBeDefined();
	expect((await running.bots()).map((bot) => bot.name)).toEqual(["Other"]);
});

it("shows bots read-only to a member and reports a refused save", async () => {
	const running = await boot();
	const helper = await running.bot({
		name: "Helper",
		instructions: "Track the trailer.",
	});
	// Grace starts as a workspace admin, so the form is hers to use.
	const grace = await running.join("Grace", "admin");
	clearCredential();
	setSessionToken(grace.token);
	renderAt(`#/bots/${helper.id}`);
	const view = within(await screen.findByRole("region", { name: "Helper" }));
	type(field(view, "Instructions"), "Track the poster.");
	// She is made a member while the page is open: the gateway refuses.
	await running.api("PUT", `${running.base}/members/${grace.user.id}`, {
		role: "member",
	});
	fireEvent.click(view.getByRole("button", { name: "Save changes" }));
	expect((await view.findByRole("alert")).textContent).toBe(
		"Ask a workspace admin for this action.",
	);
	expect((await running.details(helper.id)).instructions).toBe(
		"Track the trailer.",
	);

	// From then on the dashboard shows her the bot without a way to change it.
	cleanup();
	renderAt(`#/bots/${helper.id}`);
	const readOnly = within(
		await screen.findByRole("region", { name: "Helper" }),
	);
	expect(screen.getByText(/A workspace admin manages bots\./)).toBeDefined();
	expect(screen.queryByRole("button", { name: "New bot" })).toBeNull();
	expect(readOnly.getByText("stub/chat-model")).toBeDefined();
	expect(readOnly.getByText("Track the trailer.")).toBeDefined();
	expect(readOnly.getByText("Active")).toBeDefined();
	expect(readOnly.queryByRole("textbox")).toBeNull();
	for (const name of ["Save changes", "Delete"])
		expect(readOnly.queryByRole("button", { name })).toBeNull();
	expect(readOnly.getByRole("button", { name: "Refresh" })).toBeDefined();
	expect(
		(
			await running.call(
				"DELETE",
				`${running.base}/bots/${helper.id}`,
				undefined,
				grace.token,
			)
		).status,
	).toBe(403);
});

it("adds a bot to a channel, shows it replying to a mention, and records the run", async () => {
	const running = await boot();
	const slow = await running.bot({ name: "Slow", model: "stub/slow-model" });
	await running.bot({ name: "Sleepy", enabled: false });
	const general = await running.channel("general");
	renderAt("#/channels/general");
	const view = await screen.findByRole("region", { name: "#general" });
	await within(view).findByText("Founder created this channel");
	const status = () => view.querySelector(".channel-replying");
	expect(status()?.textContent).toBe("");

	// A gateway bot is told from an agent token, and a paused one says so.
	fireEvent.click(within(view).getByRole("button", { name: "Details" }));
	const panel = within(
		await screen.findByRole("complementary", { name: "Channel details" }),
	);
	await panel.findByRole("option", { name: "Slow (Gateway bot)" });
	expect(
		panel.getByRole("option", { name: "Sleepy (Gateway bot, paused)" }),
	).toBeDefined();
	type(panel.getByLabelText("Add agent"), slow.id);
	fireEvent.click(panel.getByRole("button", { name: "Add agent" }));
	await panel.findByLabelText("Access for Slow");
	expect(
		within(
			panel.getByLabelText("Access for Slow").closest("li") as HTMLElement,
		).getByText("Gateway bot").className,
	).toContain("channel-chip");

	// Mention it. The line says it is working, then the reply takes its place.
	const box = screen.getByLabelText("Message #general") as HTMLTextAreaElement;
	type(box, "@slo");
	await screen.findByRole("listbox", { name: "Mention someone" });
	fireEvent.keyDown(box, { key: "Enter" });
	expect(box.value).toBe(`<@agent:${slow.id}> `);
	type(box, `${box.value}is the trailer ready?`);
	fireEvent.keyDown(box, { key: "Enter" });
	await waitFor(
		() => expect(status()?.textContent).toBe("Slow is replying…"),
		SOON,
	);
	expect(within(view).queryByText("Slow reply")).toBeNull();
	const reply = (await within(view).findByText("Slow reply", {}, SOON)).closest(
		"li",
	) as HTMLElement;
	expect(within(reply).getByText("Slow")).toBeDefined();
	expect(within(reply).getByText("Bot")).toBeDefined();
	await waitFor(() => expect(status()?.textContent).toBe(""), SOON);
	// The line's place is kept whether or not a bot is working.
	expect(status()?.getAttribute("role")).toBe("status");
	expect((await running.messages(general.id, 2))[1]).toMatchObject({
		author: { kind: "agent", id: slow.id, name: "Slow" },
		body: "Slow reply",
	});

	// The run is on the bot's page, with what it cost.
	fireEvent.click(screen.getByRole("link", { name: "Bots" }));
	fireEvent.click(await botList().findByRole("link", { name: /^Slow/ }));
	const row = within(await runRow("Succeeded"));
	expect(row.getByText("Succeeded").className).toContain("succeeded");
	expect(row.getByText("#general")).toBeDefined();
	expect(row.getByText("stub/slow-model")).toBeDefined();
	expect(row.getByText("15")).toBeDefined();
	expect(botList().getByRole("link", { name: /^Slow/ }).textContent).toContain(
		"1 / 30 replies this hour · 15 / 500,000 tokens today",
	);
});

it("stops saying a bot is replying when it can no longer ask", async () => {
	const running = await boot();
	// Two empty or failed answers end the asking.
	setChannelTimings({ activityIntervalMs: 20, activityQuietPolls: 2 });
	const slow = await running.bot({ name: "Slow", model: "stub/slow-model" });
	const general = await running.channel("general");
	await running.addAgent(general.id, slow.id);
	renderAt("#/channels/general");
	const view = await screen.findByRole("region", { name: "#general" });
	await within(view).findByText("Founder added Slow");
	const status = () => view.querySelector(".channel-replying");
	await running.post(general.id, `<@agent:${slow.id}> are you there?`);
	await waitFor(
		() => expect(status()?.textContent).toBe("Slow is replying…"),
		SOON,
	);
	// From here on the gateway cannot be asked who is replying.
	const real = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
		String(input instanceof Request ? input.url : input).includes(
			"/bots/activity",
		)
			? Promise.reject(new TypeError("offline"))
			: real(input, init),
	);
	// The line clears well before the model answers 1.5 s later.
	await waitFor(() => expect(status()?.textContent).toBe(""), {
		timeout: 1000,
	});
	expect(within(view).queryByText("Slow reply")).toBeNull();
});

it("shows why a run failed or was skipped, after a refresh", async () => {
	const running = await boot();
	const broken = await running.bot({
		name: "Broken",
		model: "stub/broken-model",
	});
	const limited = await running.bot({
		name: "Limited",
		limits: { repliesPerHour: 1 },
	});
	const general = await running.channel("general");
	await running.addAgent(general.id, broken.id);
	await running.addAgent(general.id, limited.id);
	renderAt(`#/bots/${broken.id}`);
	const view = within(await screen.findByRole("region", { name: "Broken" }));
	expect(await view.findByText(/No runs yet/)).toBeDefined();

	// The provider fails: the channel gets a short notice, the run the reason.
	await running.post(general.id, `<@agent:${broken.id}> hello?`);
	const [, notice] = await running.messages(general.id, 2);
	expect(notice.body).toContain("I could not reply");
	fireEvent.click(view.getByRole("button", { name: "Refresh" }));
	const failed = within(await runRow("Failed"));
	expect(failed.getByText("Failed").className).toContain("failed");
	expect(failed.getByText(/provider exploded/)).toBeDefined();
	expect(failed.getByText("#general")).toBeDefined();

	// Past its limit a mention is skipped before any model call.
	await running.post(general.id, `<@agent:${limited.id}> one`);
	await running.messages(general.id, 4);
	await running.post(general.id, `<@agent:${limited.id}> two`);
	await waitFor(
		async () =>
			expect((await running.details(limited.id)).runs).toHaveLength(2),
		SOON,
	);
	fireEvent.click(botList().getByRole("link", { name: /^Limited/ }));
	const skipped = within(await runRow("Skipped"));
	expect(skipped.getByText("Skipped").className).toContain("skipped");
	expect(
		skipped.getByText("Reached its limit of 1 replies an hour."),
	).toBeDefined();
	expect(
		within(await runRow("Succeeded")).getByText("stub/chat-model"),
	).toBeDefined();
});

it("opens the bot list when a link names a workspace that cannot be opened", async () => {
	const running = await boot();
	await running.bot({ name: "Helper" });
	// A bookmark from a workspace this person is not in, to a bot there.
	renderAt(
		"#/w/9b0a6d3e-58a1-4d0b-9d5a-0c1e2f3a4b5c/bots/1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
	);
	const list = within(
		await screen.findByRole("complementary", { name: "Bot list" }, SOON),
	);
	expect(await list.findByText("Helper", {}, SOON)).toBeDefined();
	// The link lands in this workspace without the other workspace's bot.
	expect(window.location.hash).toBe(`#/w/${running.workspaceId}/bots`);
	expect(screen.queryByText("Bot not found")).toBeNull();
});

it("reads the bot from the URL and names who is replying", () => {
	const id = "9b0a6d3e-58a1-4d0b-9d5a-0c1e2f3a4b5c";
	expect(parseBotsRoute(`#/w/abc/bots/${id}`)).toEqual({ id });
	for (const hash of ["#/w/abc/bots", "#/bots/new", "#/channels/general"])
		expect(parseBotsRoute(hash)).toEqual({ id: null });
	const bots = ["Captain", "Helper", "Scout"].map((name) => ({
		botId: name,
		name,
	}));
	expect(replyingLine([])).toBe("");
	expect(replyingLine(bots.slice(0, 1))).toBe("Captain is replying…");
	expect(replyingLine(bots.slice(0, 2))).toBe(
		"Captain and Helper are replying…",
	);
	expect(replyingLine(bots)).toBe("Captain, Helper, and Scout are replying…");
});

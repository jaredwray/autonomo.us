import type {
	ChannelDetails,
	ChannelEntryList,
	ChannelList,
	ChannelMessage,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { clearCredential } from "../src/api.js";
import { MessageBody, memberIndex } from "../src/ChannelMessages.js";
import { parseChannelsRoute } from "../src/channels-route.js";
import {
	dayLabel,
	emptyRoom,
	roomReducer,
	setChannelTimings,
} from "../src/channels-state.js";
import { defaultWorkspaceId, PASSWORD, setUpOwner } from "./session.js";

// The Channels view runs against a real gateway (no fetch mocks): each test
// boots @autonomo.us/server on an ephemeral port, signs the dashboard in as
// the owner, and talks to the same API as a second member, a script, or an
// agent's admin would. Polls are shortened through the view's own setter.

// Long polls answer within about a second of a post, so the default five
// seconds is too tight for a test that waits on several.
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

/** A message another session posts takes up to a second to arrive by long poll. */
const SOON = { timeout: 5000 };

async function boot() {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => server.close());
	vi.stubEnv("VITE_API_URL", url);
	const owner = await setUpOwner(url);
	const workspaceId = await defaultWorkspaceId(url, owner);
	const call = async (
		method: string,
		path: string,
		body?: unknown,
		token = owner,
	) =>
		fetch(`${url}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	/** Calls a route and returns its JSON, failing on an unexpected status. */
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
	const channels = `/v1/${workspaceId}/channels`;
	const createChannel = (name: string) =>
		api<ChannelDetails>("POST", channels, { name });
	const post = (
		channel: ChannelDetails,
		body: string,
		options: { token?: string; threadId?: string } = {},
	) =>
		api<ChannelMessage>(
			"POST",
			`${channels}/${channel.id}/messages`,
			{ body, threadId: options.threadId },
			options.token,
		);
	/** Every entry in the channel's log, oldest first. */
	const log = async (channel: ChannelDetails) =>
		(
			await api<ChannelEntryList>(
				"GET",
				`${channels}/${channel.id}/messages?after=0&limit=100`,
			)
		).entries;
	const messages = async (channel: ChannelDetails) =>
		(await log(channel)).filter(
			(entry): entry is ChannelMessage => entry.type === "message",
		);
	const list = async (token?: string) =>
		(await api<ChannelList>("GET", channels, undefined, token)).channels;
	/** A second person in the workspace, with their own session. */
	const join = async (name: string) => {
		const invite = await api<{ token: string }>("POST", "/v1/team/invites", {
			role: "member",
			ttlDays: 7,
			workspace: { workspaceId, role: "member" },
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
	const token = async (
		kind: "api-tokens" | "agent-tokens",
		name: string,
		permissions: string[],
	) =>
		api<{ secret: string; token: { id: string } }>(
			"POST",
			`/v1/${workspaceId}/${kind}`,
			{ name, description: "", ttlDays: 7, permissions },
		);
	const me = (await api<{ user: { id: string } }>("GET", "/v1/auth/session"))
		.user.id;
	return {
		url,
		owner,
		me,
		workspaceId,
		channels,
		api,
		createChannel,
		post,
		log,
		messages,
		list,
		join,
		token,
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
const room = (name: string) =>
	screen.findByRole("region", { name: `#${name}` });
const channelList = () =>
	within(screen.getByRole("complementary", { name: "Channel list" }));
const composer = (name: string) =>
	screen.getByLabelText(`Message #${name}`) as HTMLTextAreaElement;
const type = (box: HTMLElement, value: string) =>
	fireEvent.change(box, { target: { value } });
const enter = (box: HTMLElement) => fireEvent.keyDown(box, { key: "Enter" });
/** The message row that shows `text`. */
const row = async (scope: HTMLElement, text: string) => {
	const found = (await within(scope).findByText(text, {}, SOON)).closest("li");
	if (!found) throw new Error(`No message row for ${text}`);
	return within(found);
};

it("creates a channel from the UI, posts to it, and shows the message", async () => {
	const running = await boot();
	renderAt("#/channels");
	expect(
		await screen.findByText(
			"Create a channel to talk with your team and agents.",
		),
	).toBeDefined();
	expect(
		screen.getByRole("link", { name: "Channels" }).getAttribute("aria-current"),
	).toBe("page");
	expect(
		screen.getByText(/Channels are temporary until MongoDB/),
	).toBeDefined();

	fireEvent.click(screen.getByRole("button", { name: "New channel" }));
	const form = within(screen.getByRole("region", { name: "New channel" }));
	// Names are lowercase; the form normalizes what is typed.
	type(form.getByLabelText("Name"), "General Chat");
	expect((form.getByLabelText("Name") as HTMLInputElement).value).toBe(
		"general-chat",
	);
	type(form.getByLabelText("Name"), "general");
	type(form.getByLabelText("Topic"), "Daily talk");
	fireEvent.click(form.getByRole("button", { name: "Create channel" }));

	const view = within(await room("general"));
	expect(window.location.hash).toBe(
		`#/w/${running.workspaceId}/channels/general`,
	);
	expect(view.getByText("Daily talk")).toBeDefined();
	expect(await view.findByText("Founder created this channel")).toBeDefined();
	// A channel with no agents says how to add one, and what the agent needs.
	expect(
		view.getByText(/No agents are in this channel yet/).textContent,
	).toMatch(/Add one from Details.*mcp:call.*grant on its agent token/);
	expect(
		channelList()
			.getByRole("link", { name: "general" })
			.getAttribute("aria-current"),
	).toBe("page");

	// Shift+Enter adds a line; Enter sends.
	const box = composer("general");
	type(box, "Hello **team**");
	fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
	expect(box.value).toBe("Hello **team**");
	enter(box);
	expect(box.value).toBe("");
	// It shows at once, under the sender's name, and is then confirmed.
	const pending = await row(await room("general"), "team");
	expect(pending.getByText("Founder")).toBeDefined();
	await waitFor(() => expect(view.queryByText("Sending…")).toBeNull());
	const sent = await row(await room("general"), "team");
	expect(sent.getByText("team").tagName).toBe("STRONG");
	expect(sent.getByText("Founder")).toBeDefined();
	expect(view.getAllByText("team")).toHaveLength(1);
	const [created] = await running.list();
	expect(created).toMatchObject({ name: "general", topic: "Daily talk" });
	expect(
		(await running.messages(created as ChannelDetails)).map(
			(message) => message.body,
		),
	).toEqual(["Hello **team**"]);

	// A name that is taken is refused with the gateway's message.
	fireEvent.click(screen.getByRole("button", { name: "New channel" }));
	const again = within(screen.getByRole("region", { name: "New channel" }));
	type(again.getByLabelText("Name"), "general");
	fireEvent.click(again.getByRole("button", { name: "Create channel" }));
	expect((await again.findByRole("alert")).textContent).toMatch(/general/);
});

it("shows messages from other sessions as they arrive, with chips, mentions, and wikilinks", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	const grace = await running.join("Grace");
	await running.post(channel, "An earlier message", { token: grace.token });
	renderAt("#/channels/general");
	const view = await room("general");
	expect(await within(view).findByText("An earlier message")).toBeDefined();
	expect(within(view).getByText("Today")).toBeDefined();

	// Another person's message arrives by long poll, with no reload.
	await running.post(channel, `<@user:${running.me}> see [[Ada Lovelace]]`, {
		token: grace.token,
	});
	const arrived = await row(view, "@Founder");
	// Consecutive messages by one author share a single name.
	expect(within(view).getAllByText("Grace")).toHaveLength(1);
	expect(arrived.getByText("@Founder").className).toContain("channel-mention");
	// A wikilink opens the workspace's shared Synapse note.
	expect(
		arrived.getByRole("link", { name: "Ada Lovelace" }).getAttribute("href"),
	).toBe(`#/w/${running.workspaceId}/synapse/shared/Ada%20Lovelace`);

	// A script posts under its token's name and carries a chip.
	const script = await running.token("api-tokens", "Deploy script", [
		"channels:edit",
	]);
	await running.post(channel, "Deployed <b>v2</b>", { token: script.secret });
	const scripted = await row(view, "Deployed <b>v2</b>");
	expect(scripted.getByText("Deploy script")).toBeDefined();
	expect(scripted.getByText("Token")).toBeDefined();
	// Markup in a body is text, never HTML.
	expect(view.querySelector("b")).toBeNull();
});

it("marks unread channels bold with a mention count, and clears them once read", async () => {
	const running = await boot();
	await running.createChannel("general");
	const leads = await running.createChannel("leads");
	const grace = await running.join("Grace");
	renderAt("#/channels/general");
	await room("general");
	const link = () => channelList().getByRole("link", { name: /^leads/ });
	expect(link().querySelector("strong")).toBeNull();

	await running.post(leads, "Two new leads today", { token: grace.token });
	await running.post(leads, `<@user:${running.me}> can you take one?`, {
		token: grace.token,
	});
	// The list is read again on its interval; the open channel stays as it is.
	await waitFor(
		() => expect(link().querySelector("strong")?.textContent).toBe("leads"),
		SOON,
	);
	expect(link().textContent).toContain("1 unread mention");
	expect(
		channelList()
			.getByRole("link", { name: "general" })
			.querySelector("strong"),
	).toBeNull();
	// The sidebar carries the same count from any view.
	const nav = screen.getByRole("link", { name: "Channels" });
	expect(nav.textContent).toContain("1 unread mention");
	fireEvent.click(screen.getByRole("link", { name: "Models" }));
	await screen.findByRole("heading", { name: "Models" });
	expect(screen.getByRole("link", { name: "Channels" }).textContent).toContain(
		"1 unread mention",
	);

	// Opening the channel does not mark it read while the tab is in the
	// background; with focus and the newest message on screen, it does.
	window.location.hash = `#/w/${running.workspaceId}/channels/leads`;
	const view = await room("leads");
	expect(await within(view).findByText("Two new leads today")).toBeDefined();
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(link().querySelector("strong")).not.toBeNull();
	expect((await running.list())[1]).toMatchObject({ unread: true, readSeq: 0 });
	composer("leads").focus();
	await waitFor(() => expect(link().querySelector("strong")).toBeNull(), SOON);
	expect(link().textContent).not.toContain("unread");
	expect(screen.getByRole("link", { name: "Channels" }).textContent).toBe(
		"Channels",
	);
	await waitFor(async () =>
		expect(
			(await running.list()).find((channel) => channel.name === "leads"),
		).toMatchObject({ unread: false, mentions: 0, readSeq: 3 }),
	);
});

it("adds an agent from the details panel, changes its access, and edits the channel", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	const captain = await running.token("agent-tokens", "Captain", [
		"mcp:read",
		"mcp:call",
	]);
	renderAt("#/channels/general");
	const view = await room("general");
	fireEvent.click(within(view).getByRole("button", { name: "Details" }));
	const panel = within(
		await screen.findByRole("complementary", { name: "Channel details" }),
	);
	expect(
		await panel.findByText(/No agents are in this channel yet/),
	).toBeDefined();
	await panel.findByRole("option", { name: "Captain" });
	type(panel.getByLabelText("Add agent"), captain.token.id);
	fireEvent.click(panel.getByRole("button", { name: "Add agent" }));
	expect((await panel.findByRole("status")).textContent).toBe(
		"Captain was added with post access.",
	);
	const access = panel.getByLabelText(
		"Access for Captain",
	) as HTMLSelectElement;
	expect(access.value).toBe("post");
	// An agent already in the channel is not offered again.
	expect(panel.queryByRole("option", { name: "Captain" })).toBeNull();
	expect(panel.queryByText(/No agents are in this channel yet/)).toBeNull();
	expect(
		panel.getByText(/Added Captain with post access\./).textContent,
	).toContain("by Founder");
	// The log notes it, and the hint about adding an agent goes away.
	expect(
		await within(view).findByText("Founder added Captain", {}, SOON),
	).toBeDefined();
	expect(
		within(view).queryByText(/No agents are in this channel yet/),
	).toBeNull();

	type(access, "read");
	await waitFor(() =>
		expect(panel.getByRole("status").textContent).toBe(
			"Captain now has read access.",
		),
	);
	const saved = await running.api<ChannelDetails>(
		"GET",
		`${running.channels}/${channel.id}`,
	);
	expect(saved.agents).toMatchObject([
		{ agentTokenId: captain.token.id, name: "Captain", access: "read" },
	]);

	// The agent can now be mentioned from the composer.
	const box = composer("general");
	type(box, "@cap");
	const options = within(
		await screen.findByRole("listbox", { name: "Mention someone" }),
	);
	expect(options.getByRole("option").textContent).toContain("Captain");
	enter(box);
	expect(box.value).toBe(`<@agent:${captain.token.id}> `);
	type(box, `${box.value}status?`);
	enter(box);
	const asked = await row(view, "status?");
	expect(asked.getByText("@Captain")).toBeDefined();

	// Topic and name are edited in place; a rename moves the link.
	type(panel.getByLabelText("Topic"), "Ship talk");
	type(panel.getByLabelText("Name"), "bridge");
	fireEvent.click(panel.getByRole("button", { name: "Save changes" }));
	const renamed = await room("bridge");
	expect(within(renamed).getByText("Ship talk")).toBeDefined();
	expect(window.location.hash).toBe(
		`#/w/${running.workspaceId}/channels/bridge`,
	);
	expect(channelList().getByRole("link", { name: "bridge" })).toBeDefined();

	fireEvent.click(panel.getByRole("button", { name: "Remove Captain" }));
	await waitFor(() =>
		expect(panel.queryByLabelText("Access for Captain")).toBeNull(),
	);
	expect(await panel.findByRole("option", { name: "Captain" })).toBeDefined();
});

it("shows a failed post as failed and retries it without posting twice", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	renderAt("#/channels/general");
	const view = await room("general");
	await within(view).findByText("Founder created this channel");

	// The request reaches the gateway, but its response is lost on the way back.
	const realFetch = globalThis.fetch;
	let lose = 1;
	const spy = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const response = await realFetch(input, init);
			if (init?.method === "POST" && String(input).endsWith("/messages")) {
				if (lose-- > 0) throw new TypeError("Failed to fetch");
			}
			return response;
		});
	const box = composer("general");
	type(box, "Only once");
	enter(box);
	const failed = within(await within(view).findByRole("alert"));
	expect(failed.getByText(/Not sent/)).toBeDefined();
	expect(await running.messages(channel)).toHaveLength(1);

	// Retry sends the same nonce, so the gateway answers with the first message.
	fireEvent.click(failed.getByRole("button", { name: "Retry" }));
	await waitFor(() => {
		expect(within(view).queryByRole("alert")).toBeNull();
		expect(within(view).getAllByText("Only once")).toHaveLength(1);
	}, SOON);
	const posts = spy.mock.calls.filter(
		([input, init]) =>
			init?.method === "POST" && String(input).endsWith("/messages"),
	);
	expect(posts).toHaveLength(2);
	expect(JSON.parse(String(posts[0][1]?.body)).nonce).toBe(
		JSON.parse(String(posts[1][1]?.body)).nonce,
	);
	expect(
		(await running.messages(channel)).map((message) => message.body),
	).toEqual(["Only once"]);

	// A post that never left can be discarded instead.
	spy.mockImplementation(async (input, init) => {
		if (init?.method === "POST" && String(input).endsWith("/messages"))
			throw new TypeError("Failed to fetch");
		return realFetch(input, init);
	});
	type(box, "Never mind");
	enter(box);
	const dropped = within(await within(view).findByRole("alert"));
	fireEvent.click(dropped.getByRole("button", { name: "Discard" }));
	expect(within(view).queryByText("Never mind")).toBeNull();
	expect(await running.messages(channel)).toHaveLength(1);
});

it("edits and deletes an own message, and lets an admin delete someone else's", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	const grace = await running.join("Grace");
	const theirs = await running.post(channel, "Grace was here", {
		token: grace.token,
	});
	const mine = await running.post(channel, "A messege with a typo");
	renderAt("#/channels/general");
	const view = await room("general");

	const own = await row(view, "A messege with a typo");
	// Escape leaves the message as it was.
	fireEvent.click(own.getByRole("button", { name: "Edit" }));
	type(own.getByLabelText("Edit message"), "Abandoned");
	fireEvent.keyDown(own.getByLabelText("Edit message"), { key: "Escape" });
	expect(own.getByText("A messege with a typo")).toBeDefined();
	// Enter saves.
	fireEvent.click(own.getByRole("button", { name: "Edit" }));
	type(own.getByLabelText("Edit message"), "A message without one");
	enter(own.getByLabelText("Edit message"));
	await waitFor(() => expect(own.queryByLabelText("Edit message")).toBeNull());
	expect(own.getByText("A message without one")).toBeDefined();
	expect(own.getByText("(edited)")).toBeDefined();

	// Deleting asks first, then leaves a marker in place of the text.
	fireEvent.click(own.getByRole("button", { name: "Delete" }));
	fireEvent.click(own.getByRole("button", { name: "Cancel" }));
	expect(own.getByText("A message without one")).toBeDefined();
	fireEvent.click(own.getByRole("button", { name: "Delete" }));
	fireEvent.click(own.getByRole("button", { name: "Delete message" }));
	expect(await own.findByText("Message deleted")).toBeDefined();
	expect(own.queryByText("A message without one")).toBeNull();
	expect(own.queryByRole("button", { name: "Edit" })).toBeNull();

	// The owner is a workspace admin: no editing another person's words, but
	// their message can be removed.
	const other = await row(view, "Grace was here");
	expect(other.queryByRole("button", { name: "Edit" })).toBeNull();
	fireEvent.click(other.getByRole("button", { name: "Delete" }));
	expect(other.getByText(/Delete Grace's message\?/)).toBeDefined();
	fireEvent.click(other.getByRole("button", { name: "Delete message" }));
	expect(await other.findByText("Message deleted")).toBeDefined();
	const stored = await running.messages(channel);
	expect(stored.map((message) => [message.id, message.body])).toEqual([
		[theirs.id, ""],
		[mine.id, ""],
	]);
	expect(stored.every((message) => message.deletedAt !== null)).toBe(true);

	// A change someone else makes arrives by the same long poll.
	const later = await running.post(channel, "Draft", { token: grace.token });
	await row(view, "Draft");
	await running.api(
		"PATCH",
		`${running.channels}/${channel.id}/messages/${later.id}`,
		{ body: "Final" },
		grace.token,
	);
	expect(await within(view).findByText("Final", {}, SOON)).toBeDefined();
	expect(within(view).queryByText("Draft")).toBeNull();
});

it("replies in a thread and counts replies on the root", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	const grace = await running.join("Grace");
	const root = await running.post(channel, "Who has the trailer cut?", {
		token: grace.token,
	});
	renderAt("#/channels/general");
	const view = await room("general");
	const asked = await row(view, "Who has the trailer cut?");
	expect(asked.queryByRole("button", { name: /\d repl/ })).toBeNull();

	fireEvent.click(asked.getByRole("button", { name: "Reply" }));
	const thread = await screen.findByRole("complementary", { name: "Thread" });
	expect(
		await within(thread).findByText("Who has the trailer cut?"),
	).toBeDefined();
	expect(await within(thread).findByText("No replies yet.")).toBeDefined();
	const box = within(thread).getByLabelText("Reply in thread");
	type(box, "I do.");
	enter(box);
	expect(await within(thread).findByText("I do.")).toBeDefined();
	// The reply stays out of the main list, where the root counts it.
	expect(
		await asked.findByRole("button", { name: "1 reply" }, SOON),
	).toBeDefined();
	expect(within(view).queryByText("I do.")).toBeNull();

	// Someone else's reply joins the open thread and the count.
	await running.post(channel, "Send it over.", {
		token: grace.token,
		threadId: root.id,
	});
	expect(
		await within(thread).findByText("Send it over.", {}, SOON),
	).toBeDefined();
	expect(asked.getByRole("button", { name: "2 replies" })).toBeDefined();
	expect(
		(await running.messages(channel)).map((message) => [
			message.body,
			message.threadId,
		]),
	).toEqual([
		["Who has the trailer cut?", null],
		["I do.", root.id],
		["Send it over.", root.id],
	]);

	// Closing the panel and using the count opens the same thread again.
	fireEvent.click(within(thread).getByRole("button", { name: "Close thread" }));
	expect(screen.queryByRole("complementary", { name: "Thread" })).toBeNull();
	fireEvent.click(asked.getByRole("button", { name: "2 replies" }));
	const reopened = await screen.findByRole("complementary", { name: "Thread" });
	expect(await within(reopened).findByText("Send it over.")).toBeDefined();
	expect(within(reopened).getByText("I do.")).toBeDefined();
});

it("picks a mention with the keyboard and closes the picker with Escape", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	const grace = await running.join("Grace");
	renderAt("#/channels/general");
	const view = await room("general");
	await within(view).findByText("Founder created this channel");
	const box = composer("general");
	// The members load with the channel.
	await waitFor(() => {
		type(box, "Hi @");
		expect(
			screen.getByRole("listbox", { name: "Mention someone" }),
		).toBeDefined();
	});
	const names = () =>
		within(screen.getByRole("listbox", { name: "Mention someone" }))
			.getAllByRole("option")
			.map((option) => [
				option.textContent,
				option.getAttribute("aria-selected"),
			]);
	expect(names()).toEqual([
		["Founder", "true"],
		["Grace", "false"],
	]);
	fireEvent.keyDown(box, { key: "ArrowDown" });
	expect(names()).toEqual([
		["Founder", "false"],
		["Grace", "true"],
	]);
	// Typing narrows the list.
	type(box, "Hi @gr");
	expect(names()).toEqual([["Grace", "true"]]);
	// Escape closes it, and it stays closed for that @.
	fireEvent.keyDown(box, { key: "Escape" });
	expect(screen.queryByRole("listbox")).toBeNull();
	type(box, "Hi @gra");
	expect(screen.queryByRole("listbox")).toBeNull();
	type(box, "Hi ");
	type(box, "Hi @gr");
	expect(names()).toEqual([["Grace", "true"]]);
	enter(box);
	expect(box.value).toBe(`Hi <@user:${grace.user.id}> `);
	expect(screen.queryByRole("listbox")).toBeNull();
	enter(box);
	const sent = await row(view, "@Grace");
	expect(sent.getByText("@Grace")).toBeDefined();
	await waitFor(async () =>
		expect((await running.messages(channel))[0]?.mentions).toEqual([
			{ kind: "user", id: grace.user.id },
		]),
	);
});

it("archives a channel, which stops posting, and brings it back", async () => {
	const running = await boot();
	await running.createChannel("general");
	const old = await running.createChannel("old-news");
	await running.post(old, "Kept for the record");
	renderAt("#/channels/old-news");
	const view = await room("old-news");
	fireEvent.click(within(view).getByRole("button", { name: "Details" }));
	const panel = within(
		await screen.findByRole("complementary", { name: "Channel details" }),
	);
	fireEvent.click(
		await panel.findByRole("button", { name: "Archive channel" }),
	);
	expect(await within(view).findByText("Archived")).toBeDefined();
	// History stays readable; the composer says why it is disabled.
	expect(within(view).getByText("Kept for the record")).toBeDefined();
	expect(composer("old-news").disabled).toBe(true);
	expect(within(view).getByText(/This channel is archived/)).toBeDefined();
	expect(panel.getByLabelText("Topic").closest("fieldset")?.disabled).toBe(
		true,
	);
	// It leaves the open channels and is listed under the archived ones.
	expect(
		within(channelList().getByRole("list", { name: "Channels" }))
			.getAllByRole("link")
			.map((link) => link.textContent),
	).toEqual(["#general"]);
	expect(
		within(
			channelList().getByRole("list", { name: "Archived channels" }),
		).getByRole("link", { name: "old-news" }),
	).toBeDefined();
	expect((await running.list()).map((channel) => channel.name)).toEqual([
		"general",
	]);

	// A reload of an archived channel's link still opens it.
	cleanup();
	renderAt(`#/w/${running.workspaceId}/channels/old-news`);
	const again = await room("old-news");
	expect(await within(again).findByText("Kept for the record")).toBeDefined();
	fireEvent.click(within(again).getByRole("button", { name: "Details" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Unarchive channel" }),
	);
	await waitFor(() => expect(composer("old-news").disabled).toBe(false));
	expect((await running.list()).map((channel) => channel.name)).toEqual([
		"general",
		"old-news",
	]);

	// The archived list is read when asked for, and a missing channel says so.
	fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
	expect(await channelList().findByText("No archived channels.")).toBeDefined();
	window.location.hash = `#/w/${running.workspaceId}/channels/nowhere`;
	expect(
		await screen.findByRole("heading", { name: "No channel named #nowhere" }),
	).toBeDefined();
});

it("still deletes a message in an archived channel", async () => {
	const running = await boot();
	const channel = await running.createChannel("old-news");
	const mine = await running.post(channel, "token=abc123");
	await running.api("POST", `${running.channels}/${channel.id}/archive`);
	renderAt("#/channels/old-news");
	const view = await room("old-news");
	expect(composer("old-news").disabled).toBe(true);
	const own = await row(view, "token=abc123");
	// A pasted secret must be removable; nothing else is offered here.
	expect(own.queryByRole("button", { name: "Edit" })).toBeNull();
	fireEvent.click(own.getByRole("button", { name: "Delete" }));
	fireEvent.click(own.getByRole("button", { name: "Delete message" }));
	expect(await own.findByText("Message deleted")).toBeDefined();
	expect(
		(await running.messages(channel)).map((message) => [
			message.id,
			message.body,
		]),
	).toEqual([[mine.id, ""]]);
});

it("loads every reply of a thread longer than one page", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	const root = await running.post(channel, "Long thread");
	// One page is 100 replies; this thread needs two.
	for (let index = 1; index <= 103; index++)
		await running.post(channel, `reply ${index}`, { threadId: root.id });
	renderAt("#/channels/general");
	const view = await room("general");
	const asked = await row(view, "Long thread");
	fireEvent.click(asked.getByRole("button", { name: "103 replies" }));
	const thread = within(
		await screen.findByRole("complementary", { name: "Thread" }),
	);
	expect(await thread.findByText("reply 103", {}, SOON)).toBeDefined();
	expect(thread.getByText("reply 1")).toBeDefined();
	expect(thread.getByText("reply 100")).toBeDefined();
	expect(thread.queryByText(/Showing \d+ of/)).toBeNull();
});

it("shows a channel created while the list was still loading", async () => {
	const running = await boot();
	// No periodic refresh rescues this test: the list is read once.
	setChannelTimings({ listIntervalMs: 600_000 });
	// Hold the first read of the channel list until a channel has been created.
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const real = globalThis.fetch;
	let first = true;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const response = await real(input, init);
		if (
			first &&
			(init?.method ?? "GET") === "GET" &&
			url.endsWith("/channels")
		) {
			first = false;
			await held;
		}
		return response;
	});
	renderAt("#/channels");
	fireEvent.click(await screen.findByRole("button", { name: "New channel" }));
	const form = within(screen.getByRole("region", { name: "New channel" }));
	type(form.getByLabelText("Name"), "general");
	fireEvent.click(form.getByRole("button", { name: "Create channel" }));
	await waitFor(async () =>
		expect((await running.list()).map((item) => item.name)).toEqual([
			"general",
		]),
	);
	// The held answer predates the channel; the view must not settle on it.
	release();
	expect(await room("general")).toBeDefined();
	expect(channelList().getByText("general")).toBeDefined();
});

it("pages back through earlier messages", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	for (let index = 1; index <= 60; index++)
		await running.post(channel, `message ${index}`);
	renderAt("#/channels/general");
	const view = await room("general");
	// The latest page is 50 entries; the log is 61 with the creation note.
	expect(await within(view).findByText("message 60")).toBeDefined();
	expect(within(view).getByText("message 11")).toBeDefined();
	expect(within(view).queryByText("message 10")).toBeNull();
	expect(within(view).queryByText(/This is the start of/)).toBeNull();
	fireEvent.click(within(view).getByRole("button", { name: "Load earlier" }));
	expect(await within(view).findByText("message 1")).toBeDefined();
	expect(within(view).getByText("Founder created this channel")).toBeDefined();
	expect(
		within(view).queryByRole("button", { name: "Load earlier" }),
	).toBeNull();
	expect(within(view).getByText(/This is the start of/)).toBeDefined();
	const shown = within(view)
		.getAllByText(/^message \d+$/)
		.map((element) => element.textContent);
	expect(shown).toEqual(
		Array.from({ length: 60 }, (_, index) => `message ${index + 1}`),
	);
});

it("stops following while the tab is hidden and recovers from a lost connection", async () => {
	const running = await boot();
	const channel = await running.createChannel("general");
	const grace = await running.join("Grace");
	renderAt("#/channels/general");
	const view = await room("general");
	await within(view).findByText("Founder created this channel");
	const wait = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));
	const hide = (hidden: boolean) => {
		vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
		document.dispatchEvent(new Event("visibilitychange"));
	};

	// The long poll in flight ends; no other starts while the tab is hidden.
	hide(true);
	await wait(1300);
	await running.post(channel, "While you were away", { token: grace.token });
	await wait(1300);
	expect(within(view).queryByText("While you were away")).toBeNull();
	hide(false);
	expect(
		await within(view).findByText("While you were away", {}, SOON),
	).toBeDefined();

	// A failed poll says so, backs off, and picks up where it left off.
	const realFetch = globalThis.fetch;
	let failing = true;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		if (failing && String(input).includes("/messages?after="))
			throw new TypeError("Failed to fetch");
		return realFetch(input, init);
	});
	expect(
		await within(view).findByText("Connection lost. Reconnecting…", {}, SOON),
	).toBeDefined();
	await running.post(channel, "Back online", { token: grace.token });
	failing = false;
	expect(await within(view).findByText("Back online", {}, SOON)).toBeDefined();
	expect(within(view).queryByText(/Connection lost/)).toBeNull();
	expect(within(view).getAllByText("While you were away")).toHaveLength(1);
});

it("offers the channel grants on agent and API tokens", async () => {
	await boot();
	renderAt("#/agent-tokens");
	await screen.findByText(/No agent tokens yet/);
	fireEvent.click(screen.getByRole("button", { name: "Create token" }));
	const manage = screen.getByRole("checkbox", {
		name: "Channels: Manage",
	}) as HTMLInputElement;
	expect(manage.checked).toBe(false);
	expect(
		screen.getByText(
			"Lets this bot create and manage channels, which opens every channel in the workspace to it.",
		),
	).toBeDefined();
	type(screen.getByLabelText("Name"), "Channel keeper");
	fireEvent.click(manage);
	fireEvent.click(
		within(
			screen.getByRole("region", { name: "Create agent token" }),
		).getByRole("button", { name: "Create token" }),
	);
	await screen.findByLabelText("New agent token");
	// The list is read again after the token is made.
	expect(
		await within(
			await screen.findByRole("region", { name: "Your tokens" }),
		).findByText("Channels: Manage"),
	).toBeDefined();

	fireEvent.click(screen.getByRole("link", { name: "API Tokens" }));
	await screen.findByText(/No API tokens yet/);
	fireEvent.click(screen.getByRole("button", { name: "Create token" }));
	const read = screen.getByRole("checkbox", {
		name: "Channels: Read",
	}) as HTMLInputElement;
	// Posting includes reading, as Edit includes Read elsewhere.
	fireEvent.click(screen.getByRole("checkbox", { name: "Channels: Post" }));
	expect(read.checked).toBe(true);
	expect(read.disabled).toBe(true);
});

describe("channel helpers", () => {
	it("reads the channel name from the URL", () => {
		expect(parseChannelsRoute("#/w/abc/channels/film-qc")).toEqual({
			name: "film-qc",
		});
		expect(parseChannelsRoute("#/channels/General")).toEqual({
			name: "general",
		});
		for (const hash of [
			"#/w/abc/channels",
			"#/channels/has%20space",
			"#/models",
		])
			expect(parseChannelsRoute(hash)).toEqual({ name: null });
	});

	it("shows a mention of someone who is no longer a member as unknown", () => {
		const { container } = render(
			<MessageBody
				body="Ask <@user:9b0a6d3e-58a1-4d0b-9d5a-0c1e2f3a4b5c> or `<@agent:x>`"
				members={memberIndex([])}
				me=""
			/>,
		);
		expect(container.querySelector(".channel-mention")?.textContent).toBe(
			"@unknown",
		);
		// Inside code a mention stays as written.
		expect(container.querySelector("code")?.textContent).toBe("<@agent:x>");
	});

	it("labels days relative to now", () => {
		const now = new Date(2026, 10, 13, 12);
		expect(dayLabel(new Date(2026, 10, 13, 1).toISOString(), now)).toBe(
			"Today",
		);
		expect(dayLabel(new Date(2026, 10, 12, 23).toISOString(), now)).toBe(
			"Yesterday",
		);
		expect(dayLabel(new Date(2025, 0, 2).toISOString(), now)).toMatch(/2025/);
	});

	it("applies an entry that arrives twice only once", () => {
		const message = (
			seq: number,
			threadId: string | null = null,
		): ChannelMessage => ({
			id: `m${seq}`,
			channelId: "c",
			seq,
			type: "message",
			createdAt: "2026-11-13T10:00:00.000Z",
			author: { kind: "user", id: "u", name: "Founder" },
			body: `body ${seq}`,
			mentions: [],
			threadId,
			replyCount: 0,
			editedAt: null,
			deletedAt: null,
		});
		let state = roomReducer(emptyRoom, {
			type: "page",
			entries: [message(2)],
			cursor: 2,
		});
		state = roomReducer(state, { type: "thread-open", rootId: "m2" });
		// The response to a post and the long poll both deliver the reply.
		const reply = message(3, "m2");
		state = roomReducer(state, {
			type: "posted",
			nonce: "n",
			message: reply,
		});
		state = roomReducer(state, {
			type: "entries",
			entries: [reply],
			cursor: 3,
		});
		expect(state.timeline).toMatchObject([{ id: "m2", replyCount: 1 }]);
		expect(state.thread?.messages.map((item) => item.id)).toEqual(["m2", "m3"]);
		expect(state.cursor).toBe(3);
		// A change replaces the message wherever it is shown.
		state = roomReducer(state, {
			type: "entries",
			cursor: 4,
			entries: [
				{
					id: "e4",
					channelId: "c",
					seq: 4,
					type: "change",
					createdAt: "2026-11-13T10:01:00.000Z",
					author: reply.author,
					change: "edited",
					message: {
						...reply,
						body: "edited",
						editedAt: "2026-11-13T10:01:00.000Z",
					},
				},
			],
		});
		expect(state.thread?.messages[1].body).toBe("edited");
		expect(state.timeline).toHaveLength(1);
	});
});

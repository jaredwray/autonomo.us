import { createHash, randomBytes } from "node:crypto";
import type {
	AgentConnectionList,
	AgentList,
	AgentToken,
	AgentTokenSecret,
	AgentTokenSettings,
	BotDetails,
	BotList,
	ChannelDetails,
	ChannelEntryList,
	ChannelMessage,
	CreateBotRequest,
	OAuthSignInDecision,
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
import { safeReturn } from "../src/AuthorizeView.js";
import { parseAgentsRoute, signInRequestId } from "../src/agents-route.js";
import { clearCredential, setSessionToken } from "../src/api.js";
import { replyingLine } from "../src/ChannelRoom.js";
import { setChannelTimings } from "../src/channels-state.js";
import { browser } from "../src/navigation.js";
import { defaultWorkspaceId, PASSWORD, setUpOwner } from "./session.js";

// The Agents view runs against a real gateway whose default workspace has a
// real provider: an OpenAI-compatible stub server. `stub/chat-model` answers
// "Hello there", `stub/slow-model` stalls 1.5 s before "Slow reply", and
// `stub/broken-model` fails with "provider exploded". An app's OAuth sign-in
// is driven the way an MCP app does it, with plain requests.

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
	window.sessionStorage.clear();
});

const SOON = { timeout: 8000 };
/** Where the test's MCP app receives its sign-in. */
const REDIRECT = "http://127.0.0.1:7777/callback";

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
	const agents = async () =>
		(await api<AgentList>("GET", `${base}/agents`)).agents;
	const agentTokens = () =>
		api<AgentTokenSettings>("GET", `${base}/agent-tokens`);
	const tokenAgent = (name: string, permissions = ["mcp:read", "mcp:call"]) =>
		api<AgentTokenSecret>("POST", `${base}/agent-tokens`, {
			name,
			description: "",
			ttlDays: 7,
			permissions,
		});
	const oauthAgent = (name: string, permissions = ["mcp:read", "mcp:call"]) =>
		api<AgentToken>("POST", `${base}/agents/oauth`, {
			name,
			description: "",
			permissions,
		});
	const form = (path: string, params: Record<string, string>) =>
		fetch(`${url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(params),
		});
	/** An MCP app registers itself and starts a sign-in, as far as the dashboard. */
	const startSignIn = async (name = "Test app") => {
		const registered = (await (
			await fetch(`${url}/oauth/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
			})
		).json()) as { client_id: string };
		const verifier = randomBytes(32).toString("base64url");
		const response = await fetch(
			`${url}/oauth/authorize?${new URLSearchParams({
				response_type: "code",
				client_id: registered.client_id,
				redirect_uri: REDIRECT,
				code_challenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				code_challenge_method: "S256",
				state: "from the app",
			})}`,
			{ redirect: "manual" },
		);
		const location = response.headers.get("location") ?? "";
		const id = signInRequestId(new URL(location).hash);
		if (!id) throw new Error(`No sign-in in ${location}`);
		return { client: registered.client_id, verifier, id, location };
	};
	/** The app's half after approval: its code for tokens. */
	const exchange = async (
		started: { client: string; verifier: string },
		redirectTo: string,
	) => {
		const response = await form("/oauth/token", {
			grant_type: "authorization_code",
			code: new URL(redirectTo).searchParams.get("code") ?? "",
			client_id: started.client,
			redirect_uri: REDIRECT,
			code_verifier: started.verifier,
		});
		if (!response.ok) throw new Error(await response.text());
		return (await response.json()) as {
			access_token: string;
			refresh_token: string;
		};
	};
	/** Signs an app in to an OAuth agent without the dashboard. */
	const connect = async (agentId: string, name = "Test app") => {
		const started = await startSignIn(name);
		const decision = await api<OAuthSignInDecision>(
			"POST",
			`${base}/oauth/sign-ins/${started.id}/approve`,
			{ agentId },
		);
		return exchange(started, decision.redirectTo);
	};
	/** Whether an access token still speaks MCP. */
	const mcpStatus = async (token: string) =>
		(
			await fetch(`${url}/mcp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			})
		).status;
	const connections = async (agentId: string) =>
		(
			await api<AgentConnectionList>(
				"GET",
				`${base}/agents/${agentId}/connections`,
			)
		).connections;
	return {
		url,
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
		agents,
		agentTokens,
		tokenAgent,
		oauthAgent,
		startSignIn,
		exchange,
		connect,
		mcpStatus,
		connections,
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
const agentList = () =>
	within(screen.getByRole("complementary", { name: "Agent list" }));
const checkbox = (scope: ReturnType<typeof within>, name: string) =>
	scope.getByRole("checkbox", { name }) as HTMLInputElement;
/** Opens the new-agent form for one of the three kinds. */
const newAgent = async (
	kind: "With instructions" | "OAuth sign-in" | "Token",
) => {
	fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
	const chooser = within(screen.getByRole("region", { name: "New agent" }));
	fireEvent.click(
		chooser.getByRole("button", { name: new RegExp(`^${kind}`) }),
	);
};
/** The consent screen, once the sign-in it is about has loaded. */
const consent = async () => {
	await screen.findByText(/Approve it only if you started this sign-in/);
	return within(
		screen.getByRole("region", { name: "An app wants to sign in" }),
	);
};
const facts = (scope: ReturnType<typeof within>, term: string) =>
	(scope.getByText(term, { selector: "dt" }).nextElementSibling as HTMLElement)
		.textContent;
const field = (scope: ReturnType<typeof within>, label: string) =>
	scope.getByLabelText(label) as HTMLInputElement;
/** The row of the runs table whose status reads `status`. */
const runRow = async (status: string) => {
	const row = (await screen.findByText(status, {}, SOON)).closest("tr");
	if (!row) throw new Error(`No run with status ${status}`);
	return row;
};

it("creates an agent with instructions from the UI, edits and pauses it, and deletes it", async () => {
	const running = await boot();
	// A link from when these were called bots lands on Agents.
	renderAt("#/bots");
	expect(await screen.findByRole("heading", { name: "Agents" })).toBeDefined();
	expect(
		screen.getByText(/An agent takes part in this workspace's channels/),
	).toBeDefined();
	expect(
		screen.getByRole("link", { name: "Agents" }).getAttribute("aria-current"),
	).toBe("page");
	expect(screen.queryByRole("link", { name: "Bots" })).toBeNull();
	expect(screen.queryByRole("link", { name: "Agent Tokens" })).toBeNull();
	expect(await screen.findByText(/No agents yet\. Create one/)).toBeDefined();
	expect(window.location.hash).toBe(`#/w/${running.workspaceId}/agents`);

	// The three ways to make an agent, each in a sentence.
	fireEvent.click(screen.getByRole("button", { name: "New agent" }));
	const chooser = within(screen.getByRole("region", { name: "New agent" }));
	expect(
		chooser.getAllByRole("button").map((button) => button.textContent),
	).toEqual([
		"",
		"With instructionsThe gateway runs it. It answers in channels when someone mentions it, using a model from this workspace.",
		"OAuth sign-inAn MCP app such as Claude or Cursor signs in, and you approve it here. There is no token to copy.",
		"TokenYou copy an agent token into an MCP app or a script.",
	]);
	fireEvent.click(chooser.getByRole("button", { name: /^With instructions/ }));
	const form = within(
		screen.getByRole("region", { name: "New agent: with instructions" }),
	);
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
			"Lets a reply search and write this agent's own Synapse space, propose changes to the shared space, and read its other channels.",
		),
	).toBeDefined();
	expect(
		within(field(form, "Agent-to-agent replies"))
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["0", "1", "2", "3"]);
	expect(
		form.getByText(
			"0 answers people only. Higher values let a chain of agents answer each other that many steps.",
		),
	).toBeDefined();
	fireEvent.click(field(form, "Use tools"));
	type(field(form, "Agent-to-agent replies"), "1");
	fireEvent.click(form.getByRole("button", { name: "Create agent" }));

	expect(await screen.findByText("Created Helper.")).toBeDefined();
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
		`#/w/${running.workspaceId}/agents/${created.id}`,
	);
	// What to do with a new agent, with the way there.
	const view = within(await screen.findByRole("region", { name: "Helper" }));
	expect(
		view.getByText(/Next: add it to a channel from the channel's Details/),
	).toBeDefined();
	expect(
		view.getByRole("link", { name: "Open Channels" }).getAttribute("href"),
	).toBe(`#/w/${running.workspaceId}/channels`);
	const item = () => agentList().getByRole("link", { name: /^Helper/ });
	expect(item().textContent).toBe("HelperInstructionsstub/chat-model");
	expect(
		view.getByText(/0 \/ 30 replies this hour · 0 \/ 500,000 tokens today/),
	).toBeDefined();
	expect(view.getByText(/No runs yet/)).toBeDefined();

	// Editing: a tighter limit, and paused.
	const save = () => view.getByRole("button", { name: "Save changes" });
	expect((save() as HTMLButtonElement).disabled).toBe(true);
	type(field(view, "Replies an hour"), "5");
	fireEvent.click(field(view, "Active"));
	expect(view.getByText("Answers nothing.")).toBeDefined();
	fireEvent.click(save());
	expect(await screen.findByText("Saved Helper.")).toBeDefined();
	await waitFor(() => expect(item().textContent).toContain("paused"));
	expect(view.getByText("Paused", { selector: ".bot-chip" })).toBeDefined();
	expect(view.getByText(/0 \/ 5 replies this hour/)).toBeDefined();
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
	fireEvent.click(view.getByRole("button", { name: "Delete agent" }));
	expect(await screen.findByText("Deleted Helper.")).toBeDefined();
	expect(window.location.hash).toBe(`#/w/${running.workspaceId}/agents`);
	await waitFor(() =>
		expect(agentList().queryByRole("link", { name: /^Helper/ })).toBeNull(),
	);
	expect(agentList().getByRole("link", { name: /^Other/ })).toBeDefined();
	expect((await running.bots()).map((bot) => bot.name)).toEqual(["Other"]);
});

it("shows agents read-only to a member and reports a refused save", async () => {
	const running = await boot();
	const helper = await running.bot({
		name: "Helper",
		instructions: "Track the trailer.",
	});
	const keyed = await running.tokenAgent("Keyed", ["mcp:read"]);
	const signedIn = await running.oauthAgent("Signed in");
	await running.connect(signedIn.id);
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

	// From then on the dashboard shows her the agent without a way to change it.
	cleanup();
	const asked: string[] = [];
	const real = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		asked.push(String(input instanceof Request ? input.url : input));
		return real(input, init);
	});
	renderAt(`#/agents/${helper.id}`);
	const readOnly = within(
		await screen.findByRole("region", { name: "Helper" }),
	);
	expect(screen.getByText(/A workspace admin manages agents\./)).toBeDefined();
	expect(screen.queryByRole("button", { name: "New agent" })).toBeNull();
	expect(readOnly.getByText("stub/chat-model")).toBeDefined();
	expect(readOnly.getByText("Track the trailer.")).toBeDefined();
	expect(readOnly.getByText("Active")).toBeDefined();
	expect(readOnly.queryByRole("textbox")).toBeNull();
	for (const name of ["Save changes", "Delete"])
		expect(readOnly.queryByRole("button", { name })).toBeNull();
	expect(readOnly.getByRole("button", { name: "Refresh" })).toBeDefined();

	// Agents that use MCP show who they are, and nothing about credentials.
	expect(
		agentList()
			.getAllByRole("link")
			.map((link) => link.textContent),
	).toEqual([
		"HelperInstructionsstub/chat-model",
		"KeyedTokenMCP: Read",
		"Signed inOAuth sign-inMCP: Read, MCP: Call · 1 app signed in",
	]);
	fireEvent.click(agentList().getByRole("link", { name: /^Keyed/ }));
	const token = within(await screen.findByRole("region", { name: "Keyed" }));
	expect(facts(token, "Connects with")).toBe("An agent token");
	expect(facts(token, "Grants")).toBe("MCP: Read");
	expect(token.queryByRole("button")).toBeNull();
	expect(screen.queryByText(keyed.token.prefix)).toBeNull();
	fireEvent.click(agentList().getByRole("link", { name: /^Signed in/ }));
	const oauth = within(
		await screen.findByRole("region", { name: "Signed in" }),
	);
	expect(facts(oauth, "Connects with")).toBe("OAuth sign-in from an MCP app");
	expect(facts(oauth, "Apps signed in")).toBe("1");
	expect(oauth.queryByRole("button")).toBeNull();
	expect(screen.queryByRole("region", { name: "Connect an app" })).toBeNull();
	// She is never sent to the routes the gateway would refuse her.
	expect(asked.some((url) => url.endsWith("/agents"))).toBe(true);
	expect(
		asked.filter((url) => /\/agent-tokens|\/connections/.test(url)),
	).toEqual([]);
	expect(screen.queryByRole("alert")).toBeNull();
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

	// The run is on the agent's page, with what it cost.
	fireEvent.click(screen.getByRole("link", { name: "Agents" }));
	fireEvent.click(await agentList().findByRole("link", { name: /^Slow/ }));
	const row = within(await runRow("Succeeded"));
	expect(row.getByText("Succeeded").className).toContain("succeeded");
	expect(row.getByText("#general")).toBeDefined();
	expect(row.getByText("stub/slow-model")).toBeDefined();
	expect(row.getByText("15")).toBeDefined();
	expect(
		within(screen.getByRole("region", { name: "Slow" })).getByText(
			/1 \/ 30 replies this hour · 15 \/ 500,000 tokens today/,
		),
	).toBeDefined();
	expect(agentList().getByRole("link", { name: /^Sleepy/ }).textContent).toBe(
		"SleepyInstructionspausedstub/chat-model",
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
	renderAt(`#/agents/${broken.id}`);
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
	fireEvent.click(agentList().getByRole("link", { name: /^Limited/ }));
	const skipped = within(await runRow("Skipped"));
	expect(skipped.getByText("Skipped").className).toContain("skipped");
	expect(
		skipped.getByText("Reached its limit of 1 replies an hour."),
	).toBeDefined();
	expect(
		within(await runRow("Succeeded")).getByText("stub/chat-model"),
	).toBeDefined();
});

it("opens the agent list when a link names a workspace that cannot be opened", async () => {
	const running = await boot();
	await running.bot({ name: "Helper" });
	// A bookmark from a workspace this person is not in, to a bot there.
	renderAt(
		"#/w/9b0a6d3e-58a1-4d0b-9d5a-0c1e2f3a4b5c/bots/1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
	);
	const list = within(
		await screen.findByRole("complementary", { name: "Agent list" }, SOON),
	);
	expect(await list.findByText("Helper", {}, SOON)).toBeDefined();
	// The link lands in this workspace without the other workspace's agent.
	expect(window.location.hash).toBe(`#/w/${running.workspaceId}/agents`);
	expect(screen.queryByText("Agent not found")).toBeNull();
	// And it still says the workspace in the link could not be opened.
	expect(
		screen.getByText("That workspace isn't available. Showing Default."),
	).toBeDefined();
});

it("reads the agent and a sign-in from the URL, names who is replying, and checks where a sign-in returns", () => {
	const id = "9b0a6d3e-58a1-4d0b-9d5a-0c1e2f3a4b5c";
	for (const hash of [
		`#/w/abc/agents/${id}`,
		`#/agents/${id}`,
		// From before the views were merged.
		`#/w/abc/bots/${id}`,
	])
		expect(parseAgentsRoute(hash)).toEqual({ id });
	for (const hash of [
		"#/w/abc/agents",
		"#/agents/new",
		"#/agent-tokens",
		`#/channels/${id}`,
	])
		expect(parseAgentsRoute(hash)).toEqual({ id: null });
	const request = "a".repeat(43);
	expect(signInRequestId(`#/authorize/${request}`)).toBe(request);
	for (const hash of [
		"#/authorize/short",
		`#/authorize/${request}/more`,
		`#/w/abc/authorize/${request}`,
	])
		expect(signInRequestId(hash)).toBeNull();
	// The browser only ever goes to the address the person was shown.
	const shown = "https://app.example/callback";
	expect(safeReturn(`${shown}?code=abc&state=${"s".repeat(4000)}`, shown)).toBe(
		true,
	);
	expect(
		safeReturn(
			"cursor://anysphere.cursor-mcp/oauth/callback?code=abc",
			"cursor://anysphere.cursor-mcp/oauth/callback",
		),
	).toBe(true);
	for (const [target, expected] of [
		["https://evil.example/callback?code=abc", shown],
		["https://app.example/other?code=abc", shown],
		["javascript:alert(1)", "javascript:alert(1)"],
		["data:text/html,hi", "data:text/html,hi"],
		["http://app.example/callback", "http://app.example/callback"],
		["not a url", shown],
	])
		expect(safeReturn(target, expected), target).toBe(false);
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

it("creates an agent with a token, shows the value once, and edits, rolls, and revokes it", async () => {
	const running = await boot();
	// A link to the former Agent Tokens page lands on Agents.
	renderAt("#/agent-tokens");
	expect(await screen.findByRole("heading", { name: "Agents" })).toBeDefined();
	expect(window.location.hash).toBe(`#/w/${running.workspaceId}/agents`);
	await newAgent("Token");
	const form = within(
		screen.getByRole("region", { name: "Create agent token" }),
	);
	expect(form.queryByRole("checkbox", { name: "Models: Read" })).toBeNull();
	for (const name of ["MCP: Read", "MCP: Call", "Channels: Manage"])
		expect(checkbox(form, name).checked).toBe(false);
	expect(
		form.getByText(
			"Lets this agent create and manage channels, which opens every channel in the workspace to it.",
		),
	).toBeDefined();
	type(field(form, "Name"), "Research agent");
	type(field(form, "Description"), "Weekly research through MCP");
	type(field(form, "TTL"), "never");
	fireEvent.click(checkbox(form, "MCP: Read"));
	fireEvent.click(checkbox(form, "MCP: Call"));
	fireEvent.click(form.getByRole("button", { name: "Create token" }));
	const first = (
		(await screen.findByLabelText("New agent token")) as HTMLTextAreaElement
	).value;
	expect(first).toMatch(/^agt_/);
	expect(JSON.stringify(window.localStorage)).not.toContain(first);
	expect(JSON.stringify(window.sessionStorage)).not.toContain(first);
	expect(await screen.findByText("Created Research agent.")).toBeDefined();
	const [made] = await running.agents();
	expect(made).toMatchObject({ kind: "token", name: "Research agent" });
	expect(window.location.hash).toBe(
		`#/w/${running.workspaceId}/agents/${made.id}`,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "I’ve saved this token" }),
	);
	expect(screen.queryByLabelText("New agent token")).toBeNull();
	const view = () => within(screen.getByRole("region", { name: /^Research/ }));
	expect(facts(view(), "Grants")).toBe("MCP: Read, MCP: Call");
	expect(facts(view(), "Expires")).toBe("Never");
	expect(view().getByText(`${running.url}/mcp`)).toBeDefined();
	expect(
		agentList().getByRole("link", { name: /^Research agent/ }).textContent,
	).toBe("Research agentTokenMCP: Read, MCP: Call");

	fireEvent.click(
		await screen.findByRole("button", { name: "Edit Research agent" }),
	);
	const edit = within(
		screen.getByRole("region", { name: "Edit Research agent" }),
	);
	for (const name of ["MCP: Read", "MCP: Call"])
		expect(checkbox(edit, name).checked).toBe(true);
	fireEvent.click(checkbox(edit, "MCP: Call"));
	type(field(edit, "Name"), "Research assistant");
	fireEvent.click(edit.getByRole("button", { name: "Save changes" }));
	await screen.findByText("Token updated.");
	fireEvent.click(
		await screen.findByRole("button", { name: "Roll Research assistant" }),
	);
	type(screen.getByLabelText("New token TTL"), "7");
	type(screen.getByLabelText("Keep previous token alive for"), "custom");
	type(screen.getByLabelText("Overlap (hours)"), "2");
	fireEvent.click(
		screen.getByRole("button", { name: "Roll token", exact: true }),
	);
	const second = (
		(await screen.findByLabelText("New agent token")) as HTMLTextAreaElement
	).value;
	expect(second).not.toBe(first);
	fireEvent.click(
		screen.getByRole("button", { name: "I’ve saved this token" }),
	);
	await waitFor(() => expect(facts(view(), "Token")).toContain("Previous"));
	expect((await running.agentTokens()).tokens[0]).toMatchObject({
		name: "Research assistant",
		auth: "token",
		permissions: ["mcp:read"],
		ttlDays: 7,
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Revoke Research assistant" }),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Revoke token", exact: true }),
	);
	await screen.findByText("Token revoked.");
	await waitFor(() =>
		expect(
			(
				screen.getByRole("button", {
					name: "Roll Research assistant",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true),
	);
	expect(
		agentList().getByRole("link", { name: /^Research assistant/ }).textContent,
	).toBe("Research assistantTokenrevokedMCP: Read");
	const log = screen.getByRole("region", { name: "History" });
	for (const action of ["created", "updated", "rolled", "revoked"])
		expect(within(log).getByText(action)).toBeDefined();
	expect(log.textContent).not.toContain(first);
	expect(log.textContent).not.toContain(second);
	// API tokens are a separate list with their own history.
	fireEvent.click(screen.getByRole("link", { name: "API Tokens" }));
	await screen.findByText(/No API tokens yet/);
	expect(screen.queryByText("Research assistant")).toBeNull();
	expect(screen.getByText("No token actions yet.")).toBeDefined();
});

it("forgets an unsaved token value when the person goes elsewhere or signs out", async () => {
	const running = await boot();
	await running.bot({ name: "Helper" });
	renderAt("#/agents");
	const create = async (name: string) => {
		await newAgent("Token");
		type(screen.getByLabelText("Name"), name);
		fireEvent.click(
			within(
				screen.getByRole("region", { name: "Create agent token" }),
			).getByRole("button", { name: "Create token" }),
		);
		return (
			(await screen.findByLabelText("New agent token")) as HTMLTextAreaElement
		).value;
	};
	// Another agent in the list.
	const first = await create("Temporary agent");
	fireEvent.click(agentList().getByRole("link", { name: /^Helper/ }));
	await screen.findByRole("region", { name: "Helper" });
	fireEvent.click(agentList().getByRole("link", { name: /^Temporary agent/ }));
	await screen.findByRole("button", { name: "Edit Temporary agent" });
	expect(screen.queryByLabelText("New agent token")).toBeNull();
	// Another view.
	const second = await create("Second agent");
	fireEvent.click(screen.getByRole("link", { name: "API Tokens" }));
	await screen.findByText(/No API tokens yet/);
	fireEvent.click(screen.getByRole("link", { name: "Agents" }));
	await agentList().findByRole("link", { name: /^Second agent/ });
	expect(screen.queryByLabelText("New agent token")).toBeNull();
	// Signing out.
	const third = await create("Owner agent");
	fireEvent.click(screen.getByRole("button", { name: /Account menu for/ }));
	fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
	await screen.findByRole("heading", { name: "Sign in" });
	for (const secret of [first, second, third])
		expect(document.body.textContent).not.toContain(secret);
});

it("creates an agent that signs in with OAuth, lists its apps, and disconnects and revokes", async () => {
	const running = await boot();
	renderAt("#/agents");
	await newAgent("OAuth sign-in");
	const form = within(
		screen.getByRole("region", { name: "New agent: oauth sign-in" }),
	);
	// A working agent by default; managing channels is asked for.
	expect(checkbox(form, "MCP: Read").checked).toBe(true);
	expect(checkbox(form, "MCP: Call").checked).toBe(true);
	expect(checkbox(form, "Channels: Manage").checked).toBe(false);
	expect(form.queryByLabelText("TTL")).toBeNull();
	type(field(form, "Name"), "Claude");
	type(field(form, "Description"), "Desktop app");
	fireEvent.click(form.getByRole("button", { name: "Create agent" }));
	expect(await screen.findByText("Created Claude.")).toBeDefined();
	const [made] = await running.agents();
	expect(made).toMatchObject({
		kind: "oauth",
		name: "Claude",
		description: "Desktop app",
		permissions: ["mcp:read", "mcp:call"],
		connections: 0,
	});
	expect(window.location.hash).toBe(
		`#/w/${running.workspaceId}/agents/${made.id}`,
	);
	// No token exists, and what to do next is on the page.
	expect(screen.queryByLabelText("New agent token")).toBeNull();
	const connectPanel = within(
		await screen.findByRole("region", { name: "Connect an app" }),
	);
	expect(connectPanel.getByText(/Next: connect an app/)).toBeDefined();
	expect(
		(connectPanel.getByLabelText("MCP address") as HTMLInputElement).value,
	).toBe(`${running.url}/mcp`);
	expect(connectPanel.getAllByRole("listitem")).toHaveLength(3);
	const writeText = vi.fn(async () => {});
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	fireEvent.click(connectPanel.getByRole("button", { name: "Copy address" }));
	expect(await connectPanel.findByText("Address copied.")).toBeDefined();
	expect(writeText).toHaveBeenCalledWith(`${running.url}/mcp`);
	vi.unstubAllGlobals();
	const apps = () =>
		within(screen.getByRole("region", { name: "Signed-in apps" }));
	expect(await apps().findByText("No app is signed in.")).toBeDefined();
	const view = () => within(screen.getByRole("region", { name: "Claude" }));
	expect(view().queryByRole("button", { name: /^Roll/ })).toBeNull();

	// Two apps sign in; the page is opened again and lists both.
	const desktop = await running.connect(made.id, "Claude Desktop");
	const cursor = await running.connect(made.id, "Cursor");
	cleanup();
	renderAt(`#/agents/${made.id}`);
	const rows = async () =>
		(
			await within(
				await screen.findByRole("region", { name: "Signed-in apps" }),
			).findAllByRole("row")
		)
			.slice(1)
			.map((row) =>
				within(row)
					.getAllByRole("cell")
					.slice(0, 2)
					// Who approved it, without the time under the name.
					.map((cell) => cell.firstChild?.textContent),
			);
	expect(await rows()).toEqual([
		["Cursor", "Founder"],
		["Claude Desktop", "Founder"],
	]);
	expect(
		within(screen.getByRole("region", { name: "Signed-in apps" })).getAllByText(
			"Signed in at 127.0.0.1:7777",
		),
	).toHaveLength(2);
	expect(
		within(screen.getByRole("region", { name: "Signed-in apps" })).getAllByText(
			"The app chose this name.",
		),
	).toHaveLength(2);
	expect(screen.queryByText(/Next: connect an app/)).toBeNull();
	expect(agentList().getByRole("link", { name: /^Claude/ }).textContent).toBe(
		"ClaudeOAuth sign-inMCP: Read, MCP: Call · 2 apps signed in",
	);
	const log = () => within(screen.getByRole("region", { name: "History" }));
	expect(log().getAllByText("connected")).toHaveLength(2);
	expect(log().getByText("Cursor signed in at 127.0.0.1:7777.")).toBeDefined();

	// One app is disconnected; the other keeps working.
	fireEvent.click(apps().getByRole("button", { name: "Disconnect Cursor" }));
	expect(await screen.findByText("Disconnected Cursor.")).toBeDefined();
	await waitFor(async () => expect(await rows()).toHaveLength(1));
	expect(await running.mcpStatus(cursor.access_token)).toBe(401);
	expect(await running.mcpStatus(desktop.access_token)).toBe(200);
	await waitFor(() =>
		expect(
			agentList().getByRole("link", { name: /^Claude/ }).textContent,
		).toContain("1 app signed in"),
	);
	await waitFor(() => expect(log().getByText("disconnected")).toBeDefined());

	// Its grants change for every app at once.
	fireEvent.click(view().getByRole("button", { name: "Edit Claude" }));
	fireEvent.click(checkbox(view(), "MCP: Call"));
	fireEvent.click(view().getByRole("button", { name: "Save changes" }));
	expect(await screen.findByText("Saved Claude.")).toBeDefined();
	await waitFor(() => expect(facts(view(), "Grants")).toBe("MCP: Read"));
	expect((await running.agents())[0].permissions).toEqual(["mcp:read"]);

	// Revoking asks first, then signs every app out for good.
	fireEvent.click(view().getByRole("button", { name: "Revoke Claude" }));
	expect(
		view().getByText(/Every app signed in to it is signed out at once/),
	).toBeDefined();
	fireEvent.click(view().getByRole("button", { name: "Cancel" }));
	fireEvent.click(view().getByRole("button", { name: "Revoke Claude" }));
	fireEvent.click(view().getByRole("button", { name: "Revoke agent" }));
	expect(await screen.findByText("Revoked Claude.")).toBeDefined();
	await waitFor(() => expect(facts(view(), "Status")).toBe("revoked"));
	expect(await running.mcpStatus(desktop.access_token)).toBe(401);
	expect(screen.queryByRole("region", { name: "Connect an app" })).toBeNull();
	expect(
		await apps().findByText("This agent is revoked. No app can sign in to it."),
	).toBeDefined();
	expect(view().queryByRole("button")).toBeNull();
	expect((await running.agents())[0]).toMatchObject({
		status: "revoked",
		connections: 0,
	});
});

it("asks a signed-out person to sign in, then lets them approve an app as a new agent", async () => {
	const running = await boot();
	const assign = vi.spyOn(browser, "assign").mockImplementation(() => {});
	const started = await running.startSignIn("Claude");
	// The gateway sent the browser here; nobody is signed in on it.
	expect(new URL(started.location).hash).toBe(`#/authorize/${started.id}`);
	clearCredential();
	renderAt(`#/authorize/${started.id}`);
	await screen.findByRole("heading", { name: "Sign in" });
	type(screen.getByLabelText("Email"), "founder@example.com");
	type(screen.getByLabelText("Password"), PASSWORD);
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

	const view = await consent();
	expect(screen.queryByRole("navigation")).toBeNull();
	expect(
		view.getByText(/Approve it only if you started this sign-in yourself/),
	).toBeDefined();
	// What the app says about itself is marked as its own word.
	expect(facts(view, "App")).toBe(
		"ClaudeThe app chose this name itself. Nobody verified it.",
	);
	expect(facts(view, "Sent back to")).toContain("127.0.0.1:7777");
	expect(facts(view, "Sent back to")).toContain(REDIRECT);
	expect(facts(view, "Seen before")).toBe(
		"No. This app registration has never been approved here.",
	);
	expect(
		within(field(view, "Workspace"))
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["Default"]);
	// No agent to choose yet: a new one, named after the app, that can work.
	expect(view.queryByRole("radio")).toBeNull();
	await waitFor(() => expect(field(view, "Agent name").value).toBe("Claude"));
	expect(checkbox(view, "MCP: Read").checked).toBe(true);
	expect(checkbox(view, "MCP: Call").checked).toBe(true);
	expect(checkbox(view, "Channels: Manage").checked).toBe(false);
	type(field(view, "Agent name"), "Claude at home");
	fireEvent.click(view.getByRole("button", { name: "Approve" }));

	expect(
		await screen.findByRole("heading", { name: "Sign-in approved" }),
	).toBeDefined();
	expect(screen.getByRole("status").textContent).toContain(
		"Return to the app; you can close this tab.",
	);
	expect(assign).toHaveBeenCalledTimes(1);
	const target = new URL(assign.mock.calls[0][0]);
	expect(target.origin + target.pathname).toBe(REDIRECT);
	expect(target.searchParams.get("state")).toBe("from the app");
	expect(target.searchParams.get("code")).toMatch(/^oac_/);
	// The app finishes: it is the new agent, in the workspace that approved it.
	const tokens = await running.exchange(started, target.href);
	expect(await running.mcpStatus(tokens.access_token)).toBe(200);
	const [agent] = await running.agents();
	expect(agent).toMatchObject({
		kind: "oauth",
		name: "Claude at home",
		permissions: ["mcp:read", "mcp:call"],
		connections: 1,
	});
	// And the way back into the dashboard.
	fireEvent.click(screen.getByRole("link", { name: "Open the dashboard" }));
	expect(
		await screen.findByRole("heading", { name: "Dashboard" }),
	).toBeDefined();
	await waitFor(() =>
		expect(window.location.hash).toBe(`#/w/${running.workspaceId}/dashboard`),
	);
});

it("signs an app in to an existing agent, refuses another, and says when a sign-in is over", async () => {
	const running = await boot();
	const assign = vi.spyOn(browser, "assign").mockImplementation(() => {});
	const shared = await running.oauthAgent("Shared agent", ["mcp:read"]);
	await running.tokenAgent("Token agent");
	const revoked = await running.oauthAgent("Old agent");
	await running.api("DELETE", `${running.base}/agent-tokens/${revoked.id}`);
	await running.connect(shared.id, "Cursor");

	// The same app registration again would be marked as seen; this is a new one.
	const started = await running.startSignIn("Cursor");
	renderAt(`#/authorize/${started.id}`);
	const view = await consent();
	// With agents to choose from, nothing is chosen for the person.
	const existing = (await view.findByRole("radio", {
		name: "An existing agent",
	})) as HTMLInputElement;
	expect(existing.checked).toBe(true);
	expect(
		within(field(view, "Sign in as"))
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["Choose an agent…", "Shared agent (MCP: Read)"]);
	const approve = view.getByRole("button", {
		name: "Approve",
	}) as HTMLButtonElement;
	expect(approve.disabled).toBe(true);
	// A new agent is still one click away, and back.
	fireEvent.click(view.getByRole("radio", { name: "A new agent" }));
	expect(field(view, "Agent name").value).toBe("Cursor");
	expect(approve.disabled).toBe(false);
	fireEvent.click(existing);
	type(field(view, "Sign in as"), shared.id);
	fireEvent.click(approve);
	await screen.findByRole("heading", { name: "Sign-in approved" });
	const tokens = await running.exchange(started, assign.mock.calls[0][0]);
	expect(await running.mcpStatus(tokens.access_token)).toBe(200);
	expect(
		(await running.connections(shared.id)).map((item) => item.clientName),
	).toEqual(["Cursor", "Cursor"]);
	expect((await running.agents()).map((agent) => agent.name)).toEqual([
		"Old agent",
		"Shared agent",
		"Token agent",
	]);

	// The decision was made once: the same link says so, with a way out.
	cleanup();
	renderAt(`#/authorize/${started.id}`);
	await screen.findByRole("heading", { name: "This sign-in can't be decided" });
	expect(screen.getByRole("alert").textContent).toBe(
		"This sign-in has expired or was already decided. Start it again from the app.",
	);
	expect(
		screen.getByRole("link", { name: "Open the dashboard" }),
	).toBeDefined();

	// Refusing tells the app, and grants nothing.
	cleanup();
	assign.mockClear();
	const refused = await running.startSignIn("Stranger");
	renderAt(`#/authorize/${refused.id}`);
	const again = await consent();
	await again.findByRole("radio", { name: "An existing agent" });
	fireEvent.click(again.getByRole("button", { name: "Deny" }));
	await screen.findByRole("heading", { name: "Sign-in refused" });
	const back = new URL(assign.mock.calls[0][0]);
	expect(back.origin + back.pathname).toBe(REDIRECT);
	expect(back.searchParams.get("error")).toBe("access_denied");
	expect(back.searchParams.get("state")).toBe("from the app");
	expect(back.searchParams.get("code")).toBeNull();
	expect(await running.connections(shared.id)).toHaveLength(2);
	expect(await running.agents()).toHaveLength(3);
});

it("lets only a workspace's admins approve there, and anyone refuse", async () => {
	const running = await boot();
	const assign = vi.spyOn(browser, "assign").mockImplementation(() => {});
	const film = await running.api<{ id: string }>("POST", "/v1/workspaces", {
		name: "Film",
		description: "",
	});
	// Grace is an admin of Default only; Linus is a member.
	const grace = await running.join("Grace", "admin");
	const linus = await running.join("Linus", "member");
	const started = await running.startSignIn("Claude");
	clearCredential();
	setSessionToken(grace.token);
	renderAt(`#/authorize/${started.id}`);
	const view = await consent();
	expect(
		within(field(view, "Workspace"))
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["Default"]);
	await waitFor(() => expect(field(view, "Agent name").value).toBe("Claude"));
	fireEvent.click(checkbox(view, "Channels: Manage"));
	fireEvent.click(view.getByRole("button", { name: "Approve" }));
	await screen.findByRole("heading", { name: "Sign-in approved" });
	expect(await running.agents()).toMatchObject([
		{
			name: "Claude",
			kind: "oauth",
			permissions: ["mcp:read", "mcp:call", "channels:manage"],
		},
	]);
	expect(
		(await running.api<AgentList>("GET", `/v1/${film.id}/agents`)).agents,
	).toEqual([]);
	const tokens = await running.exchange(started, assign.mock.calls[0][0]);
	expect(await running.mcpStatus(tokens.access_token)).toBe(200);

	// The owner chooses among every workspace.
	cleanup();
	clearCredential();
	setSessionToken(running.owner);
	const second = await running.startSignIn("Cursor");
	renderAt(`#/authorize/${second.id}`);
	const owner = await consent();
	await owner.findByRole("radio", { name: "An existing agent" });
	expect(
		within(field(owner, "Workspace"))
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["Default", "Film"]);
	// Film has no agent that signs in with OAuth, so a new one is offered.
	type(field(owner, "Workspace"), film.id);
	expect(
		((await owner.findByLabelText("Agent name")) as HTMLInputElement).value,
	).toBe("Cursor");
	expect(owner.queryByRole("radio")).toBeNull();
	fireEvent.click(owner.getByRole("button", { name: "Approve" }));
	await screen.findByRole("heading", { name: "Sign-in approved" });
	expect(
		(await running.api<AgentList>("GET", `/v1/${film.id}/agents`)).agents,
	).toMatchObject([{ name: "Cursor", kind: "oauth" }]);

	// A member can look and refuse, and is told who can approve.
	cleanup();
	assign.mockClear();
	clearCredential();
	setSessionToken(linus.token);
	const third = await running.startSignIn("Stranger");
	renderAt(`#/authorize/${third.id}`);
	const member = await consent();
	expect(member.getByText(/Approving needs a workspace admin/)).toBeDefined();
	expect(member.queryByRole("button", { name: "Approve" })).toBeNull();
	expect(member.queryByLabelText("Workspace")).toBeNull();
	fireEvent.click(member.getByRole("button", { name: "Deny" }));
	await screen.findByRole("heading", { name: "Sign-in refused" });
	expect(new URL(assign.mock.calls[0][0]).searchParams.get("error")).toBe(
		"access_denied",
	);
	expect(await running.agents()).toHaveLength(1);
});

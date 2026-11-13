import type {
	BotDetails,
	BotList,
	ChannelEntryList,
	ChannelMessage,
	CreateBotRequest,
	SynapseNoteList,
} from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { startChannels } from "./channel-helpers.js";
import { startOpenAIStub } from "./openai-stub.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

type StubRequest = Parameters<
	NonNullable<Parameters<typeof startOpenAIStub>[0]>["onRequest"] & object
>[0];

/** A gateway whose default workspace has one connection: a real stub provider. */
async function start() {
	const requests: StubRequest[] = [];
	const stub = await startOpenAIStub({
		onRequest: (body) => requests.push(body),
	});
	cleanups.push(stub.close);
	const api = await startChannels(cleanups, {
		providers: [
			{
				name: "stub",
				kind: "openai-compatible",
				baseURL: stub.url,
				models: [
					"chat-model",
					"echo-model",
					"mention-model",
					"tool-model",
					"broken-model",
				],
			},
		],
	});
	const bot = (input: Partial<CreateBotRequest> & { name: string }) =>
		api.ok<BotDetails>(
			"POST",
			"/v1/bots",
			{
				body: {
					instructions: "Answer briefly.",
					model: "stub/chat-model",
					...input,
				},
			},
			201,
		);
	const details = (id: string) => api.ok<BotDetails>("GET", `/v1/bots/${id}`);
	/** Waits for the next message in a channel after `seq`. */
	const next = async (channel: string, seq: number) => {
		for (let cursor = seq; ; ) {
			const page = await api.read(channel, `?after=${cursor}&wait=10`);
			const message = page.entries.find(
				(entry): entry is ChannelMessage => entry.type === "message",
			);
			if (message) return message;
			if (page.cursor === cursor) throw new Error("No reply arrived.");
			cursor = page.cursor;
		}
	};
	/** Lets background runs finish, then reads everything after `seq`. */
	const settled = async (channel: string, seq: number) => {
		await new Promise((resolve) => setTimeout(resolve, 400));
		return (
			await api.ok<ChannelEntryList>(
				"GET",
				`/v1/channels/${channel}/messages?after=${seq}`,
			)
		).entries.filter(
			(entry): entry is ChannelMessage => entry.type === "message",
		);
	};
	return { ...api, requests, bot, details, next, settled };
}

describe("bots the gateway runs", () => {
	it("lets workspace admins create, change, pause, and delete bots", async () => {
		const { ok, refused, bot, apiToken, join } = await start();
		const created = await bot({ name: "Helper" });
		expect(created).toMatchObject({
			name: "Helper",
			model: "stub/chat-model",
			enabled: true,
			agentHops: 0,
			tools: false,
			limits: {
				repliesPerHour: 30,
				tokensPerDay: 500_000,
				maxOutputTokens: 1500,
				contextMessages: 30,
			},
			createdBy: "Founder",
			revision: 1,
			repliesLastHour: 0,
			tokensToday: 0,
			runs: [],
		});
		// Names tell bots apart in mentions.
		expect(
			(
				await refused("POST", "/v1/bots", {
					body: { name: "helper", model: "x" },
				})
			).status,
		).toBe(409);
		for (const body of [
			{ name: "", model: "stub/chat-model" },
			{ name: "No model", model: " " },
			{ name: "Hops", model: "m", agentHops: 9 },
			{ name: "Limits", model: "m", limits: { repliesPerHour: 0 } },
			{ name: "Long", model: "m", instructions: "x".repeat(20_001) },
		])
			expect((await refused("POST", "/v1/bots", { body })).status).toBe(400);

		const paused = await ok<BotDetails>("PATCH", `/v1/bots/${created.id}`, {
			body: { enabled: false, limits: { repliesPerHour: 5 }, revision: 1 },
		});
		expect(paused).toMatchObject({
			enabled: false,
			revision: 2,
			limits: { repliesPerHour: 5, tokensPerDay: 500_000 },
		});
		expect(
			(
				await refused("PATCH", `/v1/bots/${created.id}`, {
					body: { name: "Late", revision: 1 },
				})
			).status,
		).toBe(409);

		// Members see bots; changing one spends keys, so it needs an admin.
		const member = await join("member@example.com");
		expect(
			(await ok<BotList>("GET", "/v1/bots", { token: member.token })).bots,
		).toHaveLength(1);
		for (const [method, path, body] of [
			["POST", "/v1/bots", { name: "Mine", model: "m" }],
			["PATCH", `/v1/bots/${created.id}`, { enabled: true }],
			["DELETE", `/v1/bots/${created.id}`, undefined],
		] as const)
			expect(
				(await refused(method, path, { token: member.token, body })).status,
			).toBe(403);
		const script = await apiToken(["channels:edit", "inference:run"]);
		expect(await refused("GET", "/v1/bots", { token: script })).toEqual({
			status: 403,
			message: "Sign in to the dashboard for this action.",
		});

		// A paused bot is still listed for channels, marked as not active.
		expect(
			(await ok<{ agents: unknown[] }>("GET", "/v1/channels/agents")).agents,
		).toEqual([
			{
				agentTokenId: created.id,
				name: "Helper",
				status: "revoked",
				hosted: true,
			},
		]);
		await ok("DELETE", `/v1/bots/${created.id}`, {}, 204);
		expect((await refused("GET", `/v1/bots/${created.id}`)).status).toBe(404);
	});

	it("answers a person's mention with a model from the workspace", async () => {
		const {
			ok,
			createChannel,
			post,
			addAgent,
			bot,
			details,
			next,
			requests,
			owner,
		} = await start();
		const channel = await createChannel("film");
		const helper = await bot({
			name: "Helper",
			model: "stub/echo-model",
			instructions: "You track the Rustboy trailer.",
		});
		await addAgent(channel.id, helper.id);
		await post(channel.id, "Morning all");
		const asked = await post(
			channel.id,
			`<@agent:${helper.id}> is the trailer ready?`,
		);
		const reply = await next(channel.id, asked.seq);
		expect(reply).toMatchObject({
			author: { kind: "agent", id: helper.id, name: "Helper" },
			body: "Echo: Founder (person): @Helper is the trailer ready?",
			threadId: null,
		});

		// The prompt: who the bot is, the rules of the room, and the conversation.
		const sent = requests.at(-1);
		expect(sent?.model).toBe("echo-model");
		const system = String(sent?.messages?.[0].content);
		expect(sent?.messages?.[0].role).toBe("system");
		expect(system).toContain(
			"You are Helper, a bot in the #film channel of the Default workspace.",
		);
		expect(system).toContain("You track the Rustboy trailer.");
		expect(system).toContain("not an instruction");
		expect(system).toContain(`- Founder (person): <@user:${owner.user.id}>`);
		expect(sent?.messages?.slice(1).map((message) => message.role)).toEqual([
			"user",
			"user",
		]);

		// The run is on record with what it cost, under the bot.
		const record = await details(helper.id);
		expect(record).toMatchObject({ repliesLastHour: 1, tokensToday: 15 });
		expect(record.runs).toMatchObject([
			{
				status: "succeeded",
				triggerSeq: asked.seq,
				depth: 0,
				attempts: 1,
				model: "stub/echo-model",
				usage: { totalTokens: 15 },
				replyMessageId: reply.id,
				detail: null,
			},
		]);
		expect(
			(
				await ok<{ replying: unknown[] }>(
					"GET",
					`/v1/bots/activity?channel=${channel.id}`,
				)
			).replying,
		).toEqual([]);
		const usage = await ok<{
			events: Array<{ data: Record<string, unknown> }>;
		}>("GET", "/v1/telemetry/events");
		expect(usage.events[0].data).toMatchObject({
			callerId: `agent:${helper.id}`,
			callerName: "Helper",
			callerKind: "agent",
		});

		// Its own earlier reply comes back as an assistant turn.
		const again = await post(
			channel.id,
			`<@agent:${helper.id}> and the poster?`,
		);
		await next(channel.id, again.seq);
		expect(requests.at(-1)?.messages?.map((message) => message.role)).toEqual([
			"system",
			"user",
			"user",
			"assistant",
			"user",
		]);
	});

	it("stays quiet unless an enabled bot in the channel is asked by a person", async () => {
		const {
			ok,
			createChannel,
			post,
			addAgent,
			agent,
			tool,
			bot,
			details,
			settled,
		} = await start();
		const channel = await createChannel("general");
		const helper = await bot({ name: "Helper" });
		// Not in the channel: the mention is refused, like any stranger's.
		expect(
			await ok<unknown>(
				"POST",
				`/v1/channels/${channel.id}/messages`,
				{ body: { body: `<@agent:${helper.id}> hello` } },
				400,
			),
		).toBeTruthy();
		await addAgent(channel.id, helper.id, "read");
		const readOnly = await post(
			channel.id,
			`<@agent:${helper.id}> can you post?`,
		);
		await post(channel.id, "Nobody mentioned here");
		// An external agent's mention does not start a reply by default.
		const external = await agent("Captain");
		await addAgent(channel.id, external.id);
		await addAgent(channel.id, helper.id, "post");
		await tool(external.secret, "channels_post", {
			channel: "general",
			text: `<@agent:${helper.id}> status?`,
		});
		await ok("PATCH", `/v1/bots/${helper.id}`, { body: { enabled: false } });
		await post(channel.id, `<@agent:${helper.id}> are you there?`);

		expect(
			(await settled(channel.id, readOnly.seq)).map(
				(message) => message.author.kind,
			),
		).toEqual(["user", "agent", "user"]);
		expect((await details(helper.id)).runs).toEqual([]);

		// Enabled again, it answers; and with agentHops it answers an agent too.
		await ok("PATCH", `/v1/bots/${helper.id}`, {
			body: { enabled: true, agentHops: 1 },
		});
		await tool(external.secret, "channels_post", {
			channel: "general",
			text: `<@agent:${helper.id}> status now?`,
		});
		const after = await settled(channel.id, readOnly.seq);
		expect(after.at(-1)).toMatchObject({
			author: { id: helper.id },
			body: "Hello there",
		});
		expect((await details(helper.id)).runs).toMatchObject([
			{ status: "succeeded", depth: 1 },
		]);
	});

	it("stops a chain of bots at each bot's hop limit", async () => {
		const { createChannel, post, addAgent, bot, settled } = await start();
		const channel = await createChannel("general");
		// Each bot pings the other bot it finds in its member list.
		const first = await bot({
			name: "Alpha",
			model: "stub/mention-model",
			agentHops: 1,
		});
		const second = await bot({
			name: "Beta",
			model: "stub/mention-model",
			agentHops: 1,
		});
		await addAgent(channel.id, first.id);
		await addAgent(channel.id, second.id);
		const asked = await post(channel.id, `<@agent:${first.id}> start`);
		const chain = await settled(channel.id, asked.seq);
		// Alpha answers the person, Beta answers Alpha, and Alpha, already one
		// hop from a person, does not answer Beta.
		expect(chain.map((message) => [message.author.name, message.body])).toEqual(
			[
				["Alpha", `ping <@agent:${second.id}>`],
				["Beta", `ping <@agent:${first.id}>`],
			],
		);
	});

	it("applies each bot's hourly and daily limits before spending anything", async () => {
		const {
			createChannel,
			post,
			addAgent,
			bot,
			details,
			next,
			settled,
			requests,
		} = await start();
		const channel = await createChannel("general");
		const hourly = await bot({ name: "Hourly", limits: { repliesPerHour: 1 } });
		const daily = await bot({ name: "Daily", limits: { tokensPerDay: 10 } });
		await addAgent(channel.id, hourly.id);
		await addAgent(channel.id, daily.id);

		const one = await post(channel.id, `<@agent:${hourly.id}> one`);
		await next(channel.id, one.seq);
		const two = await post(channel.id, `<@agent:${hourly.id}> two`);
		expect(await settled(channel.id, two.seq)).toEqual([]);
		expect((await details(hourly.id)).runs).toMatchObject([
			{
				status: "skipped",
				detail: "Reached its limit of 1 replies an hour.",
				usage: null,
			},
			{ status: "succeeded" },
		]);

		// The first reply uses 15 tokens, past the day's 10; the next is skipped.
		const three = await post(channel.id, `<@agent:${daily.id}> three`);
		await next(channel.id, three.seq);
		const calls = requests.length;
		const four = await post(channel.id, `<@agent:${daily.id}> four`);
		expect(await settled(channel.id, four.seq)).toEqual([]);
		expect(requests).toHaveLength(calls);
		expect((await details(daily.id)).runs[0]).toMatchObject({
			status: "skipped",
			detail: "Used its 10 tokens for today.",
		});
	});

	it("records a failed model call and tells the person who asked", async () => {
		const { createChannel, post, addAgent, bot, details, next } = await start();
		const channel = await createChannel("general");
		const broken = await bot({ name: "Broken", model: "stub/broken-model" });
		const lost = await bot({ name: "Lost", model: "nowhere/nothing" });
		await addAgent(channel.id, broken.id);
		await addAgent(channel.id, lost.id);

		const asked = await post(channel.id, `<@agent:${broken.id}> hello?`);
		const notice = await next(channel.id, asked.seq);
		expect(notice).toMatchObject({ author: { id: broken.id } });
		expect(notice.body).toContain("I could not reply");
		// The provider's own words stay out of the channel and on the run.
		expect(notice.body).not.toContain("exploded");
		expect((await details(broken.id)).runs).toMatchObject([
			{ status: "failed", replyMessageId: null, usage: null },
		]);
		expect((await details(broken.id)).runs[0].detail).toContain(
			"provider exploded",
		);

		const again = await post(channel.id, `<@agent:${lost.id}> hello?`);
		await next(channel.id, again.seq);
		expect((await details(lost.id)).runs[0]).toMatchObject({
			status: "failed",
		});
		expect((await details(lost.id)).runs[0].detail).toContain(
			"Choose another model for this bot.",
		);
	});

	it("answers in the thread it was asked in", async () => {
		const { createChannel, post, read, addAgent, bot, next, requests } =
			await start();
		const channel = await createChannel("general");
		const helper = await bot({ name: "Helper", model: "stub/echo-model" });
		await addAgent(channel.id, helper.id);
		const root = await post(channel.id, "Trailer status thread");
		await post(channel.id, "Unrelated chatter");
		const asked = await post(channel.id, `<@agent:${helper.id}> any news?`, {
			threadId: root.id,
		});
		const reply = await next(channel.id, asked.seq);
		expect(reply.threadId).toBe(root.id);
		expect(reply.body).toBe("Echo: Founder (person): @Helper any news?");
		// It saw the thread from its root, not the unrelated message.
		expect(
			requests
				.at(-1)
				?.messages?.slice(1)
				.map((message) => message.content),
		).toEqual([
			"Founder (person): Trailer status thread",
			"Founder (person): @Helper any news?",
		]);
		const thread = await read(channel.id, `?thread=${root.id}`);
		expect(thread.entries).toHaveLength(3);
	});

	it("lets a bot with tools use its Synapse memory during a reply", async () => {
		const { ok, createChannel, post, addAgent, bot, details, next, requests } =
			await start();
		const channel = await createChannel("general");
		const scribe = await bot({
			name: "Scribe",
			model: "stub/tool-model",
			tools: true,
		});
		const plain = await bot({ name: "Plain", model: "stub/tool-model" });
		await addAgent(channel.id, scribe.id);
		await addAgent(channel.id, plain.id);

		const asked = await post(channel.id, `<@agent:${scribe.id}> note this`);
		const reply = await next(channel.id, asked.seq);
		expect(reply.body).toBe("Logged it.");
		// The model was offered the bot's tools, never one that posts or manages.
		const offered = (
			requests.find((request) => request.tools?.length)?.tools as Array<{
				function: { name: string };
			}>
		).map((entry) => entry.function.name);
		expect(offered).toContain("synapse_log");
		expect(offered).toContain("channels_read");
		for (const name of [
			"channels_post",
			"channels_create",
			"channels_set_agent",
		])
			expect(offered).not.toContain(name);
		// The tool ran as the bot: its own Synapse space has today's log line.
		const notes = await ok<SynapseNoteList>(
			"GET",
			`/v1/synapse/spaces/agent-${scribe.id}/notes?text=Answered`,
		);
		expect(notes.notes).toHaveLength(1);
		// Both model calls of the reply are billed.
		expect((await details(scribe.id)).runs[0]).toMatchObject({
			status: "succeeded",
			usage: { totalTokens: 30 },
		});

		// Without tools the model is offered none.
		const second = await post(channel.id, `<@agent:${plain.id}> note this`);
		expect((await next(channel.id, second.seq)).body).toBe("No tools offered.");
	});
});

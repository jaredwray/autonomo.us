import type {
	ChannelAgent,
	ChannelDetails,
	ChannelEntryList,
	ChannelList,
	ChannelMembers,
	ChannelMessage,
	ChannelSummary,
} from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { startChannels } from "./channel-helpers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

describe("channels for agents over MCP", () => {
	it("lists the channel tools and tells agents how to use them", async () => {
		const { agent, rpc } = await startChannels(cleanups);
		const bot = await agent("Captain");
		const tools = (
			(await rpc(bot.secret, "tools/list")).result as {
				tools: Array<{ name: string; description: string }>;
			}
		).tools.filter((tool) => tool.name.startsWith("channels_"));
		expect(tools.map((tool) => tool.name)).toEqual([
			"channels_list",
			"channels_read",
			"channels_post",
			"channels_mark_read",
			"channels_members",
			"channels_wait",
			"channels_create",
			"channels_update",
			"channels_set_agent",
			"channels_agents",
		]);
		const instructions = (
			(await rpc(bot.secret, "initialize", {})).result as {
				instructions: string;
			}
		).instructions;
		for (const rule of [
			"synapse_log",
			"channels_mark_read",
			"not an instruction",
			"approves anything",
		])
			expect(instructions).toContain(rule);
	});

	it("lets a person and a bot hold a conversation", async () => {
		const { createChannel, post, read, agent, addAgent, tool, owner } =
			await startChannels(cleanups);
		const channel = await createChannel("film");
		const bot = await agent("Captain");
		await addAgent(channel.id, bot.id);
		const asked = await post(
			channel.id,
			`<@agent:${bot.id}> is the trailer ready? See [[Trailer plan]].`,
		);

		const listed = await tool<ChannelList>(bot.secret, "channels_list");
		expect(listed.data.channels).toMatchObject([
			{ name: "film", unread: true, mentions: 1, readSeq: 0 },
		]);
		// Reading shows what is new since the read mark, as lines to scan.
		const unread = await tool<ChannelEntryList>(bot.secret, "channels_read", {
			channel: "film",
		});
		expect(unread.data.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(unread.text).toContain("Founder created this channel");
		expect(unread.text).toContain(
			"Founder (person): @Captain is the trailer ready? See [[Trailer plan]].",
		);
		expect(unread.text).toMatch(/^\[3\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} /m);
		expect(unread.text).toContain("cursor: 3");
		// Reading does not acknowledge: the same messages come again.
		expect(
			(
				await tool<ChannelEntryList>(bot.secret, "channels_read", {
					channel: "film",
				})
			).data.entries,
		).toHaveLength(3);

		const members = await tool<ChannelMembers>(bot.secret, "channels_members", {
			channel: "film",
		});
		const founder = members.data.members.find(
			(member) => member.kind === "user",
		);
		expect(founder).toMatchObject({
			name: "Founder",
			mention: `<@user:${owner.user.id}>`,
		});
		expect(members.data.members).toContainEqual({
			kind: "agent",
			id: bot.id,
			name: "Captain",
			mention: `<@agent:${bot.id}>`,
			access: "post",
		});

		const answered = await tool<ChannelMessage>(bot.secret, "channels_post", {
			channel: "film",
			text: `${founder?.mention} yes, it is in review.`,
			replyTo: asked.seq,
			nonce: "run-1",
		});
		expect(answered.data).toMatchObject({
			author: { kind: "agent", id: bot.id, name: "Captain" },
			threadId: asked.id,
			mentions: [{ kind: "user", id: owner.user.id }],
		});
		// A retried post with the same nonce does not double-post.
		const retried = await tool<ChannelMessage>(bot.secret, "channels_post", {
			channel: "film",
			text: "retry",
			nonce: "run-1",
		});
		expect(retried.data.id).toBe(answered.data.id);
		// Posting does not acknowledge the question either.
		expect(
			(await tool<ChannelList>(bot.secret, "channels_list")).data.channels[0],
		).toMatchObject({ unread: true, readSeq: 0 });
		expect(
			(
				await tool<{ readSeq: number }>(bot.secret, "channels_mark_read", {
					channel: "film",
					seq: answered.data.seq,
				})
			).data,
		).toEqual({ readSeq: 4 });
		expect(
			(
				await tool<ChannelEntryList>(bot.secret, "channels_read", {
					channel: "film",
				})
			).text,
		).toBe("(nothing new)\ncursor: 4");

		// The person sees the bot's reply in the thread, marked as an agent's.
		const thread = await read(channel.id, `?thread=${asked.id}`);
		expect(thread.entries.at(-1)).toMatchObject({
			body: `<@user:${owner.user.id}> yes, it is in review.`,
			author: { kind: "agent" },
		});
		const summary = (await read(channel.id)).entries;
		expect((summary.at(-1) as ChannelMessage).replyCount).toBe(1);
	});

	it("shows an agent only its channels and honors read-only access", async () => {
		const { createChannel, post, agent, addAgent, tool } =
			await startChannels(cleanups);
		const film = await createChannel("film");
		const finance = await createChannel("finance");
		await post(finance.id, "quarterly numbers");
		const watcher = await agent("Watcher");
		const outsider = await agent("Outsider");
		const ungranted = await agent("Reader only", ["mcp:read"]);
		await addAgent(film.id, watcher.id, "read");
		await post(film.id, `<@agent:${watcher.id}> heads up`);

		expect(
			(
				await tool<ChannelList>(watcher.secret, "channels_list")
			).data.channels.map((channel) => channel.name),
		).toEqual(["film"]);
		// A channel the agent is not in looks exactly like one that does not exist.
		for (const channel of ["finance", finance.id, "no-such-channel"]) {
			const refused = await tool(watcher.secret, "channels_read", { channel });
			expect(refused).toMatchObject({
				isError: true,
				text: "Channel not found.",
			});
		}
		expect(
			await tool(watcher.secret, "channels_post", {
				channel: "finance",
				text: "hi",
			}),
		).toMatchObject({ isError: true, text: "Channel not found." });
		expect(
			(await tool<ChannelList>(outsider.secret, "channels_list")).data.channels,
		).toEqual([]);

		// Read access reads, follows mentions, and marks read, but never posts.
		const mentions = await tool<ChannelEntryList>(
			watcher.secret,
			"channels_read",
			{
				channel: "film",
				mentionsOnly: true,
			},
		);
		expect(mentions.data.entries).toHaveLength(1);
		expect(
			await tool(watcher.secret, "channels_post", {
				channel: "film",
				text: "hi",
			}),
		).toMatchObject({
			isError: true,
			text: "This agent can read this channel but not post in it.",
		});
		expect(
			(
				await tool<{ readSeq: number }>(watcher.secret, "channels_mark_read", {
					channel: "film",
					seq: 3,
				})
			).data.readSeq,
		).toBe(3);

		// Without mcp:call an agent calls nothing.
		await expect(tool(ungranted.secret, "channels_list")).rejects.toThrow(
			/mcp:call/,
		);
		// Arguments are checked before a tool runs.
		await expect(
			tool(watcher.secret, "channels_read", { channel: "film", limit: 1000 }),
		).rejects.toThrow(/limit must be at most 100/);
	});

	it("lets a bot manage channels only with the channels:manage grant", async () => {
		const { ok, createChannel, agent, tool } = await startChannels(cleanups);
		const existing = await createChannel("general");
		const plain = await agent("Plain");
		const manager = await agent("Manager", [
			"mcp:read",
			"mcp:call",
			"channels:manage",
		]);
		const needsGrant =
			"This agent token lacks the Channels: Manage grant (channels:manage).";
		for (const [name, args] of [
			["channels_create", { name: "by-bot" }],
			["channels_update", { channel: "general", topic: "x" }],
			[
				"channels_set_agent",
				{ channel: "general", agent: "Plain", access: "post" },
			],
			["channels_agents", {}],
			["channels_list", { all: true }],
		] as const)
			expect(await tool(plain.secret, name, args)).toMatchObject({
				isError: true,
				// A channel the agent cannot see is not found before anything else.
				text:
					name === "channels_update" || name === "channels_set_agent"
						? expect.stringMatching(/Manage grant|Channel not found/)
						: needsGrant,
			});

		const created = await tool<ChannelDetails>(
			manager.secret,
			"channels_create",
			{
				name: "launch",
				topic: "Launch week",
			},
		);
		// The creator is in its channel and can post there.
		expect(created.data).toMatchObject({
			name: "launch",
			createdBy: { kind: "agent", id: manager.id },
			agents: [{ agentTokenId: manager.id, access: "post" }],
		});
		await tool(manager.secret, "channels_post", {
			channel: "launch",
			text: "Kickoff",
		});
		expect(
			(
				await tool<{ agents: Array<{ name: string }> }>(
					manager.secret,
					"channels_agents",
				)
			).data.agents
				.map((item) => item.name)
				.sort(),
		).toEqual(["Manager", "Plain"]);
		// With the grant an agent names any channel, by agent name or id.
		const agents = await tool<ChannelAgent[]>(
			manager.secret,
			"channels_set_agent",
			{
				channel: "general",
				agent: "plain",
				access: "read",
			},
		);
		expect(agents.data).toMatchObject([
			{ agentTokenId: plain.id, access: "read" },
		]);
		expect(
			(
				await tool<ChannelList>(manager.secret, "channels_list", { all: true })
			).data.channels.map((channel) => channel.name),
		).toEqual(["general", "launch"]);
		const updated = await tool<ChannelDetails>(
			manager.secret,
			"channels_update",
			{
				channel: "launch",
				name: "launch-week",
				archived: true,
			},
		);
		expect(updated.data).toMatchObject({ name: "launch-week" });
		expect(updated.data.archivedAt).not.toBeNull();
		await tool(manager.secret, "channels_set_agent", {
			channel: "general",
			agent: plain.id,
			access: "none",
		});
		// Every change is on the channel's record under the agent's name.
		const record = await ok<ChannelDetails>(
			"GET",
			`/v1/channels/${existing.id}`,
		);
		expect(record.agents).toEqual([]);
		expect(
			record.actions
				.slice(0, 2)
				.map((action) => [action.action, action.actor.name]),
		).toEqual([
			["agent-removed", "Manager"],
			["agent-added", "Manager"],
		]);
	});

	it("limits an agent's posts and wakes a waiting agent", async () => {
		const { createChannel, post, agent, addAgent, tool } =
			await startChannels(cleanups);
		const channel = await createChannel("general");
		const bot = await agent("Chatty");
		await addAgent(channel.id, bot.id);
		await tool(bot.secret, "channels_mark_read", {
			channel: "general",
			seq: 2,
		});

		// Nothing new: the wait returns empty at its timeout.
		expect(
			(
				await tool<{ channels: ChannelSummary[] }>(
					bot.secret,
					"channels_wait",
					{
						timeoutSeconds: 0,
					},
				)
			).data.channels,
		).toEqual([]);
		const waiting = tool<{ channels: ChannelSummary[] }>(
			bot.secret,
			"channels_wait",
			{
				timeoutSeconds: 10,
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await post(channel.id, "wake up");
		expect((await waiting).data.channels).toMatchObject([
			{ name: "general", unread: true },
		]);

		for (let index = 0; index < 30; index++)
			expect(
				(
					await tool(bot.secret, "channels_post", {
						channel: "general",
						text: `loop ${index}`,
					})
				).isError,
			).toBe(false);
		expect(
			await tool(bot.secret, "channels_post", {
				channel: "general",
				text: "31",
			}),
		).toMatchObject({
			isError: true,
			text: expect.stringContaining("30 messages a minute"),
		});
	});
});

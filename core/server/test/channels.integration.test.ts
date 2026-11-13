import type {
	ChannelDetails,
	ChannelEntryList,
	ChannelList,
	ChannelMessage,
} from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_COLLECTIONS } from "../src/gateway-data.js";
import { startChannels } from "./channel-helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

/** A fresh database that is dropped when the test ends. */
function database() {
	const url = uniqueMongoUrl("chan");
	const client = new MongoClient(url);
	cleanups.push(async () => {
		await client.db().dropDatabase();
		await client.close();
	});
	return { url, client };
}

describe.skipIf(!available)("channels with MongoDB", () => {
	it("keeps one gapless order when two servers post at once", async () => {
		const { url, client } = database();
		const one = await startChannels(cleanups, { mongodbUrl: url });
		const two = await startChannels(cleanups, { mongodbUrl: url });
		const channel = await one.createChannel("general");

		// A third client follows by cursor while both servers post.
		const seen: number[] = [];
		let cursor = 0;
		let posting = true;
		const follow = async () => {
			for (;;) {
				const done = !posting;
				const page = await one.read(channel.id, `?after=${cursor}&limit=100`);
				seen.push(...page.entries.map((entry) => entry.seq));
				cursor = page.cursor;
				if (done && !page.entries.length) return;
			}
		};
		const following = follow();
		// Four people, 50 messages each (a person may post 120 a minute), in
		// eight lanes split across the two servers.
		const authors = [
			one.owner.token,
			...(
				await Promise.all(
					["b", "c", "d"].map((name) => one.join(`${name}@example.com`)),
				)
			).map((session) => session.token),
		];
		const lane = async (api: typeof one, token: string, label: string) => {
			for (let index = 0; index < 25; index++)
				await api.post(channel.id, `${label}-${index}`, { token });
		};
		try {
			await Promise.all(
				authors.flatMap((token, index) => [
					lane(one, token, `one-${index}`),
					lane(two, token, `two-${index}`),
				]),
			);
		} finally {
			posting = false;
		}
		await following;

		// 200 messages after the creation note: every number once, in order,
		// and the follower saw each entry exactly once as it happened.
		const expected = Array.from({ length: 201 }, (_, index) => index + 1);
		expect(seen).toEqual(expected);
		const stored = await client
			.db()
			.collection("channel_messages")
			.find({ channelId: channel.id })
			.sort({ seq: 1 })
			.toArray();
		expect(stored.map((entry) => entry.seq)).toEqual(expected);
		// The channel list agrees with the log on both servers.
		for (const api of [one, two])
			expect(
				(await api.ok<ChannelList>("GET", "/v1/channels")).channels[0],
			).toMatchObject({ unread: true, mentions: 0 });
		expect(
			await client
				.db()
				.collection("channels")
				.findOne({ _id: channel.id as never }),
		).toMatchObject({ lastSeq: 201, lastMessageSeq: 201 });
	}, 60_000);

	it("keeps channels, messages, agents, and read marks inside their workspace", async () => {
		const { url } = database();
		const api = await startChannels(cleanups, { mongodbUrl: url });
		const beta = (
			await api.ok<{ id: string }>(
				"POST",
				"/v1/workspaces",
				{ body: { name: "Beta" } },
				201,
			)
		).id;
		const alpha = api.workspaceId;
		const inBeta = (path: string) => `/v1/${beta}${path}`;
		const general = await api.createChannel("general");
		const hello = await api.post(general.id, "alpha only");
		// The same name is free in another workspace.
		const other = await api.ok<ChannelDetails>(
			"POST",
			inBeta("/channels"),
			{ body: { name: "general" } },
			201,
		);
		expect(other.workspaceId).toBe(beta);
		expect(general.workspaceId).toBe(alpha);

		// Under Beta's path, Alpha's channel and message do not exist, for
		// anyone, the owner included.
		for (const [method, path, body] of [
			["GET", `/channels/${general.id}`, undefined],
			["GET", `/channels/${general.id}/messages`, undefined],
			["GET", `/channels/${general.id}/members`, undefined],
			["POST", `/channels/${general.id}/messages`, { body: "x" }],
			["PATCH", `/channels/${general.id}`, { topic: "x" }],
			["POST", `/channels/${general.id}/archive`, undefined],
			["PUT", `/channels/${general.id}/read`, { seq: 1 }],
			["DELETE", `/channels/${general.id}/messages/${hello.id}`, undefined],
			["DELETE", `/channels/${other.id}/messages/${hello.id}`, undefined],
		] as const)
			expect(
				(await api.refused(method, inBeta(path), { body })).status,
				`${method} ${path}`,
			).toBe(404);
		expect(
			(await api.ok<ChannelList>("GET", inBeta("/channels"))).channels.map(
				(channel) => channel.id,
			),
		).toEqual([other.id]);

		// A member of Alpha only cannot open Beta at all.
		const member = await api.join("member@example.com");
		expect(
			(await api.refused("GET", inBeta("/channels"), { token: member.token }))
				.status,
		).toBe(404);
		// An API token is bound to its workspace.
		const script = await api.apiToken(["channels:edit"]);
		expect(
			(await api.refused("GET", inBeta("/channels"), { token: script })).status,
		).toBe(403);

		// Alpha's agent cannot be added to Beta's channel, and sees none of it.
		const bot = await api.agent("Captain");
		expect(
			(
				await api.refused(
					"PUT",
					inBeta(`/channels/${other.id}/agents/${bot.id}`),
					{
						body: { access: "post" },
					},
				)
			).status,
		).toBe(404);
		await api.addAgent(general.id, bot.id);
		expect(
			(
				await api.tool<ChannelList>(bot.secret, "channels_list")
			).data.channels.map((channel) => channel.id),
		).toEqual([general.id]);
		expect(
			await api.tool(bot.secret, "channels_read", { channel: other.id }),
		).toMatchObject({ isError: true, text: "Channel not found." });
		expect(
			(await api.ok<{ agents: unknown[] }>("GET", inBeta("/channels/agents")))
				.agents,
		).toEqual([]);

		// Archiving the workspace stops people, tokens, and agents alike.
		await api.ok(
			"POST",
			`/v1/workspaces/${alpha}/archive`.replace(alpha, beta),
		);
		expect((await api.refused("GET", inBeta("/channels"))).status).toBe(409);
		const betaBot = await api.server.inject({
			method: "POST",
			url: `/v1/workspaces/${beta}/unarchive`,
			headers: { authorization: `Bearer ${api.owner.token}` },
		});
		expect(betaBot.statusCode).toBe(200);
	});

	it("survives a restart and is removed when the gateway's data is cleared", async () => {
		const { url, client } = database();
		const first = await startChannels(cleanups, { mongodbUrl: url });
		const channel = await first.createChannel("general");
		const bot = await first.agent("Captain");
		await first.addAgent(channel.id, bot.id, "read");
		const message = await first.post(channel.id, "kept", { nonce: "n1" });
		await first.ok("PUT", `/v1/channels/${channel.id}/read`, {
			body: { seq: 1 },
		});
		await first.server.close();

		const second = await startChannels(cleanups, { mongodbUrl: url });
		const listed = (await second.ok<ChannelList>("GET", "/v1/channels"))
			.channels;
		expect(listed).toMatchObject([
			{
				id: channel.id,
				name: "general",
				agents: [{ agentTokenId: bot.id, access: "read" }],
				readSeq: 3,
			},
		]);
		const log = await second.ok<ChannelEntryList>(
			"GET",
			`/v1/channels/${channel.id}/messages?after=0`,
		);
		expect(log.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		// A retry after the restart still finds the first post.
		const retried = await second.call(
			"POST",
			`/v1/channels/${channel.id}/messages`,
			{
				body: { body: "kept", nonce: "n1" },
			},
		);
		expect(retried.status).toBe(200);
		expect(((await retried.json()) as ChannelMessage).id).toBe(message.id);

		// Setup's "delete everything" covers the channel collections.
		for (const name of ["channels", "channel_messages", "channel_reads"]) {
			expect(GATEWAY_COLLECTIONS).toContain(name);
			expect(
				await client.db().collection(name).countDocuments(),
			).toBeGreaterThan(0);
		}
	});
});

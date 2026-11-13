import type {
	ChannelDetails,
	ChannelList,
	ChannelMembers,
	ChannelMessage,
} from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { startChannels } from "./channel-helpers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

const UNKNOWN = "9b0a6d3e-58a1-4d0b-9d5a-0c1e2f3a4b5c";

describe("channels over REST", () => {
	it("creates, lists, renames, and archives channels with a history", async () => {
		const { ok, refused, createChannel, owner } = await startChannels(cleanups);
		const created = await createChannel("general");
		expect(created).toMatchObject({
			name: "general",
			topic: "",
			agents: [],
			archivedAt: null,
			revision: 1,
			unread: false,
			mentions: 0,
			createdBy: { kind: "user", id: owner.user.id },
		});
		expect(created.actions.map((action) => action.action)).toEqual(["created"]);

		// Names are unique in the workspace and follow one pattern.
		expect(
			(await refused("POST", "/v1/channels", { body: { name: "general" } }))
				.status,
		).toBe(409);
		for (const name of ["General", "has space", "", "-lead", "a".repeat(81)])
			expect(
				(await refused("POST", "/v1/channels", { body: { name } })).status,
			).toBe(400);

		const renamed = await ok<ChannelDetails>(
			"PATCH",
			`/v1/channels/${created.id}`,
			{ body: { name: "team", topic: "Daily talk", revision: 1 } },
		);
		expect(renamed).toMatchObject({
			name: "team",
			topic: "Daily talk",
			revision: 2,
		});
		expect(renamed.actions[0]).toMatchObject({
			action: "updated",
			actor: { kind: "user", id: owner.user.id },
		});
		// A stale revision is refused; an unchanged update writes nothing.
		expect(
			(
				await refused("PATCH", `/v1/channels/${created.id}`, {
					body: { topic: "Other", revision: 1 },
				})
			).status,
		).toBe(409);
		expect(
			(
				await ok<ChannelDetails>("PATCH", `/v1/channels/${created.id}`, {
					body: { topic: "Daily talk" },
				})
			).revision,
		).toBe(2);

		await createChannel("leads");
		const names = async (query = "") =>
			(await ok<ChannelList>("GET", `/v1/channels${query}`)).channels.map(
				(channel) => channel.name,
			);
		expect(await names()).toEqual(["leads", "team"]);

		const archived = await ok<ChannelDetails>(
			"POST",
			`/v1/channels/${created.id}/archive`,
		);
		expect(archived.archivedAt).not.toBeNull();
		expect(await names()).toEqual(["leads"]);
		expect(await names("?archived=true")).toEqual(["team"]);
		// An archived channel can be read but not posted to or changed.
		expect(
			(
				await ok<{ entries: unknown[] }>(
					"GET",
					`/v1/channels/${created.id}/messages`,
				)
			).entries.length,
		).toBeGreaterThan(0);
		const post = await refused("POST", `/v1/channels/${created.id}/messages`, {
			body: { body: "hello" },
		});
		expect(post).toEqual({ status: 409, message: "This channel is archived." });
		expect(
			(
				await refused("PATCH", `/v1/channels/${created.id}`, {
					body: { topic: "x" },
				})
			).status,
		).toBe(409);
		await ok("POST", `/v1/channels/${created.id}/unarchive`);
		expect(await names()).toEqual(["leads", "team"]);
	});

	it("keeps one gapless order and lets a reader follow by cursor", async () => {
		const { createChannel, post, read } = await startChannels(cleanups);
		const channel = await createChannel("general");
		// Entry 1 is the note that the channel was created.
		const first = await post(channel.id, "one");
		expect(first).toMatchObject({ seq: 2, body: "one", threadId: null });
		await Promise.all(
			Array.from({ length: 20 }, (_, index) => post(channel.id, `m${index}`)),
		);
		const all = await read(channel.id, "?after=0&limit=100");
		expect(all.entries.map((entry) => entry.seq)).toEqual(
			Array.from({ length: 22 }, (_, index) => index + 1),
		);
		expect(all.cursor).toBe(22);
		expect(all.entries[0]).toMatchObject({
			type: "system",
			text: "created this channel",
		});

		// Nothing new: an empty page and the same cursor.
		expect(await read(channel.id, "?after=22")).toEqual({
			entries: [],
			cursor: 22,
		});
		// A page that hits its limit continues from its last entry.
		const page = await read(channel.id, "?after=0&limit=5");
		expect(page.cursor).toBe(5);
		expect((await read(channel.id, "?after=5&limit=5")).entries[0].seq).toBe(6);

		// History pages back, oldest first within a page.
		const latest = await read(channel.id, "?limit=3");
		expect(latest.entries.map((entry) => entry.seq)).toEqual([20, 21, 22]);
		expect(latest.cursor).toBe(22);
		const older = await read(channel.id, "?before=20&limit=3");
		expect(older.entries.map((entry) => entry.seq)).toEqual([17, 18, 19]);
	});

	it("posts once for a retried nonce and stamps the author from the credential", async () => {
		const { call, createChannel, post, read, apiToken, join } =
			await startChannels(cleanups);
		const channel = await createChannel("general");
		const member = await join("member@example.com");
		const path = `/v1/channels/${channel.id}/messages`;
		const send = (nonce: string, token?: string) =>
			call("POST", path, { token, body: { body: "once", nonce } });
		const first = await send("n1");
		expect(first.status).toBe(201);
		const again = await send("n1");
		expect(again.status).toBe(200);
		expect(((await again.json()) as ChannelMessage).id).toBe(
			((await first.json()) as ChannelMessage).id,
		);
		// A nonce belongs to its author: someone else may use the same value.
		expect((await send("n1", member.token)).status).toBe(201);
		expect(
			(await read(channel.id, "?after=1")).entries.map((entry) => entry.type),
		).toEqual(["message", "message"]);

		// No request field sets the author, the number, or the time.
		const forged = await call("POST", path, {
			body: {
				body: "forged",
				author: { kind: "user", id: "x", name: "Someone else" },
				seq: 99,
			},
		});
		// Unknown fields are dropped, so the message is the caller's own.
		expect(forged.status).toBe(201);
		expect(await forged.json()).toMatchObject({
			seq: 4,
			author: { kind: "user", name: "Founder" },
		});
		const script = await apiToken(["channels:edit"]);
		const scripted = await post(channel.id, "from a script", { token: script });
		expect(scripted.author).toMatchObject({
			kind: "api-token",
			name: "channels:edit",
		});
		expect(
			(await post(channel.id, "hi", { token: member.token })).author,
		).toEqual({
			kind: "user",
			id: member.user.id,
			name: "member",
		});
	});

	it("deletes and edits messages, leaving no copy of removed text", async () => {
		const { ok, refused, createChannel, post, read, join } =
			await startChannels(cleanups);
		const channel = await createChannel("general");
		const member = await join("member@example.com");
		const path = (message: ChannelMessage) =>
			`/v1/channels/${channel.id}/messages/${message.id}`;
		const mine = await post(channel.id, "my seceret", { token: member.token });
		const cursor = mine.seq;

		const edited = await ok<ChannelMessage>("PATCH", path(mine), {
			token: member.token,
			body: { body: "my secret is hunter2" },
		});
		expect(edited).toMatchObject({
			body: "my secret is hunter2",
			seq: mine.seq,
		});
		expect(edited.editedAt).not.toBeNull();
		// Only the author edits; a workspace admin may delete.
		expect(
			(await refused("PATCH", path(mine), { body: { body: "changed" } }))
				.status,
		).toBe(403);
		const other = await join("other@example.com");
		expect(
			(await refused("DELETE", path(mine), { token: other.token })).status,
		).toBe(403);
		await ok("DELETE", path(mine), {}, 204);
		// Deleting again is not an error.
		await ok("DELETE", path(mine), { token: member.token }, 204);
		expect(
			(
				await refused("PATCH", path(mine), {
					token: member.token,
					body: { body: "back" },
				})
			).status,
		).toBe(409);

		// Followers learn of both changes, and each carries the message as it is
		// now: neither the edit nor the delete entry holds the secret.
		const changes = await read(channel.id, `?after=${cursor}`);
		expect(
			changes.entries.map((entry) =>
				entry.type === "change" ? entry.change : entry.type,
			),
		).toEqual(["edited", "deleted"]);
		expect(JSON.stringify(changes)).not.toContain("hunter2");
		expect(JSON.stringify(await read(channel.id, "?after=0"))).not.toContain(
			"hunter2",
		);
		const history = await read(channel.id);
		expect(history.entries.at(-1)).toMatchObject({
			id: mine.id,
			body: "",
			mentions: [],
		});
		expect((history.entries.at(-1) as ChannelMessage).deletedAt).not.toBeNull();
	});

	it("threads replies under their root message", async () => {
		const { createChannel, post, read, refused } =
			await startChannels(cleanups);
		const channel = await createChannel("general");
		const root = await post(channel.id, "Who has the trailer cut?");
		const reply = await post(channel.id, "I do.", { threadId: root.id });
		expect(reply.threadId).toBe(root.id);
		// A reply to a reply joins the same thread.
		const second = await post(channel.id, "Sending it.", {
			threadId: reply.id,
		});
		expect(second.threadId).toBe(root.id);
		await post(channel.id, "Unrelated");

		const thread = await read(channel.id, `?thread=${root.id}`);
		expect(
			thread.entries.map((entry) => (entry as ChannelMessage).body),
		).toEqual(["Who has the trailer cut?", "I do.", "Sending it."]);
		expect((thread.entries[0] as ChannelMessage).replyCount).toBe(2);
		// History shows the conversation without the replies; following shows all.
		expect(
			(await read(channel.id)).entries
				.filter((entry) => entry.type === "message")
				.map((entry) => (entry as ChannelMessage).body),
		).toEqual(["Who has the trailer cut?", "Unrelated"]);
		expect((await read(channel.id, `?after=${root.seq}`)).entries).toHaveLength(
			3,
		);
		expect(
			(
				await refused("POST", `/v1/channels/${channel.id}/messages`, {
					body: { body: "x", threadId: "9b0a6d3e-58a1-4d0b-9d5a-0c1e2f3a4b5c" },
				})
			).status,
		).toBe(404);
	});

	it("tracks what each reader has read, and their mentions", async () => {
		const { ok, refused, createChannel, post, join } =
			await startChannels(cleanups);
		const channel = await createChannel("general");
		const member = await join("member@example.com");
		const summary = async (token?: string) =>
			(await ok<ChannelList>("GET", "/v1/channels", { token })).channels[0];
		expect(await summary(member.token)).toMatchObject({
			unread: false,
			readSeq: 0,
		});

		const hello = await post(channel.id, "hello");
		await post(channel.id, `<@user:${member.user.id}> can you look?`);
		// The author stays caught up; the other reader has two unread, one a mention.
		expect(await summary()).toMatchObject({ unread: false, readSeq: 3 });
		expect(await summary(member.token)).toMatchObject({
			unread: true,
			mentions: 1,
		});

		const mark = (seq: number, token?: string) =>
			ok<{ readSeq: number }>("PUT", `/v1/channels/${channel.id}/read`, {
				token,
				body: { seq },
			});
		expect(await mark(hello.seq, member.token)).toEqual({ readSeq: 2 });
		expect(await summary(member.token)).toMatchObject({
			unread: true,
			mentions: 1,
		});
		// A mark never moves back, and never past the end of the log.
		expect(await mark(1, member.token)).toEqual({ readSeq: 2 });
		expect(await mark(999, member.token)).toEqual({ readSeq: 3 });
		expect(await summary(member.token)).toMatchObject({
			unread: false,
			mentions: 0,
		});

		// An author with older unread messages keeps them unread after posting.
		await post(channel.id, "from the owner");
		await post(channel.id, "and another");
		await post(channel.id, "member replies", { token: member.token });
		expect(await summary(member.token)).toMatchObject({
			unread: true,
			readSeq: 3,
		});

		// Mentions must name someone who can see the channel.
		expect(
			await refused("POST", `/v1/channels/${channel.id}/messages`, {
				body: { body: `<@user:${UNKNOWN}> hi` },
			}),
		).toEqual({
			status: 400,
			message: "This message mentions someone who is not in this workspace.",
		});
		expect(
			(
				await refused("POST", `/v1/channels/${channel.id}/messages`, {
					body: { body: `<@agent:${UNKNOWN}> hi` },
				})
			).status,
		).toBe(400);
	});

	it("applies the limits", async () => {
		const { refused, createChannel, post, apiToken } =
			await startChannels(cleanups);
		const channel = await createChannel("general");
		const path = `/v1/channels/${channel.id}/messages`;
		for (const body of ["", "   ", "x".repeat(16_001)])
			expect((await refused("POST", path, { body: { body } })).status).toBe(
				400,
			);
		await post(channel.id, "x".repeat(16_000));
		expect(
			(
				await refused("PATCH", `/v1/channels/${channel.id}`, {
					body: { topic: "t".repeat(251) },
				})
			).status,
		).toBe(400);

		// The 31st post in a minute from a script is refused; people get more.
		const script = await apiToken(["channels:edit"]);
		for (let index = 0; index < 30; index++)
			await post(channel.id, `s${index}`, { token: script });
		const limited = await refused("POST", path, {
			token: script,
			body: { body: "one too many" },
		});
		expect(limited.status).toBe(429);
		await post(channel.id, "a person can still post");

		// One account creates at most 20 channels an hour.
		for (let index = 0; index < 19; index++) await createChannel(`c${index}`);
		expect(
			(await refused("POST", "/v1/channels", { body: { name: "c20" } })).status,
		).toBe(429);
	});

	it("follows the authorization matrix for people and API tokens", async () => {
		const {
			ok,
			refused,
			call,
			createChannel,
			post,
			apiToken,
			agent,
			join,
			workspaceId,
		} = await startChannels(cleanups);
		const member = await join("member@example.com");
		// Any workspace member creates and manages channels and their agents.
		const channel = await createChannel("general", { token: member.token });
		const bot = await agent("Captain");
		await ok("PUT", `/v1/channels/${channel.id}/agents/${bot.id}`, {
			token: member.token,
			body: { access: "read" },
		});
		expect(
			(
				await ok<{ agents: Array<{ name: string }> }>(
					"GET",
					"/v1/channels/agents",
					{
						token: member.token,
					},
				)
			).agents,
		).toEqual([
			{
				agentTokenId: bot.id,
				name: "Captain",
				status: "active",
				hosted: false,
			},
		]);
		// The token list itself stays with org owners and admins.
		expect(
			(await refused("GET", "/v1/agent-tokens", { token: member.token }))
				.status,
		).toBe(403);
		await ok("PATCH", `/v1/channels/${channel.id}`, {
			token: member.token,
			body: { topic: "Members manage" },
		});

		const reader = await apiToken(["channels:read"]);
		const writer = await apiToken(["channels:edit"]);
		const none = await apiToken(["models:read"]);
		const messages = `/v1/channels/${channel.id}/messages`;
		expect((await call("GET", "/v1/channels", { token: reader })).status).toBe(
			200,
		);
		expect((await call("GET", messages, { token: reader })).status).toBe(200);
		expect((await call("GET", messages, { token: writer })).status).toBe(200);
		expect((await call("GET", "/v1/channels", { token: none })).status).toBe(
			403,
		);
		expect(
			(await refused("POST", messages, { token: reader, body: { body: "x" } }))
				.status,
		).toBe(403);
		const scripted = await post(channel.id, "posted by a script", {
			token: writer,
		});
		// No API token creates or changes a channel or its agents.
		for (const [method, path, body] of [
			["POST", "/v1/channels", { name: "by-token" }],
			["GET", "/v1/channels/agents", undefined],
			["PATCH", `/v1/channels/${channel.id}`, { topic: "x" }],
			["POST", `/v1/channels/${channel.id}/archive`, undefined],
			[
				"PUT",
				`/v1/channels/${channel.id}/agents/${bot.id}`,
				{ access: "post" },
			],
			["DELETE", `/v1/channels/${channel.id}/agents/${bot.id}`, undefined],
		] as const)
			expect(await refused(method, path, { token: writer, body })).toEqual({
				status: 403,
				message: "Sign in to the dashboard for this action.",
			});
		// A token deletes its own message, not someone else's.
		const mine = await post(channel.id, "a person's message", {
			token: member.token,
		});
		expect(
			(await refused("DELETE", `${messages}/${mine.id}`, { token: writer }))
				.status,
		).toBe(403);
		await ok("DELETE", `${messages}/${scripted.id}`, { token: writer }, 204);

		// An agent token never authenticates a REST request.
		expect(
			(await call("GET", "/v1/channels", { token: bot.secret })).status,
		).toBe(401);
		// An unknown channel and a malformed id.
		expect((await refused("GET", `/v1/channels/${UNKNOWN}`)).status).toBe(404);
		expect((await call("GET", "/v1/channels/not-a-uuid")).status).toBe(400);
		expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("records agent changes on the channel in the same write", async () => {
		const { ok, refused, createChannel, agent, addAgent, read } =
			await startChannels(cleanups);
		const channel = await createChannel("general");
		const captain = await agent("Captain");
		const added = await addAgent(channel.id, captain.id, "read");
		expect(added.agents).toMatchObject([
			{
				agentTokenId: captain.id,
				name: "Captain",
				access: "read",
				addedBy: "Founder",
			},
		]);
		expect(added.revision).toBe(2);
		// The same access again writes nothing.
		expect((await addAgent(channel.id, captain.id, "read")).revision).toBe(2);
		const changed = await addAgent(channel.id, captain.id, "post");
		expect(changed.agents[0].access).toBe("post");
		const removed = await ok<ChannelDetails>(
			"DELETE",
			`/v1/channels/${channel.id}/agents/${captain.id}`,
		);
		expect(removed.agents).toEqual([]);
		expect(removed.actions.map((action) => action.action)).toEqual([
			"agent-removed",
			"agent-changed",
			"agent-added",
			"created",
		]);
		expect(removed.actions[2].detail).toBe("Added Captain with read access.");
		// Only this workspace's agents can be added.
		expect(
			(
				await refused("PUT", `/v1/channels/${channel.id}/agents/${UNKNOWN}`, {
					body: { access: "post" },
				})
			).status,
		).toBe(404);
		// The log carries a readable note of each change.
		expect(
			(await read(channel.id, "?after=0")).entries.map((entry) =>
				entry.type === "system" ? entry.text : "",
			),
		).toEqual([
			"created this channel",
			"added Captain",
			"changed Captain's access to post",
			"removed Captain",
		]);
		const members = await ok<ChannelMembers>(
			"GET",
			`/v1/channels/${channel.id}/members`,
		);
		expect(members.members).toEqual([
			expect.objectContaining({ kind: "user", name: "Founder" }),
		]);
	});

	it("answers a long poll as soon as a message arrives", async () => {
		const { createChannel, post, read } = await startChannels(cleanups);
		const channel = await createChannel("general");
		const started = Date.now();
		const waiting = read(channel.id, "?after=1&wait=10");
		await new Promise((resolve) => setTimeout(resolve, 150));
		await post(channel.id, "here");
		const result = await waiting;
		expect(result.entries.map((entry) => entry.seq)).toEqual([2]);
		expect(Date.now() - started).toBeLessThan(4000);
		// With nothing new it returns empty at the timeout.
		const empty = await read(channel.id, "?after=2&wait=1");
		expect(empty).toEqual({ entries: [], cursor: 2 });
	});
});

import { randomUUID } from "node:crypto";
import type { ChannelActor } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryChannelRepository } from "../src/channels/memory-repository.js";
import { MongoChannelRepository } from "../src/channels/mongo-repository.js";
import type {
	ChannelRepository,
	StoredChange,
	StoredChannel,
	StoredMessage,
	StoredSystemEntry,
} from "../src/channels/repository.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
if (!available)
	console.warn("[channels-repository] no MongoDB — skipping the MongoDB half.");
const mongoUrl = uniqueMongoUrl("chanrepo");
const cleanup = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 1500 });
afterAll(async () => {
	if (available) await cleanup.db().dropDatabase();
	await cleanup.close();
});

const actor: ChannelActor = { kind: "user", id: "u1", name: "U" };
const at = "2026-11-13T10:00:00.000Z";

function channel(
	workspaceId: string,
	name: string,
	extra: Partial<StoredChannel> = {},
): StoredChannel {
	return {
		id: randomUUID(),
		workspaceId,
		name,
		nameKey: name,
		topic: "",
		description: "",
		agents: [],
		createdAt: at,
		createdBy: actor,
		createdByKey: "user:u1",
		updatedAt: at,
		archivedAt: null,
		revision: 1,
		lastSeq: 0,
		lastMessageSeq: 0,
		lastMessageAt: null,
		actions: [],
		...extra,
	};
}
function message(
	target: StoredChannel,
	seq: number,
	extra: Partial<StoredMessage> = {},
): StoredMessage {
	return {
		id: randomUUID(),
		workspaceId: target.workspaceId,
		channelId: target.id,
		seq,
		type: "message",
		createdAt: at,
		author: actor,
		authorKey: "user:u1",
		body: `m${seq}`,
		mentions: [],
		mentionKeys: [],
		threadId: null,
		replyCount: 0,
		editedAt: null,
		deletedAt: null,
		revision: 1,
		...extra,
	};
}

const implementations: Array<[string, () => ChannelRepository]> = [
	["memory", () => new MemoryChannelRepository()],
	...(available
		? ([["mongodb", () => new MongoChannelRepository(mongoUrl)]] as Array<
				[string, () => ChannelRepository]
			>)
		: []),
];

describe.each(implementations)("channel repository (%s)", (_name, create) => {
	const repository = create();
	afterAll(() => repository.close());
	// Each test works in its own workspace, so the suites share one database.
	const workspace = () => randomUUID();

	it("keeps channel names unique per workspace and scopes lookups", async () => {
		const [a, b] = [workspace(), workspace()];
		const general = channel(a, "general");
		expect(await repository.insertChannel(general)).toBe(true);
		expect(await repository.insertChannel(channel(a, "general"))).toBe(false);
		expect(await repository.insertChannel(channel(b, "general"))).toBe(true);

		expect((await repository.getChannel(a, general.id))?.name).toBe("general");
		// Another workspace's id never resolves.
		expect(await repository.getChannel(b, general.id)).toBeNull();
		expect((await repository.getChannelByName(a, "general"))?.id).toBe(
			general.id,
		);
		expect(await repository.getChannelByName(a, "missing")).toBeNull();
	});

	it("lists by name, by archive state, and by agent", async () => {
		const ws = workspace();
		const agent = {
			agentTokenId: "agent-1",
			name: "Captain",
			access: "post" as const,
			addedAt: at,
			addedBy: "U",
		};
		await repository.insertChannel(channel(ws, "zeta", { agents: [agent] }));
		await repository.insertChannel(channel(ws, "alpha"));
		await repository.insertChannel(
			channel(ws, "old", { archivedAt: at, createdByKey: "agent:x" }),
		);
		const names = async (
			filter?: Parameters<ChannelRepository["listChannels"]>[1],
		) => (await repository.listChannels(ws, filter)).map((item) => item.name);
		expect(await names()).toEqual(["alpha", "old", "zeta"]);
		expect(await names({ archived: false })).toEqual(["alpha", "zeta"]);
		expect(await names({ archived: true })).toEqual(["old"]);
		expect(await names({ agentTokenId: "agent-1" })).toEqual(["zeta"]);
		expect(await names({ agentTokenId: "agent-2" })).toEqual([]);
		expect(await repository.countOpenChannels(ws)).toBe(2);
		expect(
			await repository.countChannelsCreatedBy(
				ws,
				"user:u1",
				"2026-11-13T09:00:00.000Z",
			),
		).toBe(2);
		expect(
			await repository.countChannelsCreatedBy(
				ws,
				"user:u1",
				"2026-11-13T11:00:00.000Z",
			),
		).toBe(0);
	});

	it("replaces a channel only at the expected revision, keeping the log summary", async () => {
		const ws = workspace();
		const general = channel(ws, "general");
		await repository.insertChannel(general);
		await repository.insertChannel(channel(ws, "taken"));
		await repository.touchChannel(ws, general.id, {
			lastSeq: 4,
			lastMessageSeq: 3,
			lastMessageAt: at,
		});
		// The summary only moves forward.
		await repository.touchChannel(ws, general.id, {
			lastSeq: 2,
			lastMessageSeq: 1,
		});

		const changed = { ...general, topic: "New", revision: 2 };
		expect(await repository.replaceChannel(changed, 1)).toBe("ok");
		expect(
			await repository.replaceChannel({ ...changed, revision: 3 }, 1),
		).toBe("conflict");
		expect(
			await repository.replaceChannel(
				{ ...changed, name: "taken", nameKey: "taken", revision: 3 },
				2,
			),
		).toBe("name-taken");
		// A replace written from a stale read does not undo the summary.
		expect(await repository.getChannel(ws, general.id)).toMatchObject({
			topic: "New",
			revision: 2,
			lastSeq: 4,
			lastMessageSeq: 3,
			lastMessageAt: at,
		});
	});

	it("lets one writer have each number and one message per nonce", async () => {
		const target = channel(workspace(), "general");
		await repository.insertChannel(target);
		expect(await repository.topSeq(target.id)).toBe(0);
		expect(
			await repository.insertEntry(message(target, 1, { nonce: "n" })),
		).toBe("ok");
		expect(await repository.insertEntry(message(target, 1))).toBe("seq-taken");
		expect(
			await repository.insertEntry(message(target, 2, { nonce: "n" })),
		).toBe("nonce-taken");
		// The same nonce from another author is another message.
		expect(
			await repository.insertEntry(
				message(target, 2, { nonce: "n", authorKey: "agent:a" }),
			),
		).toBe("ok");
		expect(await repository.topSeq(target.id)).toBe(2);
		expect((await repository.findByNonce(target.id, "user:u1", "n"))?.seq).toBe(
			1,
		);
		expect(
			await repository.findByNonce(target.id, "user:u1", "other"),
		).toBeNull();
	});

	it("reads the log forwards, backwards, and by thread", async () => {
		const target = channel(workspace(), "general");
		await repository.insertChannel(target);
		const root = message(target, 1);
		const note: StoredSystemEntry = {
			id: randomUUID(),
			workspaceId: target.workspaceId,
			channelId: target.id,
			seq: 2,
			type: "system",
			createdAt: at,
			author: actor,
			authorKey: "user:u1",
			text: "added Captain",
		};
		const reply = message(target, 3, {
			threadId: root.id,
			mentionKeys: ["agent:a"],
			mentions: [{ kind: "agent", id: "a" }],
		});
		const change: StoredChange = {
			id: randomUUID(),
			workspaceId: target.workspaceId,
			channelId: target.id,
			seq: 4,
			type: "change",
			createdAt: at,
			author: actor,
			authorKey: "user:u1",
			change: "edited",
			targetId: root.id,
		};
		const last = message(target, 5, { createdAt: "2026-11-13T12:00:00.000Z" });
		for (const entry of [root, note, reply, change, last])
			expect(await repository.insertEntry(entry)).toBe("ok");

		const seqs = (entries: Array<{ seq: number }>) =>
			entries.map((entry) => entry.seq);
		expect(seqs(await repository.entriesAfter(target.id, 0, 10))).toEqual([
			1, 2, 3, 4, 5,
		]);
		expect(seqs(await repository.entriesAfter(target.id, 2, 2))).toEqual([
			3, 4,
		]);
		expect(
			seqs(
				await repository.entriesAfter(target.id, 0, 10, {
					mentionKey: "agent:a",
				}),
			),
		).toEqual([3]);
		// History: messages outside threads and notes, newest first.
		expect(
			seqs(await repository.entriesBefore(target.id, undefined, 10)),
		).toEqual([5, 2, 1]);
		expect(seqs(await repository.entriesBefore(target.id, 5, 1))).toEqual([2]);
		expect(
			seqs(await repository.threadReplies(target.id, root.id, 10)),
		).toEqual([3]);

		expect(
			(await repository.getEntry(target.workspaceId, target.id, reply.id))?.seq,
		).toBe(3);
		expect(await repository.getEntry("other", target.id, reply.id)).toBeNull();
		expect(
			seqs(
				await repository.getEntries(target.id, [root.id, last.id, "missing"]),
			),
		).toEqual(expect.arrayContaining([1, 5]));
		expect(
			await repository.countAuthorEntries(
				target.id,
				"user:u1",
				"2026-11-13T11:00:00.000Z",
			),
		).toBe(1);
		expect(await repository.countMentions(target.id, "agent:a", 0)).toBe(1);
		expect(await repository.countMentions(target.id, "agent:a", 3)).toBe(0);
	});

	it("rewrites a message only at its revision and counts replies apart", async () => {
		const target = channel(workspace(), "general");
		await repository.insertChannel(target);
		const original = message(target, 1, { nonce: "keep" });
		await repository.insertEntry(original);
		await repository.addReply(target.id, original.id);
		const edited = { ...original, body: "edited", editedAt: at, revision: 2 };
		expect(await repository.replaceMessage(edited, 1)).toBe(true);
		expect(
			await repository.replaceMessage({ ...edited, body: "late" }, 1),
		).toBe(false);
		const stored = await repository.getEntry(
			target.workspaceId,
			target.id,
			original.id,
		);
		// The edit kept its place in the log, its nonce, and the reply count.
		expect(stored).toMatchObject({
			seq: 1,
			body: "edited",
			revision: 2,
			replyCount: 1,
			nonce: "keep",
		});
	});

	it("moves read marks forward only", async () => {
		const ws = workspace();
		const [one, two] = [randomUUID(), randomUUID()];
		expect(await repository.readMark(one, "user:u1")).toBe(0);
		expect(await repository.raiseReadMark(ws, one, "user:u1", 5, at)).toBe(5);
		expect(await repository.raiseReadMark(ws, one, "user:u1", 3, at)).toBe(5);
		expect(await repository.raiseReadMark(ws, two, "user:u1", 1, at)).toBe(1);
		await repository.raiseReadMark(ws, one, "agent:a", 2, at);
		expect(await repository.readMark(one, "user:u1")).toBe(5);
		expect(await repository.readMarks(ws, "user:u1")).toEqual(
			new Map([
				[one, 5],
				[two, 1],
			]),
		);
		expect(await repository.readMarks("other", "user:u1")).toEqual(new Map());
	});
});

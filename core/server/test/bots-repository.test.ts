import { randomUUID } from "node:crypto";
import type { Bot } from "@autonomo.us/common";
import { DEFAULT_BOT_LIMITS } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
	type BotRepository,
	MemoryBotRepository,
	MongoBotRepository,
	type RunResult,
	runId,
	type StoredRun,
} from "../src/bots/repository.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
if (!available)
	console.warn("[bots-repository] no MongoDB — skipping the MongoDB half.");
const mongoUrl = uniqueMongoUrl("botrepo");
const cleanup = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 1500 });
afterAll(async () => {
	if (available) await cleanup.db().dropDatabase();
	await cleanup.close();
});

const T0 = "2026-11-13T10:00:00.000Z";
const T1 = "2026-11-13T10:01:00.000Z";
const T2 = "2026-11-13T10:02:00.000Z";
const T3 = "2026-11-13T10:03:00.000Z";

function bot(workspaceId: string, name: string): Bot {
	return {
		id: randomUUID(),
		workspaceId,
		name,
		instructions: "",
		model: "stub/chat-model",
		enabled: true,
		agentHops: 0,
		tools: false,
		limits: DEFAULT_BOT_LIMITS,
		createdAt: T0,
		createdBy: "U",
		updatedAt: T0,
		revision: 1,
	};
}
function run(
	owner: Bot,
	seq: number,
	extra: Partial<StoredRun> = {},
): StoredRun {
	const channelId = extra.channelId ?? "channel-1";
	return {
		id: runId(owner.id, channelId, seq),
		botId: owner.id,
		workspaceId: owner.workspaceId,
		channelId,
		triggerSeq: seq,
		triggerMessageId: randomUUID(),
		depth: 0,
		status: "pending",
		attempts: 0,
		createdAt: T0,
		startedAt: null,
		finishedAt: null,
		detail: null,
		model: null,
		usage: null,
		replyMessageId: null,
		leaseId: null,
		leaseUntil: null,
		...extra,
	};
}
const done = (extra: Partial<RunResult> = {}): RunResult => ({
	status: "succeeded",
	detail: null,
	model: "stub/chat-model",
	usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
	replyMessageId: randomUUID(),
	finishedAt: T1,
	...extra,
});

const implementations: Array<[string, () => BotRepository]> = [
	["memory", () => new MemoryBotRepository()],
	...(available
		? ([["mongodb", () => new MongoBotRepository(mongoUrl)]] as Array<
				[string, () => BotRepository]
			>)
		: []),
];

describe.each(implementations)("bot repository (%s)", (_name, create) => {
	const repository = create();
	afterAll(() => repository.close());

	it("keeps bots inside their workspace and replaces at a revision", async () => {
		const [a, b] = [randomUUID(), randomUUID()];
		const zed = bot(a, "Zed");
		const amy = bot(a, "Amy");
		await repository.insertBot(zed);
		await repository.insertBot(amy);
		await repository.insertBot(bot(b, "Other"));
		expect((await repository.listBots(a)).map((item) => item.name)).toEqual([
			"Amy",
			"Zed",
		]);
		expect(await repository.getBot(b, zed.id)).toBeNull();
		expect(
			await repository.replaceBot({ ...zed, enabled: false, revision: 2 }, 1),
		).toBe(true);
		expect(await repository.replaceBot({ ...zed, name: "Late" }, 1)).toBe(
			false,
		);
		expect(await repository.getBot(a, zed.id)).toMatchObject({
			name: "Zed",
			enabled: false,
			revision: 2,
		});
		expect(await repository.deleteBot(b, zed.id)).toBe(false);
		expect(await repository.deleteBot(a, zed.id)).toBe(true);
		expect(await repository.getBot(a, zed.id)).toBeNull();
	});

	it("writes one run per bot, channel, and message", async () => {
		const owner = bot(randomUUID(), "Helper");
		expect(await repository.insertRun(run(owner, 5))).toBe(true);
		expect(await repository.insertRun(run(owner, 5))).toBe(false);
		expect(await repository.insertRun(run(owner, 6))).toBe(true);
		expect(
			await repository.insertRun(run(owner, 5, { channelId: "channel-2" })),
		).toBe(true);
	});

	it("gives a run to one runner at a time, and again only after its lease", async () => {
		const owner = bot(randomUUID(), "Helper");
		const pending = run(owner, 1);
		await repository.insertRun(pending);
		const first = await repository.claimRun(
			pending.id,
			{ id: "lease-1", until: T2 },
			T1,
			2,
		);
		expect(first).toMatchObject({
			status: "running",
			attempts: 1,
			startedAt: T1,
			leaseId: "lease-1",
		});
		// While the lease is live nobody else may start it.
		expect(
			await repository.claimRun(
				pending.id,
				{ id: "lease-2", until: T3 },
				T1,
				2,
			),
		).toBeNull();
		// After it expires, a second runner takes over.
		const second = await repository.claimRun(
			pending.id,
			{ id: "lease-2", until: T3 },
			T2,
			2,
		);
		expect(second).toMatchObject({ attempts: 2, leaseId: "lease-2" });
		// The first runner lost its lease: its result is refused.
		expect(await repository.finishRun(pending.id, "lease-1", done())).toBe(
			false,
		);
		expect(await repository.finishRun(pending.id, "lease-2", done())).toBe(
			true,
		);
		// A runner that stops early hands its run back at once.
		const handed = run(owner, 7);
		await repository.insertRun(handed);
		await repository.claimRun(handed.id, { id: "lease-5", until: T3 }, T1, 2);
		expect(await repository.releaseRun(handed.id, "other", T1)).toBe(false);
		expect(await repository.releaseRun(handed.id, "lease-5", T1)).toBe(true);
		expect(
			await repository.claimRun(handed.id, { id: "lease-6", until: T3 }, T1, 2),
		).toMatchObject({ attempts: 2, leaseId: "lease-6" });
		// A finished run is never started again, and neither is one out of attempts.
		expect(
			await repository.claimRun(
				pending.id,
				{ id: "lease-3", until: T3 },
				T3,
				9,
			),
		).toBeNull();
		const spent = run(owner, 2, { attempts: 2 });
		await repository.insertRun(spent);
		expect(
			await repository.claimRun(spent.id, { id: "lease-4", until: T3 }, T1, 2),
		).toBeNull();
	});

	it("finds stale and active runs and adds up what a bot used", async () => {
		const owner = bot(randomUUID(), "Helper");
		const waiting = run(owner, 1);
		const fresh = run(owner, 2, { createdAt: T2 });
		const crashed = run(owner, 3, {
			status: "running",
			attempts: 1,
			leaseId: "old",
			leaseUntil: T1,
		});
		const working = run(owner, 4, {
			status: "running",
			attempts: 1,
			leaseId: "live",
			leaseUntil: T3,
		});
		const skipped = run(owner, 5, { status: "skipped", finishedAt: T1 });
		const finished = run(owner, 6, {
			status: "succeeded",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			createdAt: T1,
		});
		for (const item of [waiting, fresh, crashed, working, skipped, finished])
			await repository.insertRun(item);

		// At T2: the old pending run and the expired lease are stale.
		const stale = (await repository.staleRuns(T2, T1, 50))
			.filter((item) => item.botId === owner.id)
			.map((item) => item.triggerSeq)
			.sort();
		expect(stale).toEqual([1, 3]);
		const active = (
			await repository.activeRuns(owner.workspaceId, "channel-1", T2)
		)
			.map((item) => item.triggerSeq)
			.sort();
		// Pending runs and the one under a live lease are in progress.
		expect(active).toEqual([1, 2, 4]);
		expect(await repository.activeRuns("other", "channel-1", T2)).toEqual([]);

		expect(await repository.countRunsSince(owner.id, T0)).toBe(5);
		expect(await repository.countRunsSince(owner.id, T1)).toBe(2);
		expect(await repository.tokensSince(owner.id, T0)).toBe(15);
		expect(await repository.tokensSince(owner.id, T2)).toBe(0);
		const listed = await repository.listRuns(owner.workspaceId, owner.id, 2);
		expect(listed.map((item) => item.triggerSeq)).toEqual([2, 6]);
		// The lease never leaves the repository.
		expect(listed[0]).not.toHaveProperty("leaseId");
	});
});

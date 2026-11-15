import {
	type Bot,
	type BotRun,
	type BotRunStatus,
	DEFAULT_BOT_LIMITS,
	type TokenUsage,
} from "@autonomo.us/common";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import { BotError, botsUnavailable } from "./errors.js";

export const BOTS_COLLECTION = "gateway_bots";
export const BOT_RUNS_COLLECTION = "channel_bot_runs";

/** A run plus the lease of the runner working on it. */
export type StoredRun = BotRun & {
	leaseId: string | null;
	/** While this is in the future, nobody else may start the run. */
	leaseUntil: string | null;
};
export type RunLease = { id: string; until: string };
export type RunResult = Pick<
	BotRun,
	"status" | "detail" | "model" | "usage" | "replyMessageId" | "finishedAt"
>;

/** One run per bot, channel, and triggering message. */
export const runId = (botId: string, channelId: string, triggerSeq: number) =>
	`${botId}:${channelId}:${triggerSeq}`;

/**
 * Storage for bots and their runs. The memory and MongoDB implementations
 * satisfy one contract (test/bots-repository.test.ts).
 */
export interface BotRepository {
	readonly persistence: "mongodb" | "memory";
	insertBot(bot: Bot): Promise<void>;
	getBot(workspaceId: string, id: string): Promise<Bot | null>;
	/** By name. */
	listBots(workspaceId: string): Promise<Bot[]>;
	replaceBot(bot: Bot, expectedRevision: number): Promise<boolean>;
	deleteBot(workspaceId: string, id: string): Promise<boolean>;

	/** False when this bot already has a run for that message. */
	insertRun(run: StoredRun): Promise<boolean>;
	/**
	 * Takes a run that is pending, or running under a lease that has expired,
	 * and has been started fewer than `maxAttempts` times.
	 */
	claimRun(
		id: string,
		lease: RunLease,
		now: string,
		maxAttempts: number,
	): Promise<StoredRun | null>;
	/** Records the outcome, only for the runner that still holds the lease. */
	finishRun(id: string, leaseId: string, result: RunResult): Promise<boolean>;
	/**
	 * Ends a lease early without an outcome: the runner has stopped working
	 * and another may take the run at once.
	 */
	releaseRun(id: string, leaseId: string, now: string): Promise<boolean>;
	/** Runs nobody is working on: pending since before `pendingBefore`, or with an expired lease. */
	staleRuns(
		now: string,
		pendingBefore: string,
		limit: number,
	): Promise<StoredRun[]>;
	/** Newest first. */
	listRuns(
		workspaceId: string,
		botId: string,
		limit: number,
	): Promise<BotRun[]>;
	/**
	 * Runs in a channel, or in every channel for null, that someone is
	 * working on: running under a live lease, or pending since
	 * `pendingAfter`. An older pending run was never started and is not in
	 * progress.
	 */
	activeRuns(
		workspaceId: string,
		channelId: string | null,
		now: string,
		pendingAfter: string,
	): Promise<BotRun[]>;
	/** The workspace's runs created in [from, to), counted by bot and status. */
	countRunsByStatus(
		workspaceId: string,
		from: string,
		to: string,
	): Promise<Array<{ botId: string; status: BotRunStatus; count: number }>>;
	/** The workspace's latest runs created in [from, to) that ended this way, newest first. */
	recentRuns(
		workspaceId: string,
		status: BotRunStatus,
		limit: number,
		window: { from: string; to: string },
	): Promise<BotRun[]>;
	/**
	 * Every bot's replies started since `hourAgo` (skipped runs do not count)
	 * and tokens since `dayStart`, in one read: what `countRunsSince` and
	 * `tokensSince` answer one bot at a time.
	 */
	usageSince(
		workspaceId: string,
		hourAgo: string,
		dayStart: string,
	): Promise<Map<string, { replies: number; tokens: number }>>;
	/** How many of the bot's runs hold a live lease right now. */
	countRunning(botId: string, now: string): Promise<number>;
	/** Replies the bot started since `since`; skipped runs do not count. */
	countRunsSince(botId: string, since: string): Promise<number>;
	tokensSince(botId: string, since: string): Promise<number>;
	close(): Promise<void>;
}

const byName = (a: Bot, b: Bot) => a.name.localeCompare(b.name);
const publicRun = ({ leaseId: _id, leaseUntil: _until, ...run }: StoredRun) =>
	run as BotRun;
const total = (usage: TokenUsage | null) => usage?.totalTokens ?? 0;
/** Whether a runner may take this run now. */
const claimable = (run: StoredRun, now: string, maxAttempts: number) =>
	run.attempts < maxAttempts &&
	(run.status === "pending" ||
		(run.status === "running" && (run.leaseUntil ?? "") <= now));

/** Bots kept in process memory, until restart. */
export class MemoryBotRepository implements BotRepository {
	readonly persistence = "memory" as const;
	private readonly bots = new Map<string, Bot>();
	private readonly runs = new Map<string, StoredRun>();

	async insertBot(bot: Bot) {
		this.bots.set(bot.id, structuredClone(bot));
	}
	async getBot(workspaceId: string, id: string) {
		const bot = this.bots.get(id);
		return bot?.workspaceId === workspaceId ? structuredClone(bot) : null;
	}
	async listBots(workspaceId: string) {
		return [...this.bots.values()]
			.filter((bot) => bot.workspaceId === workspaceId)
			.sort(byName)
			.map((bot) => structuredClone(bot));
	}
	async replaceBot(bot: Bot, expectedRevision: number) {
		const current = this.bots.get(bot.id);
		if (
			current?.workspaceId !== bot.workspaceId ||
			current.revision !== expectedRevision
		)
			return false;
		this.bots.set(bot.id, structuredClone(bot));
		return true;
	}
	async deleteBot(workspaceId: string, id: string) {
		if (this.bots.get(id)?.workspaceId !== workspaceId) return false;
		return this.bots.delete(id);
	}

	async insertRun(run: StoredRun) {
		if (this.runs.has(run.id)) return false;
		this.runs.set(run.id, structuredClone(run));
		return true;
	}
	async claimRun(
		id: string,
		lease: RunLease,
		now: string,
		maxAttempts: number,
	) {
		const run = this.runs.get(id);
		if (!run || !claimable(run, now, maxAttempts)) return null;
		Object.assign(run, {
			status: "running",
			attempts: run.attempts + 1,
			startedAt: now,
			leaseId: lease.id,
			leaseUntil: lease.until,
		});
		return structuredClone(run);
	}
	async finishRun(id: string, leaseId: string, result: RunResult) {
		const run = this.runs.get(id);
		if (run?.status !== "running" || run.leaseId !== leaseId) return false;
		Object.assign(run, result, { leaseId: null, leaseUntil: null });
		return true;
	}
	async releaseRun(id: string, leaseId: string, now: string) {
		const run = this.runs.get(id);
		if (run?.status !== "running" || run.leaseId !== leaseId) return false;
		run.leaseUntil = now;
		return true;
	}
	async staleRuns(now: string, pendingBefore: string, limit: number) {
		return [...this.runs.values()]
			.filter(
				(run) =>
					(run.status === "pending" && run.createdAt <= pendingBefore) ||
					(run.status === "running" && (run.leaseUntil ?? "") <= now),
			)
			.slice(0, limit)
			.map((run) => structuredClone(run));
	}
	async listRuns(workspaceId: string, botId: string, limit: number) {
		return [...this.runs.values()]
			.filter((run) => run.workspaceId === workspaceId && run.botId === botId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit)
			.map(publicRun);
	}
	async activeRuns(
		workspaceId: string,
		channelId: string,
		now: string,
		pendingAfter: string,
	) {
		return [...this.runs.values()]
			.filter(
				(run) =>
					run.workspaceId === workspaceId &&
					(channelId === null || run.channelId === channelId) &&
					((run.status === "pending" && run.createdAt > pendingAfter) ||
						(run.status === "running" && (run.leaseUntil ?? "") > now)),
			)
			.map(publicRun);
	}
	async countRunsByStatus(workspaceId: string, from: string, to: string) {
		const counts = new Map<
			string,
			{ botId: string; status: BotRunStatus; count: number }
		>();
		for (const run of this.runs.values()) {
			if (
				run.workspaceId !== workspaceId ||
				run.createdAt < from ||
				run.createdAt >= to
			)
				continue;
			const key = `${run.botId}\n${run.status}`;
			const row = counts.get(key) ?? {
				botId: run.botId,
				status: run.status,
				count: 0,
			};
			row.count += 1;
			counts.set(key, row);
		}
		return [...counts.values()];
	}
	async recentRuns(
		workspaceId: string,
		status: BotRunStatus,
		limit: number,
		window: { from: string; to: string },
	) {
		return [...this.runs.values()]
			.filter(
				(run) =>
					run.workspaceId === workspaceId &&
					run.status === status &&
					run.createdAt >= window.from &&
					run.createdAt < window.to,
			)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit)
			.map(publicRun);
	}
	async usageSince(workspaceId: string, hourAgo: string, dayStart: string) {
		const usage = new Map<string, { replies: number; tokens: number }>();
		for (const run of this.runs.values()) {
			if (run.workspaceId !== workspaceId) continue;
			const row = usage.get(run.botId) ?? { replies: 0, tokens: 0 };
			if (run.createdAt >= hourAgo && run.status !== "skipped")
				row.replies += 1;
			if (run.createdAt >= dayStart) row.tokens += total(run.usage);
			usage.set(run.botId, row);
		}
		return usage;
	}
	async countRunning(botId: string, now: string) {
		return [...this.runs.values()].filter(
			(run) =>
				run.botId === botId &&
				run.status === "running" &&
				(run.leaseUntil ?? "") > now,
		).length;
	}
	async countRunsSince(botId: string, since: string) {
		return [...this.runs.values()].filter(
			(run) =>
				run.botId === botId &&
				run.createdAt >= since &&
				run.status !== "skipped",
		).length;
	}
	async tokensSince(botId: string, since: string) {
		return [...this.runs.values()]
			.filter((run) => run.botId === botId && run.createdAt >= since)
			.reduce((sum, run) => sum + total(run.usage), 0);
	}
	async close() {}
}

type BotDocument = Omit<Bot, "id"> & { _id: string };
type RunDocument = Omit<StoredRun, "id"> & { _id: string };
/** Bots saved before web access have no `web` switch or proxy limit. */
const toBot = ({ _id, ...rest }: BotDocument): Bot => ({
	id: _id,
	...rest,
	web: rest.web === true,
	webScope: rest.webScope ?? "mentioned",
	webFollowUps: rest.webFollowUps ?? "same-site",
	webHosts: rest.webHosts ?? [],
	limits: {
		...rest.limits,
		proxyRequestsPerDay:
			rest.limits?.proxyRequestsPerDay ??
			DEFAULT_BOT_LIMITS.proxyRequestsPerDay,
	},
});
const toRun = ({ _id, ...rest }: RunDocument): StoredRun => ({
	id: _id,
	...rest,
});

/** Bots and runs in MongoDB, on the shared control-plane connection. */
export class MongoBotRepository implements BotRepository {
	readonly persistence = "mongodb" as const;
	private readonly mongo: MongoConnection;
	private indexed?: Promise<void>;
	constructor(mongo: string | MongoConnection) {
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}
	private bots() {
		return this.mongo.collection<BotDocument>(BOTS_COLLECTION);
	}
	private runs() {
		return this.mongo.collection<RunDocument>(BOT_RUNS_COLLECTION);
	}
	private ensureIndexes(): Promise<void> {
		this.indexed ??= (async () => {
			await this.bots().createIndex(
				{ workspaceId: 1, name: 1 },
				{ name: "workspace_name" },
			);
			await this.runs().createIndexes([
				{ key: { botId: 1, createdAt: -1 }, name: "bot_created" },
				{
					key: { workspaceId: 1, channelId: 1, status: 1 },
					name: "channel_status",
				},
				{ key: { status: 1, leaseUntil: 1 }, name: "status_lease" },
				// The overview: a workspace's runs in a window and its bots' usage,
				// and its latest failures.
				{
					key: { workspaceId: 1, createdAt: -1 },
					name: "workspace_created",
				},
				{
					key: { workspaceId: 1, status: 1, createdAt: -1 },
					name: "workspace_status_created",
				},
			]);
		})();
		this.indexed.catch(() => {
			this.indexed = undefined;
		});
		return this.indexed;
	}
	private async storage<T>(operation: () => Promise<T>): Promise<T> {
		try {
			await this.ensureIndexes();
			return await operation();
		} catch (error) {
			if (error instanceof BotError) throw error;
			throw botsUnavailable(error);
		}
	}

	async insertBot(bot: Bot) {
		const { id, ...rest } = bot;
		await this.storage(() => this.bots().insertOne({ _id: id, ...rest }));
	}
	async getBot(workspaceId: string, id: string) {
		// `$eq` compares values only: an id that somehow arrived as an object
		// could not act as a query operator.
		const found = await this.storage(() =>
			this.bots().findOne({
				_id: { $eq: id },
				workspaceId: { $eq: workspaceId },
			}),
		);
		return found ? toBot(found) : null;
	}
	async listBots(workspaceId: string) {
		const found = await this.storage(() =>
			this.bots().find({ workspaceId }).toArray(),
		);
		return found.map(toBot).sort(byName);
	}
	replaceBot(bot: Bot, expectedRevision: number) {
		const { id, workspaceId, ...fields } = bot;
		return this.storage(async () => {
			const result = await this.bots().updateOne(
				{ _id: id, workspaceId, revision: expectedRevision },
				{ $set: fields },
			);
			return result.matchedCount > 0;
		});
	}
	deleteBot(workspaceId: string, id: string) {
		return this.storage(async () => {
			const result = await this.bots().deleteOne({
				_id: { $eq: id },
				workspaceId: { $eq: workspaceId },
			});
			return result.deletedCount > 0;
		});
	}

	insertRun(run: StoredRun) {
		const { id, ...rest } = run;
		return this.storage(async () => {
			try {
				await this.runs().insertOne({ _id: id, ...rest });
				return true;
			} catch (error) {
				if (isDuplicateKey(error)) return false;
				throw error;
			}
		});
	}
	async claimRun(
		id: string,
		lease: RunLease,
		now: string,
		maxAttempts: number,
	) {
		const claimed = await this.storage(() =>
			this.runs().findOneAndUpdate(
				{
					_id: id,
					attempts: { $lt: maxAttempts },
					$or: [
						{ status: "pending" },
						// ISO timestamps compare as strings.
						{ status: "running", leaseUntil: { $lte: now } },
					],
				},
				{
					$set: {
						status: "running",
						startedAt: now,
						leaseId: lease.id,
						leaseUntil: lease.until,
					},
					$inc: { attempts: 1 },
				},
				{ returnDocument: "after" },
			),
		);
		return claimed ? toRun(claimed) : null;
	}
	finishRun(id: string, leaseId: string, result: RunResult) {
		return this.storage(async () => {
			const updated = await this.runs().updateOne(
				{ _id: id, status: "running", leaseId },
				{ $set: { ...result, leaseId: null, leaseUntil: null } },
			);
			return updated.matchedCount > 0;
		});
	}
	releaseRun(id: string, leaseId: string, now: string) {
		return this.storage(async () => {
			const updated = await this.runs().updateOne(
				{ _id: id, status: "running", leaseId },
				{ $set: { leaseUntil: now } },
			);
			return updated.matchedCount > 0;
		});
	}
	async staleRuns(now: string, pendingBefore: string, limit: number) {
		const found = await this.storage(() =>
			this.runs()
				.find({
					$or: [
						{ status: "pending", createdAt: { $lte: pendingBefore } },
						{ status: "running", leaseUntil: { $lte: now } },
					],
				})
				.limit(limit)
				.toArray(),
		);
		return found.map(toRun);
	}
	async listRuns(workspaceId: string, botId: string, limit: number) {
		const found = await this.storage(() =>
			this.runs()
				.find({ workspaceId, botId })
				.sort({ createdAt: -1 })
				.limit(limit)
				.toArray(),
		);
		return found.map((run) => publicRun(toRun(run)));
	}
	async activeRuns(
		workspaceId: string,
		channelId: string,
		now: string,
		pendingAfter: string,
	) {
		const found = await this.storage(() =>
			this.runs()
				.find({
					workspaceId,
					...(channelId === null ? {} : { channelId }),
					$or: [
						{ status: "pending", createdAt: { $gt: pendingAfter } },
						{ status: "running", leaseUntil: { $gt: now } },
					],
				})
				.toArray(),
		);
		return found.map((run) => publicRun(toRun(run)));
	}
	async countRunsByStatus(workspaceId: string, from: string, to: string) {
		const rows = await this.storage(() =>
			this.runs()
				.aggregate<{
					_id: { botId: string; status: BotRunStatus };
					count: number;
				}>([
					{ $match: { workspaceId, createdAt: { $gte: from, $lt: to } } },
					{
						$group: {
							_id: { botId: "$botId", status: "$status" },
							count: { $sum: 1 },
						},
					},
				])
				.toArray(),
		);
		return rows.map((row) => ({
			botId: row._id.botId,
			status: row._id.status,
			count: row.count,
		}));
	}
	async recentRuns(
		workspaceId: string,
		status: BotRunStatus,
		limit: number,
		window: { from: string; to: string },
	) {
		const found = await this.storage(() =>
			this.runs()
				.find({
					workspaceId,
					status,
					createdAt: { $gte: window.from, $lt: window.to },
				})
				.sort({ createdAt: -1 })
				.limit(limit)
				.toArray(),
		);
		return found.map((run) => publicRun(toRun(run)));
	}
	async usageSince(workspaceId: string, hourAgo: string, dayStart: string) {
		const rows = await this.storage(() =>
			this.runs()
				.aggregate<{ _id: string; replies: number; tokens: number }>([
					{
						$match: {
							workspaceId,
							createdAt: { $gte: hourAgo < dayStart ? hourAgo : dayStart },
						},
					},
					{
						$group: {
							_id: "$botId",
							replies: {
								$sum: {
									$cond: [
										{
											$and: [
												{ $gte: ["$createdAt", hourAgo] },
												{ $ne: ["$status", "skipped"] },
											],
										},
										1,
										0,
									],
								},
							},
							tokens: {
								$sum: {
									$cond: [
										{ $gte: ["$createdAt", dayStart] },
										{ $ifNull: ["$usage.totalTokens", 0] },
										0,
									],
								},
							},
						},
					},
				])
				.toArray(),
		);
		return new Map(
			rows.map((row) => [
				row._id,
				{ replies: row.replies, tokens: row.tokens },
			]),
		);
	}
	countRunning(botId: string, now: string) {
		return this.storage(() =>
			this.runs().countDocuments({
				botId,
				status: "running",
				leaseUntil: { $gt: now },
			}),
		);
	}
	countRunsSince(botId: string, since: string) {
		return this.storage(() =>
			this.runs().countDocuments({
				botId,
				createdAt: { $gte: since },
				status: { $ne: "skipped" },
			}),
		);
	}
	async tokensSince(botId: string, since: string) {
		const [sum] = await this.storage(() =>
			this.runs()
				.aggregate<{ tokens: number }>([
					{ $match: { botId, createdAt: { $gte: since } } },
					{ $group: { _id: null, tokens: { $sum: "$usage.totalTokens" } } },
				])
				.toArray(),
		);
		return sum?.tokens ?? 0;
	}
	async close() {
		await this.mongo.close();
	}
}

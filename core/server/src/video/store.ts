import { randomUUID } from "node:crypto";
import {
	type CreateVideoConnectionRequest,
	DEFAULT_VIDEO_LIMIT,
	DEFAULT_VIDEO_POLICY,
	type UpdateVideoConnectionRequest,
	type UpdateVideoPolicyRequest,
	VIDEO_KINDS,
	VIDEO_LIMITS,
	VIDEO_NAME_PATTERN,
	type VideoConnection,
	type VideoLimit,
	type VideoPolicy,
	type VideoProblem,
	videoModel,
} from "@autonomo.us/common";
import type { BudgetHold } from "../budgets/store.js";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import { ServiceError } from "../service-error.js";
import { toMicros, usagePeriods } from "../web/store.js";
import type { WorkspaceRef } from "../workspaces/store.js";
import type { VideoConfig } from "./types.js";

type ConnectionDocument = {
	_id: string;
	workspaceId: string;
	config: VideoConfig;
	problem: VideoProblem | null;
};
type PolicyDocument = {
	_id: string;
	/**
	 * `monthlyBudgetUsd` is from before budgets and seeds the first one;
	 * `callerVideosPerDay` and `maxDurationSeconds` are from before limits
	 * were policies and seed the first limit.
	 */
	policy: Omit<VideoPolicy, "revision"> & {
		monthlyBudgetUsd?: number;
		callerVideosPerDay?: number;
		maxDurationSeconds?: number;
	};
	revision: number;
};
type LimitsDocument = { _id: string; limits: VideoLimit[]; revision: number };
type UsageDocument = {
	_id: string;
	workspaceId: string;
	videos: number;
	/** Millionths of a US dollar, so sums stay exact. */
	costMicros: number;
	expiresAt: Date;
};
type Counter = { videos: number; costMicros: number };
type Entry = {
	config: VideoConfig;
	problem: VideoProblem | null;
	source: "saved" | "environment";
};

const DAY_MS = 86_400_000;

/** A stored whole number within bounds, or the fallback. */
function wholeIn(value: unknown, min: number, max: number, fallback: number) {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= min &&
		value <= max
		? value
		: fallback;
}
const fromMicros = (micros: number) => micros / 1_000_000;

/** What a hold was refused for. Budgets refuse on their own, before this. */
export type VideoHoldRefusal = "caller";

/** One limit's count of a caller's videos today, and the most it allows. */
export type VideoLimitCount = { key: string; cap: number };

/** The video budget every workspace had before budgets existed. */
export const LEGACY_VIDEO_BUDGET_USD = 25;

/**
 * The estimated cost of one video, held before the provider call: on the
 * caller's daily cap and the month's and connection's spend here, and on the
 * budgets that cover it (`budget`).
 */
export type VideoHold = {
	/**
	 * `budget` is the month's video spend, kept under its old name. `limits`
	 * are the limits' day counts this video took; `caller` is the one day
	 * count of a hold taken before limits were policies.
	 */
	keys: {
		budget: string;
		connection: string;
		limits?: string[];
		caller?: string;
	};
	costMicros: number;
	budget?: BudgetHold;
};

export const VIDEO_CONNECTIONS_COLLECTION = "gateway_video_connections";
export const VIDEO_POLICY_COLLECTION = "gateway_video_policy";
export const VIDEO_LIMITS_COLLECTION = "gateway_video_limits";
export const VIDEO_USAGE_COLLECTION = "gateway_video_usage";

/**
 * Video connections, the video policy, and spend counters, per workspace.
 * Read on every request, as proxy connections are, so every replica and
 * Worker isolate sees a change on its next request. Keys stay on the
 * server: public methods return safe projections. Environment connections
 * belong to the default workspace only and cannot be changed here.
 */
export class VideoStore {
	private readonly env = new Map<string, VideoConfig>();
	private readonly mongo?: MongoConnection;
	private readonly memory = new Map<
		string,
		Map<string, { config: VideoConfig; problem: VideoProblem | null }>
	>();
	private readonly memoryPolicies = new Map<string, VideoPolicy>();
	private readonly memoryLimits = new Map<
		string,
		{ limits: VideoLimit[]; revision: number }
	>();
	private readonly envProblems = new Map<string, VideoProblem | null>();
	private readonly counters = new Map<string, Counter>();
	private indexed = false;

	constructor(
		envConnections: VideoConfig[],
		mongo?: string | MongoConnection,
		private readonly now: () => Date = () => new Date(),
	) {
		for (const config of envConnections) this.env.set(config.name, config);
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}

	get persistence(): "mongodb" | "memory" {
		return this.mongo ? "mongodb" : "memory";
	}

	private connections() {
		return (this.mongo as MongoConnection).collection<ConnectionDocument>(
			VIDEO_CONNECTIONS_COLLECTION,
		);
	}
	private policies() {
		return (this.mongo as MongoConnection).collection<PolicyDocument>(
			VIDEO_POLICY_COLLECTION,
		);
	}
	private limitDocuments() {
		return (this.mongo as MongoConnection).collection<LimitsDocument>(
			VIDEO_LIMITS_COLLECTION,
		);
	}
	private usage() {
		return (this.mongo as MongoConnection).collection<UsageDocument>(
			VIDEO_USAGE_COLLECTION,
		);
	}

	async ensureIndexes(): Promise<void> {
		if (!this.mongo || this.indexed) return;
		await Promise.all([
			this.connections().createIndex({ workspaceId: 1 }),
			// Day and month counters delete themselves once nobody reads them.
			this.usage().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
		]);
		this.indexed = true;
	}

	private unavailable(error: unknown): never {
		if (error instanceof ServiceError) throw error;
		throw new ServiceError(
			"Video settings are unavailable. Check the MongoDB connection and retry.",
			503,
			{ cause: error },
		);
	}

	private async saved(
		workspace: WorkspaceRef,
	): Promise<
		Map<string, { config: VideoConfig; problem: VideoProblem | null }>
	> {
		if (!this.mongo)
			return new Map(
				[...(this.memory.get(workspace.id)?.entries() ?? [])].map(
					([name, entry]) => [name, structuredClone(entry)],
				),
			);
		try {
			const documents = await this.connections()
				.find({ workspaceId: { $eq: workspace.id } })
				.toArray();
			return new Map(
				documents.map((document) => [
					document.config.name,
					{ config: document.config, problem: document.problem ?? null },
				]),
			);
		} catch (error) {
			this.unavailable(error);
		}
	}

	/**
	 * Every connection in the workspace with its problem and source,
	 * environment ones first. A saved connection wins over an environment
	 * one with the same name.
	 */
	async entries(workspace: WorkspaceRef): Promise<Entry[]> {
		const saved = await this.saved(workspace);
		const result: Entry[] = [];
		if (workspace.isDefault)
			for (const [name, config] of this.env)
				if (!saved.has(name))
					result.push({
						config: structuredClone(config),
						problem: this.envProblems.get(name) ?? null,
						source: "environment",
					});
		for (const entry of saved.values())
			result.push({ ...entry, source: "saved" });
		return result;
	}

	async connection(
		workspace: WorkspaceRef,
		name: string,
	): Promise<VideoConfig | undefined> {
		return (await this.entries(workspace)).find(
			(entry) => entry.config.name === name,
		)?.config;
	}

	/** The connections as the API shows them, with this month's usage. */
	async list(workspace: WorkspaceRef): Promise<VideoConnection[]> {
		const entries = await this.entries(workspace);
		const { month } = usagePeriods(this.now());
		const counters = await this.readCounters(
			entries.map((entry) =>
				this.connectionKey(workspace, entry.config.name, month),
			),
		);
		return entries.map(({ config, problem, source }, index) =>
			publicConnection(config, problem, source, month, counters[index]),
		);
	}

	private validate(config: VideoConfig): VideoConfig {
		if (!VIDEO_NAME_PATTERN.test(config.name))
			throw new ServiceError(
				"Use a name starting with a lowercase letter, followed by letters, numbers, dashes or underscores (up to 64 characters).",
			);
		if (!(VIDEO_KINDS as readonly string[]).includes(config.kind))
			throw new ServiceError(
				`The provider is one of ${VIDEO_KINDS.join(", ")}.`,
			);
		if (!config.apiKey || config.apiKey.length > VIDEO_LIMITS.keyLength)
			throw new ServiceError("An API key is required for this connection.");
		if (
			config.defaultModel !== undefined &&
			!videoModel(config.kind, config.defaultModel)
		)
			throw new ServiceError(
				`${config.defaultModel} is not a ${config.kind} model. Leave it out to use the provider's default.`,
			);
		if (config.creditPriceUsd !== undefined) {
			if (config.kind !== "luma")
				throw new ServiceError(
					"A credit price is only used by Luma; the others are priced from their list prices.",
				);
			if (
				!Number.isFinite(config.creditPriceUsd) ||
				config.creditPriceUsd < 0 ||
				config.creditPriceUsd > VIDEO_LIMITS.maxCreditPriceUsd
			)
				throw new ServiceError(
					`A credit price is between 0 and ${VIDEO_LIMITS.maxCreditPriceUsd} dollars.`,
				);
		}
		return config;
	}

	async create(
		workspace: WorkspaceRef,
		input: CreateVideoConnectionRequest,
	): Promise<VideoConnection> {
		const config = this.validate({
			name: input.name,
			kind: input.kind,
			apiKey: input.apiKey?.trim(),
			enabled: input.enabled ?? true,
			...(input.defaultModel?.trim()
				? { defaultModel: input.defaultModel.trim() }
				: {}),
			...(input.creditPriceUsd !== undefined
				? { creditPriceUsd: input.creditPriceUsd }
				: {}),
		});
		const entries = await this.entries(workspace);
		if (entries.some((entry) => entry.config.name === config.name))
			throw new ServiceError(
				"A video connection with this name already exists. Choose another name.",
				409,
			);
		if (entries.length >= VIDEO_LIMITS.connections)
			throw new ServiceError(
				`A workspace holds at most ${VIDEO_LIMITS.connections} video connections.`,
				409,
			);
		if (!this.mongo) {
			const saved = this.memory.get(workspace.id) ?? new Map();
			saved.set(config.name, {
				config: structuredClone(config),
				problem: null,
			});
			this.memory.set(workspace.id, saved);
		} else
			try {
				await this.ensureIndexes().catch(() => {});
				await this.connections().insertOne({
					_id: this.documentId(workspace, config.name),
					workspaceId: workspace.id,
					config,
					problem: null,
				});
			} catch (error) {
				if (isDuplicateKey(error))
					throw new ServiceError(
						"A video connection with this name already exists. Choose another name.",
						409,
					);
				this.unavailable(error);
			}
		return publicConnection(
			config,
			null,
			"saved",
			usagePeriods(this.now()).month,
		);
	}

	/**
	 * Changes the fields the request names. The key changes only when one is
	 * sent, and a changed key clears a reported problem.
	 */
	async update(
		workspace: WorkspaceRef,
		name: string,
		input: UpdateVideoConnectionRequest,
	): Promise<VideoConnection> {
		const entry = (await this.entries(workspace)).find(
			(item) => item.config.name === name,
		);
		if (!entry) throw new ServiceError("Video connection not found.", 404);
		if (entry.source === "environment")
			throw new ServiceError(
				"This video connection comes from the gateway's environment and cannot be changed here. Leave it out of the order, or remove its variable, to stop using it.",
				409,
			);
		const next: VideoConfig = { ...entry.config };
		if (input.apiKey?.trim()) next.apiKey = input.apiKey.trim();
		if (input.enabled !== undefined) next.enabled = input.enabled === true;
		if (input.defaultModel !== undefined) {
			if (input.defaultModel.trim())
				next.defaultModel = input.defaultModel.trim();
			else delete next.defaultModel;
		}
		if (input.creditPriceUsd !== undefined)
			next.creditPriceUsd = input.creditPriceUsd;
		this.validate(next);
		const problem = input.apiKey?.trim() ? null : entry.problem;
		if (!this.mongo) {
			this.memory
				.get(workspace.id)
				?.set(name, { config: structuredClone(next), problem });
		} else
			try {
				const result = await this.connections().updateOne(
					{ _id: { $eq: this.documentId(workspace, name) } },
					{ $set: { config: next, problem } },
				);
				if (!result.matchedCount)
					throw new ServiceError("Video connection not found.", 404);
			} catch (error) {
				this.unavailable(error);
			}
		const { month } = usagePeriods(this.now());
		const [usage] = await this.readCounters([
			this.connectionKey(workspace, name, month),
		]);
		return publicConnection(next, problem, entry.source, month, usage);
	}

	async remove(workspace: WorkspaceRef, name: string): Promise<void> {
		const entry = (await this.entries(workspace)).find(
			(item) => item.config.name === name,
		);
		if (!entry) throw new ServiceError("Video connection not found.", 404);
		if (entry.source === "environment")
			throw new ServiceError(
				"This video connection comes from the gateway's environment. Remove its variable instead.",
				409,
			);
		if (!this.mongo) this.memory.get(workspace.id)?.delete(name);
		else
			try {
				await this.connections().deleteOne({
					_id: { $eq: this.documentId(workspace, name) },
				});
			} catch (error) {
				this.unavailable(error);
			}
		// It leaves the order; a lost race is retried on a fresh read.
		for (let attempt = 0; attempt < 5; attempt++) {
			const policy = await this.policy(workspace);
			const order = policy.order.filter((item) => item !== name);
			if (order.length === policy.order.length) return;
			try {
				await this.writePolicy(
					workspace,
					{ ...policy, order },
					policy.revision,
				);
				return;
			} catch (error) {
				if (!(error instanceof ServiceError && error.statusCode === 409))
					throw error;
			}
		}
	}

	/** Records a problem a person has to fix, or clears it with null. */
	async setProblem(
		workspace: WorkspaceRef,
		name: string,
		problem: VideoProblem | null,
	): Promise<void> {
		const saved = await this.saved(workspace).catch(() => new Map());
		if (!saved.has(name)) {
			if (workspace.isDefault && this.env.has(name))
				this.envProblems.set(name, problem);
			return;
		}
		if (!this.mongo) {
			const entry = this.memory.get(workspace.id)?.get(name);
			if (entry) entry.problem = problem;
			return;
		}
		await this.connections()
			.updateOne(
				{ _id: { $eq: this.documentId(workspace, name) } },
				{ $set: { problem } },
			)
			.catch(() => {});
	}

	private documentId(workspace: WorkspaceRef, name: string) {
		return `${workspace.id}:${name}`;
	}

	async policy(workspace: WorkspaceRef): Promise<VideoPolicy> {
		const seed = { ...structuredClone(DEFAULT_VIDEO_POLICY), revision: 0 };
		if (!this.mongo)
			return structuredClone(this.memoryPolicies.get(workspace.id) ?? seed);
		try {
			const saved = await this.policies().findOne({
				_id: { $eq: workspace.id },
			});
			if (!saved) return seed;
			return {
				...DEFAULT_VIDEO_POLICY,
				order: saved.policy.order ?? [],
				revision: saved.revision,
			};
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** Replaces the policy if nobody changed it since `input.revision`. */
	async updatePolicy(
		workspace: WorkspaceRef,
		input: UpdateVideoPolicyRequest,
	): Promise<VideoPolicy> {
		const names = new Set(
			(await this.entries(workspace)).map((entry) => entry.config.name),
		);
		return this.writePolicy(
			workspace,
			validateVideoPolicy(input, names),
			input.revision,
		);
	}

	private async writePolicy(
		workspace: WorkspaceRef,
		policy: Omit<VideoPolicy, "revision">,
		revision: number,
	): Promise<VideoPolicy> {
		const changed = () =>
			new ServiceError(
				"The video settings changed during your request. Reload and try again.",
				409,
			);
		const stored = { order: policy.order };
		if (!this.mongo) {
			if ((this.memoryPolicies.get(workspace.id)?.revision ?? 0) !== revision)
				throw changed();
			const next = { ...structuredClone(stored), revision: revision + 1 };
			this.memoryPolicies.set(workspace.id, next);
			return structuredClone(next);
		}
		try {
			if (revision === 0)
				await this.policies().insertOne({
					_id: workspace.id,
					policy: stored,
					revision: 1,
				});
			else {
				// Field by field, so a budget from before budgets survives until it seeds one.
				const result = await this.policies().updateOne(
					{ _id: { $eq: workspace.id }, revision: { $eq: revision } },
					{
						$set: { "policy.order": stored.order, revision: revision + 1 },
					},
				);
				if (!result.matchedCount) throw changed();
			}
		} catch (error) {
			if (isDuplicateKey(error)) throw changed();
			this.unavailable(error);
		}
		return { ...stored, revision: revision + 1 };
	}

	/**
	 * The workspace's video limits. The first read gives a workspace one: the
	 * videos a day and longest video it had before limits were policies.
	 */
	async limits(
		workspaceId: string,
	): Promise<{ limits: VideoLimit[]; revision: number }> {
		const stored = await this.readLimits(workspaceId);
		if (stored) return stored;
		let legacy: PolicyDocument["policy"] | undefined;
		if (!this.mongo) legacy = undefined;
		else
			try {
				legacy = (await this.policies().findOne({ _id: { $eq: workspaceId } }))
					?.policy;
			} catch (error) {
				this.unavailable(error);
			}
		const at = this.now().toISOString();
		const seed: VideoLimit = {
			id: randomUUID(),
			appliesTo: { kind: "everyone" },
			covers: { kind: "video" },
			videosPerDay: wholeIn(
				legacy?.callerVideosPerDay,
				0,
				VIDEO_LIMITS.maxCallerVideosPerDay,
				DEFAULT_VIDEO_LIMIT.videosPerDay,
			),
			maxDurationSeconds: wholeIn(
				legacy?.maxDurationSeconds,
				VIDEO_LIMITS.minDurationSeconds,
				VIDEO_LIMITS.maxDurationSeconds,
				DEFAULT_VIDEO_LIMIT.maxDurationSeconds,
			),
			enabled: true,
			origin: "video-policy",
			createdAt: at,
			updatedAt: at,
		};
		if (!this.mongo) {
			if (!this.memoryLimits.has(workspaceId))
				this.memoryLimits.set(workspaceId, { limits: [seed], revision: 1 });
			return structuredClone(
				this.memoryLimits.get(workspaceId) ?? { limits: [], revision: 0 },
			);
		}
		try {
			await this.limitDocuments().insertOne({
				_id: workspaceId,
				limits: [seed],
				revision: 1,
			});
		} catch (error) {
			// Another request seeded it first; its document stands.
			if (!isDuplicateKey(error)) this.unavailable(error);
			const winner = await this.readLimits(workspaceId);
			if (winner) return winner;
			this.unavailable(error);
		}
		return { limits: [seed], revision: 1 };
	}

	private async readLimits(
		workspaceId: string,
	): Promise<{ limits: VideoLimit[]; revision: number } | null> {
		if (!this.mongo) {
			const saved = this.memoryLimits.get(workspaceId);
			return saved ? structuredClone(saved) : null;
		}
		try {
			const saved = await this.limitDocuments().findOne({
				_id: { $eq: workspaceId },
			});
			return saved ? { limits: saved.limits, revision: saved.revision } : null;
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** Replaces the workspace's limits if nobody changed them since `revision`. */
	async writeLimits(
		workspaceId: string,
		limits: VideoLimit[],
		revision: number,
	): Promise<void> {
		const changed = () =>
			new ServiceError(
				"The video limits changed during your request. Reload and try again.",
				409,
			);
		if (!this.mongo) {
			if ((this.memoryLimits.get(workspaceId)?.revision ?? 0) !== revision)
				throw changed();
			this.memoryLimits.set(workspaceId, {
				limits: structuredClone(limits),
				revision: revision + 1,
			});
			return;
		}
		try {
			const result = await this.limitDocuments().updateOne(
				{ _id: { $eq: workspaceId }, revision: { $eq: revision } },
				{ $set: { limits, revision: revision + 1 } },
			);
			if (!result.matchedCount) throw changed();
		} catch (error) {
			this.unavailable(error);
		}
	}

	/**
	 * Where a limit counts a caller's videos today. The first limit counts
	 * where the videos a day did before limits were policies, so today's
	 * count carries over.
	 */
	limitKey(
		workspace: WorkspaceRef,
		limit: VideoLimit,
		callerId: string,
		day: string,
	) {
		return limit.origin === "video-policy"
			? this.callerKey(workspace, callerId, day)
			: `${workspace.id}:limit:${limit.id}:${callerId}:${day}`;
	}

	/** Today, as limits count it. */
	today(): string {
		return usagePeriods(this.now()).day;
	}

	connectionKey(workspace: WorkspaceRef, name: string, month: string) {
		return `${workspace.id}:connection:${name}:${month}`;
	}
	budgetKey(workspace: WorkspaceRef, month: string) {
		return `${workspace.id}:budget:${month}`;
	}
	callerKey(workspace: WorkspaceRef, callerId: string, day: string) {
		return `${workspace.id}:caller:${callerId}:${day}`;
	}

	private async readCounters(keys: string[]): Promise<Counter[]> {
		if (!this.mongo)
			return keys.map((key) => ({
				...(this.counters.get(key) ?? { videos: 0, costMicros: 0 }),
			}));
		if (!keys.length) return [];
		try {
			const documents = await this.usage()
				.find({ _id: { $in: keys } })
				.toArray();
			const byKey = new Map(
				documents.map((document) => [document._id, document]),
			);
			return keys.map((key) => ({
				videos: byKey.get(key)?.videos ?? 0,
				costMicros: byKey.get(key)?.costMicros ?? 0,
			}));
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** This month's estimated spend across every connection. */
	async spend(workspace: WorkspaceRef) {
		const { month } = usagePeriods(this.now());
		const [counter] = await this.readCounters([
			this.budgetKey(workspace, month),
		]);
		return { month, spentUsd: fromMicros(counter.costMicros) };
	}

	/**
	 * What the workspace's first budget starts from: the monthly video budget
	 * it had before budgets existed, and this month's video spend so far.
	 */
	async budgetSeed(
		workspaceId: string,
	): Promise<{ videoMonthlyBudgetUsd: number; videoSpentUsd: number }> {
		const workspace = { id: workspaceId, isDefault: false };
		let legacy: number | undefined;
		if (this.mongo)
			try {
				const saved = await this.policies().findOne({
					_id: { $eq: workspaceId },
				});
				legacy = saved?.policy.monthlyBudgetUsd;
			} catch (error) {
				this.unavailable(error);
			}
		const { spentUsd } = await this.spend(workspace);
		return {
			videoMonthlyBudgetUsd:
				typeof legacy === "number" && Number.isFinite(legacy) && legacy >= 0
					? legacy
					: LEGACY_VIDEO_BUDGET_USD,
			videoSpentUsd: spentUsd,
		};
	}

	/**
	 * Adds to a counter only if it stays within the caps. Two calls that
	 * arrive together cannot both take the last unit: the filter and the
	 * increment are one operation.
	 */
	private async increment(
		workspaceId: string,
		key: string,
		amount: Counter,
		caps: { videos?: number; costMicros?: number },
		expiresAt: Date,
	): Promise<boolean> {
		if (
			(caps.videos !== undefined && amount.videos > caps.videos) ||
			(caps.costMicros !== undefined && amount.costMicros > caps.costMicros)
		)
			return false;
		if (!this.mongo) {
			const current = this.counters.get(key) ?? { videos: 0, costMicros: 0 };
			if (
				(caps.videos !== undefined &&
					current.videos + amount.videos > caps.videos) ||
				(caps.costMicros !== undefined &&
					current.costMicros + amount.costMicros > caps.costMicros)
			)
				return false;
			this.counters.set(key, {
				videos: current.videos + amount.videos,
				costMicros: current.costMicros + amount.costMicros,
			});
			return true;
		}
		const filter: Record<string, unknown> = { _id: { $eq: key } };
		if (caps.videos !== undefined)
			filter.videos = { $lte: caps.videos - amount.videos };
		if (caps.costMicros !== undefined)
			filter.costMicros = { $lte: caps.costMicros - amount.costMicros };
		const update = {
			$inc: { videos: amount.videos, costMicros: amount.costMicros },
			$setOnInsert: { workspaceId, expiresAt },
		};
		try {
			await this.usage().updateOne(filter, update, { upsert: true });
			return true;
		} catch (error) {
			if (!isDuplicateKey(error)) this.unavailable(error);
		}
		// The upsert's insert collided: either the counter is over the cap, or
		// another call created it at the same moment. Without the upsert, the
		// filter alone decides.
		try {
			const result = await this.usage().updateOne(filter, {
				$inc: update.$inc,
			});
			return result.matchedCount > 0;
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** Gives units back, never below zero. */
	private async adjust(key: string, amount: Counter) {
		if (!amount.videos && !amount.costMicros) return;
		if (!this.mongo) {
			// As with MongoDB: a decrement that would go below zero changes nothing.
			const current = this.counters.get(key);
			if (
				!current ||
				current.videos + amount.videos < 0 ||
				current.costMicros + amount.costMicros < 0
			)
				return;
			current.videos += amount.videos;
			current.costMicros += amount.costMicros;
			return;
		}
		const filter: Record<string, unknown> = { _id: { $eq: key } };
		if (amount.videos < 0) filter.videos = { $gte: -amount.videos };
		if (amount.costMicros < 0) filter.costMicros = { $gte: -amount.costMicros };
		await this.usage().updateOne(filter, {
			$inc: { videos: amount.videos, costMicros: amount.costMicros },
		});
	}

	/**
	 * Holds one video against each limit's count of the caller's videos
	 * today, all or none, and counts its estimated cost on the month's and
	 * the connection's spend for the usage shown. Budgets hold their part
	 * before this, in BudgetService.
	 */
	async hold(
		workspace: WorkspaceRef,
		input: {
			connection: string;
			limits: VideoLimitCount[];
			costUsd: number;
		},
	): Promise<VideoHold | { refused: VideoHoldRefusal }> {
		const now = this.now();
		const { month, day } = usagePeriods(now);
		const costMicros = toMicros(input.costUsd);
		const monthEnd = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
		);
		const monthExpiry = new Date(monthEnd.getTime() + 400 * DAY_MS);
		const dayExpiry = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * DAY_MS);
		const taken: string[] = [];
		const keys = {
			budget: this.budgetKey(workspace, month),
			connection: this.connectionKey(workspace, input.connection, month),
			limits: taken,
		};
		const giveBack = (counted: { budget?: boolean } = {}) =>
			Promise.allSettled([
				...taken.map((key) => this.adjust(key, { videos: -1, costMicros: 0 })),
				...(counted.budget
					? [this.adjust(keys.budget, { videos: -1, costMicros: -costMicros })]
					: []),
			]);
		for (const limit of input.limits) {
			let held: boolean;
			try {
				held = await this.increment(
					workspace.id,
					limit.key,
					{ videos: 1, costMicros: 0 },
					{ videos: limit.cap },
					dayExpiry,
				);
			} catch (error) {
				await giveBack();
				throw error;
			}
			if (!held) {
				await giveBack();
				return { refused: "caller" };
			}
			taken.push(limit.key);
		}
		try {
			await this.increment(
				workspace.id,
				keys.budget,
				{ videos: 1, costMicros },
				{},
				monthExpiry,
			);
		} catch (error) {
			await giveBack();
			throw error;
		}
		try {
			await this.increment(
				workspace.id,
				keys.connection,
				{ videos: 1, costMicros },
				{},
				monthExpiry,
			);
		} catch (error) {
			await giveBack({ budget: true });
			throw error;
		}
		return { keys, costMicros };
	}

	/** Gives a hold back: the provider charged nothing. */
	async release(hold: VideoHold): Promise<void> {
		await Promise.allSettled([
			this.adjust(hold.keys.budget, {
				videos: -1,
				costMicros: -hold.costMicros,
			}),
			this.adjust(hold.keys.connection, {
				videos: -1,
				costMicros: -hold.costMicros,
			}),
			...(hold.keys.limits ?? []).map((key) =>
				this.adjust(key, { videos: -1, costMicros: 0 }),
			),
			...(hold.keys.caller
				? [this.adjust(hold.keys.caller, { videos: -1, costMicros: 0 })]
				: []),
		]);
	}

	async close(): Promise<void> {
		await this.mongo?.close();
	}
}

function publicConnection(
	config: VideoConfig,
	problem: VideoProblem | null,
	source: "saved" | "environment",
	month: string,
	usage: Counter = { videos: 0, costMicros: 0 },
): VideoConnection {
	return {
		name: config.name,
		kind: config.kind,
		keyConfigured: Boolean(config.apiKey),
		enabled: config.enabled,
		...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
		...(config.kind === "luma"
			? { creditPriceUsd: config.creditPriceUsd ?? 0.01 }
			: {}),
		source,
		usage: {
			month,
			videos: usage.videos,
			costUsd: fromMicros(usage.costMicros),
		},
		problem,
	};
}

/** Checks a policy a person sent against the workspace's connections. */
export function validateVideoPolicy(
	input: UpdateVideoPolicyRequest,
	names: Set<string>,
): Omit<VideoPolicy, "revision"> {
	if (
		!Array.isArray(input.order) ||
		input.order.length > VIDEO_LIMITS.connections
	)
		throw new ServiceError(
			`The order names at most ${VIDEO_LIMITS.connections} connections.`,
		);
	const seen = new Set<string>();
	for (const name of input.order) {
		if (typeof name !== "string" || !names.has(name))
			throw new ServiceError(
				`The order names ${String(name)}, which is not a video connection in this workspace.`,
			);
		if (seen.has(name))
			throw new ServiceError(`${name} is in the order twice.`);
		seen.add(name);
	}
	return { order: [...input.order] };
}

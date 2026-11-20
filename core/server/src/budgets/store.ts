import { randomUUID } from "node:crypto";
import {
	type BudgetPolicy,
	budgetPeriodKey,
	budgetResetsAt,
} from "@autonomo.us/common";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import { ServiceError } from "../service-error.js";
import { toMicros } from "../web/store.js";

type PoliciesDocument = {
	_id: string;
	policies: BudgetPolicy[];
	revision: number;
};
type UsageDocument = {
	_id: string;
	workspaceId: string;
	/** Millionths of a US dollar, so sums stay exact. */
	costMicros: number;
	expiresAt: Date;
};

/** What a workspace starts with: the video budget it had before budgets existed. */
export type BudgetSeed = {
	videoMonthlyBudgetUsd: number;
	/** Video spend already counted this month, carried into the new budget. */
	videoSpentUsd: number;
};

/** An estimate held against every budget that covers it, before a provider call. */
export type BudgetHold = { keys: string[]; costMicros: number };

export const BUDGET_POLICIES_COLLECTION = "gateway_budget_policies";
export const BUDGET_USAGE_COLLECTION = "gateway_budget_usage";

const DAY_MS = 86_400_000;

/**
 * Budget policies, one document per workspace, and what each has spent in
 * the period running, one counter per policy and period. Read on every
 * request that spends, so every replica and Worker isolate sees a change on
 * its next request.
 */
export class BudgetStore {
	private readonly mongo?: MongoConnection;
	private readonly memory = new Map<
		string,
		{ policies: BudgetPolicy[]; revision: number }
	>();
	private readonly counters = new Map<string, number>();
	private indexed = false;
	private readonly now: () => Date;
	private readonly seed?: (workspaceId: string) => Promise<BudgetSeed>;

	constructor(
		mongo?: string | MongoConnection,
		options: {
			now?: () => Date;
			/** The video budget a workspace had before budgets existed. */
			seed?: (workspaceId: string) => Promise<BudgetSeed>;
		} = {},
	) {
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
		this.now = options.now ?? (() => new Date());
		this.seed = options.seed;
	}

	get persistence(): "mongodb" | "memory" {
		return this.mongo ? "mongodb" : "memory";
	}

	private documents() {
		return (this.mongo as MongoConnection).collection<PoliciesDocument>(
			BUDGET_POLICIES_COLLECTION,
		);
	}
	private usage() {
		return (this.mongo as MongoConnection).collection<UsageDocument>(
			BUDGET_USAGE_COLLECTION,
		);
	}

	async ensureIndexes(): Promise<void> {
		if (!this.mongo || this.indexed) return;
		// Day and month counters delete themselves once nobody reads them.
		await this.usage().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
		this.indexed = true;
	}

	private unavailable(error: unknown): never {
		if (error instanceof ServiceError) throw error;
		throw new ServiceError(
			"Budgets are unavailable. Check the MongoDB connection and retry.",
			503,
			{ cause: error },
		);
	}

	/**
	 * The workspace's budgets. The first read gives a workspace one budget:
	 * the monthly video budget it had before budgets existed, with this
	 * month's video spend carried over, so nothing it limited goes unlimited.
	 */
	async policies(
		workspaceId: string,
	): Promise<{ policies: BudgetPolicy[]; revision: number }> {
		const stored = await this.read(workspaceId);
		if (stored) return stored;
		const seed = await this.seedPolicy(workspaceId);
		if (!this.mongo) {
			if (!this.memory.has(workspaceId)) {
				this.memory.set(workspaceId, { policies: [seed.policy], revision: 1 });
				await this.charge(workspaceId, [seed.policy], seed.spentMicros);
			}
			return structuredClone(
				this.memory.get(workspaceId) ?? { policies: [], revision: 0 },
			);
		}
		try {
			await this.documents().insertOne({
				_id: workspaceId,
				policies: [seed.policy],
				revision: 1,
			});
		} catch (error) {
			// Another request seeded it first; its document stands.
			if (!isDuplicateKey(error)) this.unavailable(error);
			const winner = await this.read(workspaceId);
			if (winner) return winner;
			this.unavailable(error);
		}
		// Only the request that inserted the document counts the carried spend.
		await this.charge(workspaceId, [seed.policy], seed.spentMicros);
		return { policies: [seed.policy], revision: 1 };
	}

	private async read(
		workspaceId: string,
	): Promise<{ policies: BudgetPolicy[]; revision: number } | null> {
		if (!this.mongo) {
			const saved = this.memory.get(workspaceId);
			return saved ? structuredClone(saved) : null;
		}
		try {
			const saved = await this.documents().findOne({
				_id: { $eq: workspaceId },
			});
			return saved
				? { policies: saved.policies, revision: saved.revision }
				: null;
		} catch (error) {
			this.unavailable(error);
		}
	}

	private async seedPolicy(workspaceId: string) {
		const seed = (await this.seed?.(workspaceId)) ?? {
			videoMonthlyBudgetUsd: 25,
			videoSpentUsd: 0,
		};
		const at = this.now().toISOString();
		const policy: BudgetPolicy = {
			id: randomUUID(),
			appliesTo: { kind: "everyone" },
			covers: { kind: "video" },
			limitUsd: seed.videoMonthlyBudgetUsd,
			period: "month",
			enabled: true,
			createdAt: at,
			updatedAt: at,
		};
		return { policy, spentMicros: toMicros(seed.videoSpentUsd) };
	}

	/** Replaces the workspace's budgets if nobody changed them since `revision`. */
	async write(
		workspaceId: string,
		policies: BudgetPolicy[],
		revision: number,
	): Promise<number> {
		const changed = () =>
			new ServiceError(
				"The budgets changed during your request. Reload and try again.",
				409,
			);
		if (!this.mongo) {
			if ((this.memory.get(workspaceId)?.revision ?? 0) !== revision)
				throw changed();
			this.memory.set(workspaceId, {
				policies: structuredClone(policies),
				revision: revision + 1,
			});
			return revision + 1;
		}
		try {
			const result = await this.documents().replaceOne(
				{ _id: { $eq: workspaceId }, revision: { $eq: revision } },
				{ policies, revision: revision + 1 },
			);
			if (!result.matchedCount) throw changed();
		} catch (error) {
			this.unavailable(error);
		}
		return revision + 1;
	}

	private key(workspaceId: string, policy: BudgetPolicy, now: Date) {
		return `${workspaceId}:${policy.id}:${budgetPeriodKey(policy.period, now)}`;
	}

	private expiry(policy: BudgetPolicy, now: Date) {
		// A month's counter outlives it, for anyone looking back; a day's does not.
		const ends = Date.parse(budgetResetsAt(policy.period, now));
		return new Date(ends + (policy.period === "day" ? 2 : 400) * DAY_MS);
	}

	/** What each budget has spent in its period now, in millionths of a dollar. */
	async spent(
		workspaceId: string,
		policies: BudgetPolicy[],
	): Promise<number[]> {
		if (!policies.length) return [];
		const now = this.now();
		const keys = policies.map((policy) => this.key(workspaceId, policy, now));
		if (!this.mongo) return keys.map((key) => this.counters.get(key) ?? 0);
		try {
			const found = await this.usage()
				.find({ _id: { $in: keys } })
				.toArray();
			const byKey = new Map(found.map((item) => [item._id, item.costMicros]));
			return keys.map((key) => byKey.get(key) ?? 0);
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** Counts spend that already happened, with no cap: the call is over. */
	async charge(
		workspaceId: string,
		policies: BudgetPolicy[],
		costMicros: number,
	): Promise<void> {
		if (!policies.length || costMicros <= 0) return;
		const now = this.now();
		if (!this.mongo) {
			for (const policy of policies) {
				const key = this.key(workspaceId, policy, now);
				this.counters.set(key, (this.counters.get(key) ?? 0) + costMicros);
			}
			return;
		}
		try {
			await this.usage().bulkWrite(
				policies.map((policy) => ({
					updateOne: {
						filter: { _id: this.key(workspaceId, policy, now) },
						update: {
							$inc: { costMicros },
							$setOnInsert: {
								workspaceId,
								expiresAt: this.expiry(policy, now),
							},
						},
						upsert: true,
					},
				})),
				{ ordered: false },
			);
		} catch (error) {
			this.unavailable(error);
		}
	}

	/**
	 * Holds an estimate against every budget given, all or none: each must
	 * have room for it. What was taken is given back when one has no room.
	 */
	async hold(
		workspaceId: string,
		policies: BudgetPolicy[],
		costMicros: number,
	): Promise<BudgetHold | { refused: BudgetPolicy }> {
		const now = this.now();
		const taken: string[] = [];
		for (const policy of policies) {
			const key = this.key(workspaceId, policy, now);
			let held: boolean;
			try {
				held = await this.increment(
					workspaceId,
					key,
					costMicros,
					toMicros(policy.limitUsd),
					this.expiry(policy, now),
				);
			} catch (error) {
				await this.release({ keys: taken, costMicros });
				throw error;
			}
			if (!held) {
				await this.release({ keys: taken, costMicros });
				return { refused: policy };
			}
			taken.push(key);
		}
		return { keys: taken, costMicros };
	}

	/** Adds `amount` unless that takes the counter past `cap`; check and add are one operation. */
	private async increment(
		workspaceId: string,
		key: string,
		amount: number,
		cap: number,
		expiresAt: Date,
	): Promise<boolean> {
		if (amount > cap) return false;
		if (!this.mongo) {
			const current = this.counters.get(key) ?? 0;
			if (current + amount > cap) return false;
			this.counters.set(key, current + amount);
			return true;
		}
		const filter = { _id: { $eq: key }, costMicros: { $lte: cap - amount } };
		const update = {
			$inc: { costMicros: amount },
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

	/** Gives a hold back, never below zero: the provider charged nothing. */
	async release(hold: BudgetHold): Promise<void> {
		if (!hold.keys.length || hold.costMicros <= 0) return;
		if (!this.mongo) {
			for (const key of hold.keys) {
				const current = this.counters.get(key);
				if (current !== undefined && current >= hold.costMicros)
					this.counters.set(key, current - hold.costMicros);
			}
			return;
		}
		await Promise.allSettled(
			hold.keys.map((key) =>
				this.usage().updateOne(
					{ _id: { $eq: key }, costMicros: { $gte: hold.costMicros } },
					{ $inc: { costMicros: -hold.costMicros } },
				),
			),
		);
	}

	async close(): Promise<void> {
		await this.mongo?.close();
	}
}

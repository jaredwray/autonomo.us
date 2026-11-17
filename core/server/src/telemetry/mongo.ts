import type {
	AnalyticsQuery,
	ModelUsage,
	TelemetryEvent,
	UsageSummary,
} from "@autonomo.us/common";
import { type Collection, MongoBulkWriteError, MongoClient } from "mongodb";
import { mongoOperationDeadlines, SharedMongoClient } from "../mongo.js";
import { type WorkspaceRef, workspaceFilter } from "../workspaces/store.js";
import {
	type AnalyticsFact,
	bucketMs,
	RECORDED_CALLER_KINDS,
	stepConnection,
	WEB_EVENT_TYPE,
	WEB_TOP_SITES,
	type WebFacts,
} from "./analytics.js";

const GATEWAY_TYPES = [
	"gateway.chat",
	"gateway.decisions",
	"gateway.routing",
	"gateway.error",
] as const;

export const TELEMETRY_COLLECTION = "telemetry_events";

type TelemetryDocument = {
	_id: string;
	type: string;
	/** Missing on history recorded before workspaces: that history belongs to the default workspace. */
	workspaceId?: string;
	agentId: string;
	model: string;
	provider: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	latencyMs: number;
	error: string;
	timestamp: Date;
	/** Present when the event recorded an operation. Older rows derive it from `type`. */
	operation?: string;
	callerId?: string;
	callerName?: string;
	callerKind?: string;
	/**
	 * Omitted for failed and unpriced calls. Zero is a real free-model price,
	 * so a missing value must not be stored as 0.
	 */
	estimatedCostUsd?: number;
	/** Web fetches only (`gateway.web`): the target's host, never its path. */
	host?: string;
	ok?: boolean;
	outcome?: string;
	proxied?: boolean;
	cached?: boolean;
	via?: string;
	/** What the proxies charged for the fetch. */
	costUsd?: number;
	attempts?: Array<{ step: string; outcome: string; costUsd: number }>;
};

function asNumber(value: unknown): number {
	const parsed = typeof value === "string" ? Number(value) : (value as number);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** `anthropic/claude-opus-4-8` + provider `anthropic` → `claude-opus-4-8`. */
export function stripProviderPrefix(model: string, provider: string): string {
	return provider && model.startsWith(`${provider}/`)
		? model.slice(provider.length + 1)
		: model;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function eventToDocument(event: TelemetryEvent): TelemetryDocument {
	const data = event.data;
	const estimatedCostUsd =
		typeof data.estimatedCostUsd === "number" &&
		Number.isFinite(data.estimatedCostUsd) &&
		data.estimatedCostUsd >= 0
			? data.estimatedCostUsd
			: undefined;
	const callerId = text(data.callerId);
	const callerName = text(data.callerName);
	const callerKind = text(data.callerKind);
	const operation = text(data.operation);
	return {
		_id: event.id,
		type: event.type,
		...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
		agentId: event.agentId ?? "",
		model: typeof data.model === "string" ? data.model : "",
		provider: typeof data.provider === "string" ? data.provider : "",
		promptTokens: asNumber(data.promptTokens),
		completionTokens: asNumber(data.completionTokens),
		totalTokens: asNumber(data.totalTokens),
		latencyMs: asNumber(data.latencyMs),
		error: typeof data.error === "string" ? data.error : "",
		timestamp: new Date(event.timestamp),
		...(operation ? { operation } : {}),
		...(callerId ? { callerId } : {}),
		...(callerName ? { callerName } : {}),
		...(callerKind ? { callerKind } : {}),
		...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
		...(event.type === WEB_EVENT_TYPE ? webFields(data) : {}),
	};
}

/** The parts of a web fetch that analytics group by. */
function webFields(data: TelemetryEvent["data"]): Partial<TelemetryDocument> {
	const host = text(data.host);
	const outcome = text(data.outcome);
	const via = text(data.via);
	const attempts = Array.isArray(data.attempts)
		? data.attempts.flatMap((attempt) => {
				if (!attempt || typeof attempt !== "object") return [];
				const item = attempt as Record<string, unknown>;
				const step = text(item.step);
				return step
					? [
							{
								step,
								outcome: text(item.outcome) ?? "",
								costUsd: Math.max(0, asNumber(item.costUsd)),
							},
						]
					: [];
			})
		: [];
	return {
		...(host ? { host } : {}),
		...(typeof data.ok === "boolean" ? { ok: data.ok } : {}),
		...(outcome ? { outcome } : {}),
		...(typeof data.proxied === "boolean" ? { proxied: data.proxied } : {}),
		...(typeof data.cached === "boolean" ? { cached: data.cached } : {}),
		...(via ? { via } : {}),
		costUsd: Math.max(0, asNumber(data.costUsd)),
		attempts,
	};
}

function duplicateKeysOnly(error: unknown): boolean {
	if (!(error instanceof MongoBulkWriteError)) return false;
	const writes = Array.isArray(error.writeErrors)
		? error.writeErrors
		: [error.writeErrors];
	return writes.length > 0 && writes.every((write) => write.code === 11000);
}

/**
 * Durable telemetry in MongoDB. Retried inserts keep the event id as `_id`,
 * so a batch that committed but lost its acknowledgement does not double-count.
 */
export class MongoTelemetrySink {
	/** False after a failed request until the next successful one. */
	healthy = true;
	private readonly mongo: SharedMongoClient;
	private schemaReady = false;

	constructor(
		readonly url: string,
		timeoutMs = 3000,
	) {
		this.mongo = new SharedMongoClient(
			() =>
				new MongoClient(url, {
					serverSelectionTimeoutMS: timeoutMs,
					...mongoOperationDeadlines(timeoutMs),
				}),
		);
	}

	private collection(): Collection<TelemetryDocument> {
		return this.mongo
			.current()
			.db()
			.collection<TelemetryDocument>(TELEMETRY_COLLECTION);
	}

	private fail(error: unknown): never {
		this.healthy = false;
		throw error;
	}

	async ping(): Promise<void> {
		try {
			await this.collection().db.command({ ping: 1 });
			this.healthy = true;
		} catch (error) {
			this.fail(error);
		}
	}

	async ensureSchema(): Promise<void> {
		if (this.schemaReady) return;
		try {
			await this.collection().createIndex({ type: 1 });
			await this.collection().createIndex({ timestamp: 1, type: 1 });
			await this.collection().createIndex({
				workspaceId: 1,
				timestamp: 1,
				type: 1,
			});
			this.schemaReady = true;
			this.healthy = true;
		} catch (error) {
			this.fail(error);
		}
	}

	async insert(events: TelemetryEvent[]): Promise<void> {
		if (events.length === 0) return;
		try {
			await this.ensureSchema();
			await this.collection().insertMany(events.map(eventToDocument), {
				ordered: false,
			});
			this.healthy = true;
		} catch (error) {
			if (duplicateKeysOnly(error)) {
				this.healthy = true;
				return;
			}
			this.fail(error);
		}
	}

	/** Omitting `workspace` summarizes the whole collection (diagnostics and tests). */
	async querySummary(workspace?: WorkspaceRef): Promise<UsageSummary> {
		try {
			await this.ensureSchema();
			const rows = await this.collection()
				.aggregate<{
					_id: { model: string; provider: string };
					requests: number;
					errors: number;
					promptTokens: number;
					completionTokens: number;
					totalTokens: number;
					latencySum: number;
					successes: number;
				}>([
					{
						$match: {
							type: { $in: [...GATEWAY_TYPES] },
							...(workspace ? { workspaceId: workspaceFilter(workspace) } : {}),
						},
					},
					{
						$group: {
							_id: { model: "$model", provider: "$provider" },
							requests: { $sum: 1 },
							errors: { $sum: { $cond: [{ $ne: ["$error", ""] }, 1, 0] } },
							promptTokens: { $sum: "$promptTokens" },
							completionTokens: { $sum: "$completionTokens" },
							totalTokens: { $sum: "$totalTokens" },
							latencySum: {
								$sum: { $cond: [{ $eq: ["$error", ""] }, "$latencyMs", 0] },
							},
							successes: { $sum: { $cond: [{ $eq: ["$error", ""] }, 1, 0] } },
						},
					},
					{ $sort: { requests: -1 } },
				])
				.toArray();
			this.healthy = true;

			const byModel: ModelUsage[] = rows.map((row) => ({
				model: stripProviderPrefix(row._id.model, row._id.provider),
				provider: row._id.provider,
				requests: row.requests,
				errors: row.errors,
				promptTokens: row.promptTokens,
				completionTokens: row.completionTokens,
				totalTokens: row.totalTokens,
				avgLatencyMs:
					row.successes > 0 ? Math.round(row.latencySum / row.successes) : 0,
			}));
			const totals = byModel.reduce(
				(acc, row) => {
					acc.requests += row.requests;
					acc.errors += row.errors;
					acc.promptTokens += row.promptTokens;
					acc.completionTokens += row.completionTokens;
					acc.totalTokens += row.totalTokens;
					acc.weightedLatency +=
						row.avgLatencyMs * Math.max(row.requests - row.errors, 0);
					acc.successes += Math.max(row.requests - row.errors, 0);
					return acc;
				},
				{
					requests: 0,
					errors: 0,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					weightedLatency: 0,
					successes: 0,
				},
			);
			return {
				totalRequests: totals.requests,
				totalErrors: totals.errors,
				promptTokens: totals.promptTokens,
				completionTokens: totals.completionTokens,
				totalTokens: totals.totalTokens,
				avgLatencyMs:
					totals.successes > 0
						? Math.round(totals.weightedLatency / totals.successes)
						: 0,
				byModel,
				source: "mongodb",
			};
		} catch (error) {
			this.fail(error);
		}
	}

	/** Grouped facts for one window. Callers apply model, connection, and caller filters. */
	async queryAnalytics(
		query: AnalyticsQuery,
		workspace?: WorkspaceRef,
	): Promise<AnalyticsFact[]> {
		const from = Date.parse(query.from);
		const to = Date.parse(query.to);
		if (!Number.isFinite(from) || !Number.isFinite(to))
			throw new Error("Invalid analytics window");
		const interval = bucketMs(query);
		let rows: AnalyticsGroup[];
		try {
			await this.ensureSchema();
			rows = await this.collection()
				.aggregate<AnalyticsGroup>([
					{
						$match: {
							type: { $in: [...GATEWAY_TYPES] },
							timestamp: { $gte: new Date(from), $lt: new Date(to) },
							...(workspace ? { workspaceId: workspaceFilter(workspace) } : {}),
						},
					},
					{
						$group: {
							_id: {
								bucket: {
									$multiply: [
										{
											$floor: {
												$divide: [{ $toLong: "$timestamp" }, interval],
											},
										},
										interval,
									],
								},
								model: labeled("$model", "Unknown model"),
								provider: labeled("$provider", "Unknown provider"),
								...callerKey(),
								operation: {
									$cond: [
										nonEmpty("$operation"),
										"$operation",
										{
											$cond: [
												{ $eq: ["$type", "gateway.error"] },
												"unknown",
												{ $substrCP: ["$type", 8, 64] },
											],
										},
									],
								},
							},
							requests: { $sum: 1 },
							errors: {
								$sum: {
									$cond: [
										{
											$or: [
												{ $eq: ["$type", "gateway.error"] },
												{ $ne: ["$error", ""] },
											],
										},
										1,
										0,
									],
								},
							},
							promptTokens: { $sum: "$promptTokens" },
							completionTokens: { $sum: "$completionTokens" },
							totalTokens: { $sum: "$totalTokens" },
							estimatedCostUsd: {
								$sum: { $cond: [pricedCost(), "$estimatedCostUsd", 0] },
							},
							pricedRequests: { $sum: { $cond: [pricedCost(), 1, 0] } },
							latencyTotal: {
								$sum: {
									$cond: [
										{
											$and: [
												{ $ne: ["$type", "gateway.error"] },
												{ $eq: ["$error", ""] },
											],
										},
										"$latencyMs",
										0,
									],
								},
							},
							lastSeen: { $max: "$timestamp" },
						},
					},
					{ $sort: { "_id.bucket": 1, lastSeen: 1 } },
					{ $limit: 100_001 },
				])
				.toArray();
			this.healthy = true;
		} catch (error) {
			this.fail(error);
		}
		// A truncated grouping would under-report. Memory coverage is disclosed instead.
		if (rows.length > 100_000)
			throw new Error("Analytics grouping limit exceeded");
		return rows.map((row) => ({
			timestamp: new Date(asMillis(row._id.bucket)).toISOString(),
			model: row._id.model,
			provider: row._id.provider,
			caller: caller(row._id),
			operation: row._id.operation,
			requests: row.requests,
			errors: row.errors,
			promptTokens: row.promptTokens,
			completionTokens: row.completionTokens,
			totalTokens: row.totalTokens,
			estimatedCostUsd: row.estimatedCostUsd,
			pricedRequests: row.pricedRequests,
			latencyTotal: row.latencyTotal,
			lastSeen: new Date(asMillis(row.lastSeen)).toISOString(),
		}));
	}

	/**
	 * Grouped web fetch facts for one window. Fetches and steps are grouped
	 * by caller, and the caller filter is applied afterwards like the model
	 * report's. Sites are grouped by host alone, after the caller filter, and
	 * only the top ones are returned, so a crawling agent cannot reach the
	 * grouping limit. Fetches recorded before outcomes were kept are only
	 * counted.
	 */
	async queryWebAnalytics(
		query: AnalyticsQuery,
		workspace?: WorkspaceRef,
	): Promise<WebFacts> {
		const from = Date.parse(query.from);
		const to = Date.parse(query.to);
		if (!Number.isFinite(from) || !Number.isFinite(to))
			throw new Error("Invalid analytics window");
		const window = {
			type: WEB_EVENT_TYPE,
			timestamp: { $gte: new Date(from), $lt: new Date(to) },
			...(workspace ? { workspaceId: workspaceFilter(workspace) } : {}),
		};
		const detailed = { ...window, outcome: { $exists: true, $ne: "" } };
		const counts = {
			fetches: { $sum: 1 },
			succeeded: { $sum: { $cond: [{ $eq: ["$ok", true] }, 1, 0] } },
			proxied: { $sum: { $cond: [{ $eq: ["$proxied", true] }, 1, 0] } },
			cached: { $sum: { $cond: [{ $eq: ["$cached", true] }, 1, 0] } },
			costUsd: { $sum: nonNegative("$costUsd") },
			latencyTotal: {
				$sum: { $cond: [{ $eq: ["$ok", true] }, nonNegative("$latencyMs"), 0] },
			},
			lastSeen: { $max: "$timestamp" },
		};
		type Counts = {
			fetches: number;
			succeeded: number;
			proxied: number;
			cached: number;
			costUsd: number;
			latencyTotal: number;
			lastSeen: Date | number;
		};
		type CallerKey = {
			callerId: string;
			callerName: string;
			callerKind: string;
		};
		const limit = { $limit: 100_001 };
		let fetches: Array<Counts & { _id: CallerKey & { outcome: string } }>;
		let hosts: Array<Counts & { _id: string }>;
		let steps: Array<{
			_id: CallerKey & { step: string };
			attempts: number;
			succeeded: number;
			costUsd: number;
			lastSeen: Date | number;
		}>;
		let legacy: number;
		try {
			await this.ensureSchema();
			const collection = this.collection();
			[fetches, hosts, steps, legacy] = await Promise.all([
				collection
					.aggregate<(typeof fetches)[number]>([
						{ $match: detailed },
						{
							$group: {
								_id: { ...callerKey(), outcome: "$outcome" },
								...counts,
							},
						},
						limit,
					])
					.toArray(),
				collection
					.aggregate<(typeof hosts)[number]>([
						{
							$match: {
								...detailed,
								// Web fetches always record their caller.
								...(query.caller ? { callerId: query.caller } : {}),
							},
						},
						{ $group: { _id: labeled("$host", "Unknown site"), ...counts } },
						{ $sort: { fetches: -1, costUsd: -1, _id: 1 } },
						{ $limit: WEB_TOP_SITES },
					])
					.toArray(),
				collection
					.aggregate<(typeof steps)[number]>([
						{ $match: detailed },
						{ $unwind: "$attempts" },
						// A skipped step made no request.
						{ $match: { "attempts.outcome": { $ne: "skipped" } } },
						{
							$group: {
								_id: { ...callerKey(), step: "$attempts.step" },
								attempts: { $sum: 1 },
								succeeded: {
									$sum: { $cond: [{ $eq: ["$attempts.outcome", "ok"] }, 1, 0] },
								},
								costUsd: { $sum: nonNegative("$attempts.costUsd") },
								lastSeen: { $max: "$timestamp" },
							},
						},
						limit,
					])
					.toArray(),
				// A plain count, filtered in the query, so no number of callers
				// can reach a grouping limit. Web fetches always record their caller.
				collection.countDocuments({
					...window,
					$or: [{ outcome: { $exists: false } }, { outcome: "" }],
					...(query.caller ? { callerId: query.caller } : {}),
				}),
			]);
			this.healthy = true;
		} catch (error) {
			this.fail(error);
		}
		if (fetches.length > 100_000 || steps.length > 100_000)
			throw new Error("Analytics grouping limit exceeded");
		const seen = (value: Date | number) =>
			new Date(asMillis(value)).toISOString();
		const countsOf = (row: Counts) => ({
			fetches: row.fetches,
			succeeded: row.succeeded,
			proxied: row.proxied,
			cached: row.cached,
			costUsd: row.costUsd,
			latencyTotal: row.latencyTotal,
			lastSeen: seen(row.lastSeen),
		});
		return {
			fetches: fetches.map((row) => ({
				...countsOf(row),
				caller: caller(row._id),
				outcome: row._id.outcome,
			})),
			hosts: hosts.map((row) => ({ ...countsOf(row), host: row._id })),
			// Steps are grouped by their label (`zenrows:auto`), so connections
			// are summed here, the same way memory sums them.
			steps: steps.map((row) => ({
				connection: stepConnection(row._id.step),
				caller: caller(row._id),
				attempts: row.attempts,
				succeeded: row.succeeded,
				costUsd: row.costUsd,
				lastSeen: seen(row.lastSeen),
			})),
			legacy: legacy ? [{ fetches: legacy }] : [],
		};
	}

	async close(): Promise<void> {
		// Drop the reference first so the next call opens a fresh client even
		// when closing this one fails.
		await this.mongo.close();
	}
}

type AnalyticsGroup = {
	_id: {
		bucket: number;
		model: string;
		provider: string;
		callerId: string;
		callerName: string;
		callerKind: string;
		operation: string;
	};
	requests: number;
	errors: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	estimatedCostUsd: number;
	pricedRequests: number;
	latencyTotal: number;
	lastSeen: Date | number;
};

/** The caller of a grouped row; matches `eventCaller` in analytics.ts. */
function callerKey() {
	return {
		callerId: {
			$cond: [
				recordedCaller(),
				"$callerId",
				{
					$cond: [
						nonEmpty("$agentId"),
						{ $concat: ["agent:", "$agentId"] },
						"unattributed",
					],
				},
			],
		},
		callerName: {
			$cond: [
				recordedCaller(),
				{ $cond: [nonEmpty("$callerName"), "$callerName", "$callerId"] },
				{ $cond: [nonEmpty("$agentId"), "$agentId", "Unattributed"] },
			],
		},
		callerKind: {
			$cond: [
				recordedCaller(),
				"$callerKind",
				{ $cond: [nonEmpty("$agentId"), "agent", "unattributed"] },
			],
		},
	};
}

function caller(row: {
	callerId: string;
	callerName: string;
	callerKind: string;
}): AnalyticsFact["caller"] {
	return {
		id: row.callerId,
		name: row.callerName || row.callerId,
		kind: callerKind(row.callerKind),
	};
}

/** A number at least zero, or zero: the same rule memory applies. */
function nonNegative(field: string) {
	return {
		$cond: [
			{
				$and: [
					{ $in: [{ $type: field }, ["double", "int", "long", "decimal"]] },
					{ $gte: [field, 0] },
				],
			},
			field,
			0,
		],
	};
}

function nonEmpty(field: string) {
	return { $gt: [{ $strLenCP: { $ifNull: [field, ""] } }, 0] };
}

function labeled(field: string, fallback: string) {
	return { $cond: [nonEmpty(field), field, fallback] };
}

/**
 * Callers the gateway recorded win over a client-supplied agent id; the same
 * rule as `eventCaller`, so memory and MongoDB agree.
 */
function recordedCaller() {
	return {
		$and: [
			{
				$in: [{ $ifNull: ["$callerKind", ""] }, [...RECORDED_CALLER_KINDS]],
			},
			nonEmpty("$callerId"),
			{
				$or: [
					{ $ne: ["$callerKind", "agent"] },
					{
						$eq: [
							{ $substrCP: [{ $ifNull: ["$callerId", ""] }, 0, 6] },
							"agent:",
						],
					},
				],
			},
		],
	};
}

/** Missing prices stay unknown. A stored zero is a successful free call. */
function pricedCost() {
	return {
		$and: [
			{
				$in: [
					{ $type: "$estimatedCostUsd" },
					["double", "int", "long", "decimal"],
				],
			},
			{ $gte: ["$estimatedCostUsd", 0] },
		],
	};
}

const CALLER_KINDS = new Set<AnalyticsFact["caller"]["kind"]>([
	"api-token",
	"owner",
	"user",
	"agent",
	"unattributed",
]);

function callerKind(value: string): AnalyticsFact["caller"]["kind"] {
	return CALLER_KINDS.has(value as AnalyticsFact["caller"]["kind"])
		? (value as AnalyticsFact["caller"]["kind"])
		: "unattributed";
}

function asMillis(value: unknown): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "bigint") return Number(value);
	if (
		value &&
		typeof value === "object" &&
		"toNumber" in value &&
		typeof value.toNumber === "function"
	)
		return Number(value.toNumber());
	return asNumber(value);
}

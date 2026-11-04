import type {
	AnalyticsQuery,
	ModelUsage,
	TelemetryEvent,
	UsageSummary,
} from "@autonomo.us/common";
import { type Collection, MongoBulkWriteError, MongoClient } from "mongodb";
import { mongoOperationDeadlines, requestMongoClient } from "../mongo.js";
import { type AnalyticsFact, bucketMs } from "./analytics.js";

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
	private client?: MongoClient;
	private schemaReady = false;

	constructor(
		readonly url: string,
		private readonly timeoutMs = 3000,
	) {}

	private collection(): Collection<TelemetryDocument> {
		const create = () =>
			new MongoClient(this.url, {
				serverSelectionTimeoutMS: this.timeoutMs,
				...mongoOperationDeadlines(this.timeoutMs),
			});
		let client = requestMongoClient(this, create);
		if (!client) {
			this.client ??= create();
			client = this.client;
		}
		return client.db().collection<TelemetryDocument>(TELEMETRY_COLLECTION);
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

	async querySummary(): Promise<UsageSummary> {
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
					{ $match: { type: { $in: [...GATEWAY_TYPES] } } },
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
	async queryAnalytics(query: AnalyticsQuery): Promise<AnalyticsFact[]> {
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
								callerId: {
									$cond: [
										credentialCaller(),
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
										credentialCaller(),
										{
											$cond: [
												nonEmpty("$callerName"),
												"$callerName",
												"$callerId",
											],
										},
										{
											$cond: [nonEmpty("$agentId"), "$agentId", "Unattributed"],
										},
									],
								},
								callerKind: {
									$cond: [
										credentialCaller(),
										"$callerKind",
										{
											$cond: [nonEmpty("$agentId"), "agent", "unattributed"],
										},
									],
								},
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
			caller: {
				id: row._id.callerId,
				name: row._id.callerName || row._id.callerId,
				kind: callerKind(row._id.callerKind),
			},
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

	async close(): Promise<void> {
		// Drop the reference first so the next call opens a fresh client even
		// when closing this one fails.
		const client = this.client;
		this.client = undefined;
		await client?.close();
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

function nonEmpty(field: string) {
	return { $gt: [{ $strLenCP: { $ifNull: [field, ""] } }, 0] };
}

function labeled(field: string, fallback: string) {
	return { $cond: [nonEmpty(field), field, fallback] };
}

/** Credential callers win over a client-supplied agent id. */
function credentialCaller() {
	return {
		$and: [
			{
				$in: [{ $ifNull: ["$callerKind", ""] }, ["api-token", "owner", "user"]],
			},
			nonEmpty("$callerId"),
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

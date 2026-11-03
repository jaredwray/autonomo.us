import type {
	ModelUsage,
	TelemetryEvent,
	UsageSummary,
} from "@autonomo.us/common";
import { type Collection, MongoBulkWriteError, MongoClient } from "mongodb";
import { mongoOperationDeadlines } from "../mongo.js";

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

export function eventToDocument(event: TelemetryEvent): TelemetryDocument {
	const data = event.data;
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
		this.client ??= new MongoClient(this.url, {
			serverSelectionTimeoutMS: this.timeoutMs,
			...mongoOperationDeadlines(this.timeoutMs),
		});
		return this.client.db().collection<TelemetryDocument>(TELEMETRY_COLLECTION);
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

	async close(): Promise<void> {
		// Drop the reference first so the next call opens a fresh client even
		// when closing this one fails.
		const client = this.client;
		this.client = undefined;
		await client?.close();
	}
}

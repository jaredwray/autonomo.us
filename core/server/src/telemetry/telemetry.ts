import { randomUUID } from "node:crypto";
import type {
	AnalyticsQuery,
	ModelPricing,
	ModelUsage,
	TelemetryCaller,
	TelemetryEvent,
	TokenUsage,
	UsageAnalytics,
	UsageSummary,
} from "@autonomo.us/common";
import { inWorkspace, type WorkspaceRef } from "../workspaces/store.js";
import {
	bucketMs,
	buildAnalytics,
	eventFact,
	GATEWAY_EVENT_TYPES,
} from "./analytics.js";
import type { MongoTelemetrySink } from "./mongo.js";

export type ChatTelemetry = {
	operation?: "chat" | "decisions" | "routing";
	/** The workspace the call ran in. Omitted only by callers outside a workspace (tests). */
	workspaceId?: string;
	/** Provider implementation kind (`openai`, `anthropic`, …), used to price the call. */
	providerKind?: string;
	/** Canonical routable id, e.g. `anthropic/claude-opus-4-8`. */
	model: string;
	provider: string;
	agentId?: string;
	caller?: TelemetryCaller;
	usage: TokenUsage;
	latencyMs: number;
	stream?: boolean;
	error?: string;
	/** Set on failover attempts: the model the client originally asked for. */
	requestedModel?: string;
};

export type TelemetryServiceOptions = {
	sink?: MongoTelemetrySink;
	/** How many events to keep in the in-memory ring buffer. */
	maxRecent?: number;
	/**
	 * Flush cadence for the MongoDB sink. `0` flushes after each recorded
	 * event instead of on a timer, which is what the Worker entry uses:
	 * a timer would run outside a request, where Workers forbid I/O.
	 */
	flushIntervalMs?: number;
	/** Max events buffered for the sink before oldest are dropped. */
	maxPending?: number;
	/** Max distinct models aggregated in memory; overflow folds into "(other)". */
	maxModels?: number;
	/** Separate bounded history for analytics; independent of the recent-event feed. */
	maxAnalyticsEvents?: number;
	/** Per-workspace in-memory aggregates kept; least recently used are evicted first. */
	maxWorkspaces?: number;
	now?: () => Date;
};

/** Bucket for aggregates once `maxModels` distinct model ids are tracked. */
export const OVERFLOW_MODEL_KEY = "(other)";

type MutableModelUsage = ModelUsage & { successLatencyTotal: number };
type Totals = {
	requests: number;
	errors: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	successLatencyTotal: number;
};
/** In-memory aggregates for one workspace (or the whole process). */
type Partition = {
	recent: TelemetryEvent[];
	byModel: Map<string, MutableModelUsage>;
	totals: Totals;
};
const newPartition = (): Partition => ({
	recent: [],
	byModel: new Map(),
	totals: {
		requests: 0,
		errors: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		successLatencyTotal: 0,
	},
});
/** Events recorded outside any workspace (tests) are kept under this key. */
const NO_WORKSPACE = "";

/**
 * Records gateway telemetry. Aggregates live in memory (so the dashboard works
 * with zero infrastructure) and every event is also batched to MongoDB when
 * a sink is configured. Sink failures never break request handling.
 */
export class TelemetryService {
	private readonly sink?: MongoTelemetrySink;
	private readonly maxRecent: number;
	private readonly flushIntervalMs: number;
	private readonly maxPending: number;
	private readonly maxModels: number;
	private readonly now: () => Date;
	private readonly maxAnalyticsEvents: number;
	private readonly analyticsEvents: TelemetryEvent[] = [];
	private analyticsCursor = 0;
	private coverageFrom: string;
	private pricing?: (
		model: string,
		provider: string,
		providerKind?: string,
	) => ModelPricing | undefined;

	/** Whole-process aggregates, for diagnostics and tests. */
	private readonly all = newPartition();
	/** Per-workspace aggregates, bounded; the Map's order is least recently used first. */
	private readonly partitions = new Map<string, Partition>();
	private readonly maxWorkspaces: number;

	private pending: TelemetryEvent[] = [];
	private timer?: ReturnType<typeof setInterval>;
	private schemaReady = false;
	private flushChain: Promise<boolean> = Promise.resolve(true);
	private durableIncomplete = false;

	constructor(options: TelemetryServiceOptions = {}) {
		this.sink = options.sink;
		this.maxRecent = options.maxRecent ?? 100;
		this.flushIntervalMs = options.flushIntervalMs ?? 2000;
		this.maxPending = options.maxPending ?? 5000;
		this.maxModels = options.maxModels ?? 100;
		this.now = options.now ?? (() => new Date());
		this.coverageFrom = this.now().toISOString();
		this.maxAnalyticsEvents = Math.max(1, options.maxAnalyticsEvents ?? 50_000);
		this.maxWorkspaces = Math.max(1, options.maxWorkspaces ?? 64);
		if (this.sink && this.flushIntervalMs > 0) {
			this.timer = setInterval(() => {
				this.scheduleFlush();
			}, this.flushIntervalMs);
			this.timer.unref?.();
		}
	}

	/** Records a chat completion (or failure) and returns the stored event. */
	recordChat(chat: ChatTelemetry): TelemetryEvent {
		const pricing = this.pricing?.(
			chat.model,
			chat.provider,
			chat.providerKind,
		);
		// Failed attempts may have missing or partial usage, so a zero token
		// fallback cannot establish that the provider charged nothing.
		const estimatedCostUsd =
			pricing && !chat.error
				? (chat.usage.promptTokens * pricing.input +
						chat.usage.completionTokens * pricing.output) /
					1_000_000
				: undefined;
		const event: TelemetryEvent = {
			id: randomUUID(),
			type: chat.error
				? "gateway.error"
				: `gateway.${chat.operation ?? "chat"}`,
			...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
			agentId: chat.agentId,
			data: {
				operation: chat.operation ?? "chat",
				...(chat.caller
					? {
							callerId: chat.caller.id,
							callerName: chat.caller.name,
							callerKind: chat.caller.kind,
						}
					: {}),
				...(estimatedCostUsd !== undefined &&
				Number.isFinite(estimatedCostUsd) &&
				estimatedCostUsd >= 0
					? { estimatedCostUsd, pricing, pricingSource: "models.dev" }
					: {}),
				model: chat.model,
				provider: chat.provider,
				promptTokens: chat.usage.promptTokens,
				completionTokens: chat.usage.completionTokens,
				totalTokens: chat.usage.totalTokens,
				latencyMs: chat.latencyMs,
				stream: chat.stream ?? false,
				...(chat.error ? { error: chat.error } : {}),
				...(chat.requestedModel ? { requestedModel: chat.requestedModel } : {}),
			},
			timestamp: this.now().toISOString(),
		};

		this.aggregate(this.all, chat);
		this.aggregate(this.partition(chat.workspaceId ?? NO_WORKSPACE), chat);
		this.record(event);
		return event;
	}

	/** Stores a raw telemetry event (ring buffer + sink queue). */
	record(event: TelemetryEvent): void {
		if (
			GATEWAY_EVENT_TYPES.includes(event.type) &&
			Number.isFinite(Date.parse(event.timestamp))
		) {
			if (this.analyticsEvents.length < this.maxAnalyticsEvents)
				this.analyticsEvents.push(event);
			else {
				// Inclusive eviction timestamp is outside the complete retained window.
				const evicted = this.analyticsEvents[this.analyticsCursor];
				this.coverageFrom = new Date(
					Math.max(
						Date.parse(this.coverageFrom),
						Date.parse(evicted.timestamp) + 1,
					),
				).toISOString();
				this.analyticsEvents[this.analyticsCursor] = event;
				this.analyticsCursor =
					(this.analyticsCursor + 1) % this.maxAnalyticsEvents;
			}
		}
		for (const partition of [
			this.all,
			this.partition(event.workspaceId ?? NO_WORKSPACE),
		]) {
			partition.recent.push(event);
			if (partition.recent.length > this.maxRecent)
				partition.recent.splice(0, partition.recent.length - this.maxRecent);
		}
		if (this.sink) {
			this.pending.push(event);
			if (this.pending.length > this.maxPending) {
				this.durableIncomplete = true;
				this.pending.splice(0, this.pending.length - this.maxPending);
			}
			if (this.flushIntervalMs === 0) this.scheduleFlush();
		}
	}

	/** Gets (and marks as recently used) a workspace's partition, evicting the oldest past the bound. */
	private partition(workspaceId: string): Partition {
		let partition = this.partitions.get(workspaceId);
		if (partition) this.partitions.delete(workspaceId);
		else partition = newPartition();
		this.partitions.set(workspaceId, partition);
		while (this.partitions.size > this.maxWorkspaces) {
			const oldest = this.partitions.keys().next().value as string;
			this.partitions.delete(oldest);
		}
		return partition;
	}

	/**
	 * The aggregates a caller may see: one workspace's, or the whole process
	 * when no workspace is given (diagnostics and tests only; routes always
	 * pass the request's workspace).
	 */
	private view(workspace?: WorkspaceRef): Partition {
		if (!workspace) return this.all;
		const own = this.partitions.get(workspace.id) ?? newPartition();
		if (!workspace.isDefault) return own;
		// Calls recorded outside a workspace belong to the default one.
		const loose = this.partitions.get(NO_WORKSPACE);
		if (!loose) return own;
		const merged = newPartition();
		for (const part of [own, loose]) {
			merged.recent.push(...part.recent);
			for (const key of Object.keys(merged.totals) as (keyof Totals)[])
				merged.totals[key] += part.totals[key];
			for (const [key, usage] of part.byModel) {
				const target = merged.byModel.get(key);
				if (!target) {
					merged.byModel.set(key, { ...usage });
					continue;
				}
				target.requests += usage.requests;
				target.errors += usage.errors;
				target.promptTokens += usage.promptTokens;
				target.completionTokens += usage.completionTokens;
				target.totalTokens += usage.totalTokens;
				target.successLatencyTotal += usage.successLatencyTotal;
				const successes = target.requests - target.errors;
				target.avgLatencyMs =
					successes > 0
						? Math.round(target.successLatencyTotal / successes)
						: 0;
			}
		}
		merged.recent.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		return merged;
	}

	/**
	 * `resolve(model, provider, providerKind)` prices a call; `providerKind` is
	 * the connection's implementation (`openai`, `anthropic`, …) when known.
	 */
	setPricingResolver(
		resolve: (
			model: string,
			provider: string,
			providerKind?: string,
		) => ModelPricing | undefined,
	): void {
		this.pricing = resolve;
	}

	async analytics(
		query: AnalyticsQuery,
		workspace?: WorkspaceRef,
	): Promise<UsageAnalytics> {
		const generatedAt = this.now().toISOString();
		if (this.sink && (await this.drain()) && !this.durableIncomplete) {
			try {
				const facts = await this.sink.queryAnalytics(query, workspace);
				return buildAnalytics(facts, query, {
					generatedAt,
					source: "mongodb",
					coverageFrom: null,
					partial: false,
					durableUnavailable: false,
				});
			} catch {
				/* Explicitly report the reduced memory coverage below. */
			}
		}
		const from = Date.parse(query.from);
		const to = Date.parse(query.to);
		const facts = this.analyticsEvents
			.filter(
				(event) =>
					Date.parse(event.timestamp) >= from &&
					Date.parse(event.timestamp) < to &&
					(!workspace || inWorkspace(event.workspaceId, workspace)),
			)
			.map((event) => eventFact(event, bucketMs(query)));
		return buildAnalytics(facts, query, {
			generatedAt,
			source: "memory",
			coverageFrom: this.coverageFrom,
			partial: from < Date.parse(this.coverageFrom),
			durableUnavailable: Boolean(this.sink),
		});
	}

	private aggregate(partition: Partition, chat: ChatTelemetry): void {
		const { byModel, totals } = partition;
		// Bound the map: unadvertised model ids are routable (and typos still
		// get recorded), so distinct keys would otherwise grow forever.
		const key =
			byModel.has(chat.model) || byModel.size < this.maxModels
				? chat.model
				: OVERFLOW_MODEL_KEY;
		let usage = byModel.get(key);
		if (!usage) {
			usage = {
				model:
					key === OVERFLOW_MODEL_KEY
						? OVERFLOW_MODEL_KEY
						: chat.model.includes("/")
							? chat.model.slice(chat.model.indexOf("/") + 1)
							: chat.model,
				provider: key === OVERFLOW_MODEL_KEY ? "other" : chat.provider,
				requests: 0,
				errors: 0,
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				avgLatencyMs: 0,
				successLatencyTotal: 0,
			};
			byModel.set(key, usage);
		}

		usage.requests += 1;
		totals.requests += 1;
		if (chat.error) {
			usage.errors += 1;
			totals.errors += 1;
		} else {
			usage.successLatencyTotal += chat.latencyMs;
			totals.successLatencyTotal += chat.latencyMs;
		}
		usage.promptTokens += chat.usage.promptTokens;
		usage.completionTokens += chat.usage.completionTokens;
		usage.totalTokens += chat.usage.totalTokens;
		totals.promptTokens += chat.usage.promptTokens;
		totals.completionTokens += chat.usage.completionTokens;
		totals.totalTokens += chat.usage.totalTokens;

		const successes = usage.requests - usage.errors;
		usage.avgLatencyMs =
			successes > 0 ? Math.round(usage.successLatencyTotal / successes) : 0;
	}

	/** In-memory usage summary for the current process lifetime. */
	summary(workspace?: WorkspaceRef): UsageSummary {
		const { totals, byModel } = this.view(workspace);
		const successes = totals.requests - totals.errors;
		return {
			totalRequests: totals.requests,
			totalErrors: totals.errors,
			promptTokens: totals.promptTokens,
			completionTokens: totals.completionTokens,
			totalTokens: totals.totalTokens,
			avgLatencyMs:
				successes > 0 ? Math.round(totals.successLatencyTotal / successes) : 0,
			byModel: [...byModel.values()]
				.map(({ successLatencyTotal: _ignored, ...usage }) => usage)
				.sort((a, b) => b.requests - a.requests),
			source: "memory",
		};
	}

	/**
	 * Durable summary from MongoDB; returns undefined when no sink is
	 * configured, pending events cannot be flushed, or the query fails —
	 * callers fall back to the complete in-memory summary in every case.
	 */
	async summaryFromSink(
		workspace?: WorkspaceRef,
	): Promise<UsageSummary | undefined> {
		if (!this.sink) return undefined;
		// A failed flush means the durable store is missing events we hold in
		// memory — serving its summary would silently under-report.
		if (!(await this.drain())) return undefined;
		try {
			return await this.sink.querySummary(workspace);
		} catch {
			return undefined;
		}
	}

	recentEvents(limit = 50, workspace?: WorkspaceRef): TelemetryEvent[] {
		return this.view(workspace).recent.slice(-limit).reverse();
	}

	get sinkHealthy(): boolean {
		return this.sink?.healthy ?? false;
	}

	get sinkConfigured(): boolean {
		return this.sink !== undefined;
	}

	/** Bootstraps the MongoDB indexes once (also needed before queries). */
	private async ensureSchemaOnce(): Promise<void> {
		if (!this.sink || this.schemaReady) return;
		await this.sink.ensureSchema();
		this.schemaReady = true;
	}

	private scheduleFlush(): void {
		this.flushChain = this.flushChain.then(() => this.flush());
	}

	/**
	 * Drops events not yet written, so a later flush can't bring back usage
	 * whose data setup just deleted. Call after `drain()`, when no flush is
	 * in flight to requeue its batch.
	 */
	discardPending(): void {
		this.pending = [];
	}

	/** Waits until queued flushes have finished. False when events remain. */
	async drain(): Promise<boolean> {
		let ok = await this.flushChain;
		if (this.pending.length > 0) {
			this.scheduleFlush();
			ok = await this.flushChain;
		}
		return ok && this.pending.length === 0;
	}

	/**
	 * Ships pending events to MongoDB. Returns false when events remain
	 * queued (sink failure); they are retried on the next flush.
	 */
	async flush(): Promise<boolean> {
		if (!this.sink) return false;
		try {
			await this.ensureSchemaOnce();
			if (this.pending.length === 0) return true;
			const batch = this.pending;
			this.pending = [];
			try {
				await this.sink.insert(batch);
				return true;
			} catch {
				// Requeue (bounded) and retry on the next flush tick.
				const requeued = [...batch, ...this.pending];
				if (requeued.length > this.maxPending) this.durableIncomplete = true;
				this.pending = requeued.slice(-this.maxPending);
				return false;
			}
		} catch {
			return false;
		}
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await this.drain().catch(() => false);
	}

	/** Drops the MongoDB socket so the next request can open a new one. */
	async close(): Promise<void> {
		await this.stop();
		await this.sink?.close();
	}
}

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
import {
	bucketMs,
	buildAnalytics,
	eventFact,
	GATEWAY_EVENT_TYPES,
} from "./analytics.js";
import type { ClickHouseSink } from "./clickhouse.js";

export type ChatTelemetry = {
	operation?: "chat" | "decisions" | "routing";
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
	sink?: ClickHouseSink;
	/** How many events to keep in the in-memory ring buffer. */
	maxRecent?: number;
	/** Flush cadence for the ClickHouse sink. */
	flushIntervalMs?: number;
	/** Max events buffered for the sink before oldest are dropped. */
	maxPending?: number;
	/** Max distinct models aggregated in memory; overflow folds into "(other)". */
	maxModels?: number;
	/** Separate bounded history for analytics; independent of the recent-event feed. */
	maxAnalyticsEvents?: number;
	now?: () => Date;
};

/** Bucket for aggregates once `maxModels` distinct model ids are tracked. */
export const OVERFLOW_MODEL_KEY = "(other)";

type MutableModelUsage = ModelUsage & { successLatencyTotal: number };

/**
 * Records gateway telemetry. Aggregates live in memory (so the dashboard works
 * with zero infrastructure) and every event is also batched to ClickHouse when
 * a sink is configured. Sink failures never break request handling.
 */
export class TelemetryService {
	private readonly sink?: ClickHouseSink;
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
	) => ModelPricing | undefined;

	private readonly recent: TelemetryEvent[] = [];
	private readonly byModel = new Map<string, MutableModelUsage>();
	private totals = {
		requests: 0,
		errors: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		successLatencyTotal: 0,
	};

	private pending: TelemetryEvent[] = [];
	private timer?: ReturnType<typeof setInterval>;
	private schemaReady = false;
	private flushing?: Promise<boolean>;
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
		if (this.sink) {
			this.timer = setInterval(() => {
				void this.flush();
			}, this.flushIntervalMs);
			this.timer.unref?.();
		}
	}

	/** Records a chat completion (or failure) and returns the stored event. */
	recordChat(chat: ChatTelemetry): TelemetryEvent {
		const pricing = this.pricing?.(chat.model, chat.provider);
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

		this.aggregate(chat);
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
		this.recent.push(event);
		if (this.recent.length > this.maxRecent) {
			this.recent.splice(0, this.recent.length - this.maxRecent);
		}
		if (this.sink) {
			this.pending.push(event);
			if (this.pending.length > this.maxPending) {
				this.durableIncomplete = true;
				this.pending.splice(0, this.pending.length - this.maxPending);
			}
		}
	}

	setPricingResolver(
		resolve: (model: string, provider: string) => ModelPricing | undefined,
	): void {
		this.pricing = resolve;
	}

	async analytics(query: AnalyticsQuery): Promise<UsageAnalytics> {
		const generatedAt = this.now().toISOString();
		if (this.sink && (await this.flush()) && !this.durableIncomplete) {
			try {
				const facts = await this.sink.queryAnalytics(query);
				return buildAnalytics(facts, query, {
					generatedAt,
					source: "clickhouse",
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
					Date.parse(event.timestamp) < to,
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

	private aggregate(chat: ChatTelemetry): void {
		// Bound the map: unadvertised model ids are routable (and typos still
		// get recorded), so distinct keys would otherwise grow forever.
		const key =
			this.byModel.has(chat.model) || this.byModel.size < this.maxModels
				? chat.model
				: OVERFLOW_MODEL_KEY;
		let usage = this.byModel.get(key);
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
			this.byModel.set(key, usage);
		}

		usage.requests += 1;
		this.totals.requests += 1;
		if (chat.error) {
			usage.errors += 1;
			this.totals.errors += 1;
		} else {
			usage.successLatencyTotal += chat.latencyMs;
			this.totals.successLatencyTotal += chat.latencyMs;
		}
		usage.promptTokens += chat.usage.promptTokens;
		usage.completionTokens += chat.usage.completionTokens;
		usage.totalTokens += chat.usage.totalTokens;
		this.totals.promptTokens += chat.usage.promptTokens;
		this.totals.completionTokens += chat.usage.completionTokens;
		this.totals.totalTokens += chat.usage.totalTokens;

		const successes = usage.requests - usage.errors;
		usage.avgLatencyMs =
			successes > 0 ? Math.round(usage.successLatencyTotal / successes) : 0;
	}

	/** In-memory usage summary for the current process lifetime. */
	summary(): UsageSummary {
		const successes = this.totals.requests - this.totals.errors;
		return {
			totalRequests: this.totals.requests,
			totalErrors: this.totals.errors,
			promptTokens: this.totals.promptTokens,
			completionTokens: this.totals.completionTokens,
			totalTokens: this.totals.totalTokens,
			avgLatencyMs:
				successes > 0
					? Math.round(this.totals.successLatencyTotal / successes)
					: 0,
			byModel: [...this.byModel.values()]
				.map(({ successLatencyTotal: _ignored, ...usage }) => usage)
				.sort((a, b) => b.requests - a.requests),
			source: "memory",
		};
	}

	/**
	 * Durable summary from ClickHouse; returns undefined when no sink is
	 * configured, pending events cannot be flushed, or the query fails —
	 * callers fall back to the complete in-memory summary in every case.
	 */
	async summaryFromSink(): Promise<UsageSummary | undefined> {
		if (!this.sink) return undefined;
		// A failed flush means the durable store is missing events we hold in
		// memory — serving its summary would silently under-report.
		if (!(await this.flush())) return undefined;
		try {
			return await this.sink.querySummary();
		} catch {
			return undefined;
		}
	}

	recentEvents(limit = 50): TelemetryEvent[] {
		return this.recent.slice(-limit).reverse();
	}

	get sinkHealthy(): boolean {
		return this.sink?.healthy ?? false;
	}

	get sinkConfigured(): boolean {
		return this.sink !== undefined;
	}

	/** Bootstraps the ClickHouse schema once (also needed before queries). */
	private async ensureSchemaOnce(): Promise<void> {
		if (!this.sink || this.schemaReady) return;
		await this.sink.ensureSchema();
		this.schemaReady = true;
	}

	/**
	 * Ships pending events to ClickHouse. Returns false when events remain
	 * queued (sink failure); they are retried on the next flush tick.
	 */
	async flush(): Promise<boolean> {
		if (this.flushing) {
			if (!(await this.flushing)) return false;
			// Include events queued while a preceding batch was in flight.
			if (this.pending.length === 0) return true;
			return this.flush();
		}
		this.flushing ??= this.flushPending().finally(() => {
			this.flushing = undefined;
		});
		return this.flushing;
	}

	private async flushPending(): Promise<boolean> {
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
				if (batch.length + this.pending.length > this.maxPending)
					this.durableIncomplete = true;
				this.pending = [...batch, ...this.pending].slice(-this.maxPending);
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
		await this.flush().catch(() => {});
	}
}

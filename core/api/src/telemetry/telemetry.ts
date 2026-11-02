import { randomUUID } from "node:crypto";
import type {
	ModelUsage,
	TelemetryEvent,
	TokenUsage,
	UsageSummary,
} from "@autonomo.us/common";
import type { MongoTelemetrySink } from "./mongo.js";

export type ChatTelemetry = {
	operation?: "chat" | "decisions" | "routing";
	/** Canonical routable id, e.g. `anthropic/claude-opus-4-8`. */
	model: string;
	provider: string;
	agentId?: string;
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
	now?: () => Date;
};

/** Bucket for aggregates once `maxModels` distinct model ids are tracked. */
export const OVERFLOW_MODEL_KEY = "(other)";

type MutableModelUsage = ModelUsage & { successLatencyTotal: number };

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
	private flushChain: Promise<boolean> = Promise.resolve(true);

	constructor(options: TelemetryServiceOptions = {}) {
		this.sink = options.sink;
		this.maxRecent = options.maxRecent ?? 100;
		this.flushIntervalMs = options.flushIntervalMs ?? 2000;
		this.maxPending = options.maxPending ?? 5000;
		this.maxModels = options.maxModels ?? 100;
		this.now = options.now ?? (() => new Date());
		if (this.sink && this.flushIntervalMs > 0) {
			this.timer = setInterval(() => {
				this.scheduleFlush();
			}, this.flushIntervalMs);
			this.timer.unref?.();
		}
	}

	/** Records a chat completion (or failure) and returns the stored event. */
	recordChat(chat: ChatTelemetry): TelemetryEvent {
		const event: TelemetryEvent = {
			id: randomUUID(),
			type: chat.error
				? "gateway.error"
				: `gateway.${chat.operation ?? "chat"}`,
			agentId: chat.agentId,
			data: {
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
		this.recent.push(event);
		if (this.recent.length > this.maxRecent) {
			this.recent.splice(0, this.recent.length - this.maxRecent);
		}
		if (this.sink) {
			this.pending.push(event);
			if (this.pending.length > this.maxPending) {
				this.pending.splice(0, this.pending.length - this.maxPending);
			}
			if (this.flushIntervalMs === 0) this.scheduleFlush();
		}
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
	 * Durable summary from MongoDB; returns undefined when no sink is
	 * configured, pending events cannot be flushed, or the query fails —
	 * callers fall back to the complete in-memory summary in every case.
	 */
	async summaryFromSink(): Promise<UsageSummary | undefined> {
		if (!this.sink) return undefined;
		// A failed flush means the durable store is missing events we hold in
		// memory — serving its summary would silently under-report.
		if (!(await this.drain())) return undefined;
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

	/** Bootstraps the MongoDB indexes once (also needed before queries). */
	private async ensureSchemaOnce(): Promise<void> {
		if (!this.sink || this.schemaReady) return;
		await this.sink.ensureSchema();
		this.schemaReady = true;
	}

	private scheduleFlush(): void {
		this.flushChain = this.flushChain.then(() => this.flush());
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
		await this.drain().catch(() => false);
	}

	/** Drops the MongoDB socket so the next request can open a new one. */
	async close(): Promise<void> {
		await this.stop();
		await this.sink?.close();
	}
}

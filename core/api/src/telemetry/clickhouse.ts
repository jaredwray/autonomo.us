import type {
	ModelUsage,
	TelemetryEvent,
	UsageSummary,
} from "@autonomo.us/common";
import type { ClickHouseConfig } from "../config.js";

/** Flattened row shape stored in ClickHouse. */
export type TelemetryRow = {
	id: string;
	type: string;
	agent_id: string;
	model: string;
	provider: string;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	latency_ms: number;
	error: string;
	data: string;
	timestamp: string;
};

type FetchLike = (
	url: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function asNumber(value: unknown): number {
	const parsed = typeof value === "string" ? Number(value) : (value as number);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Converts an ISO 8601 UTC timestamp to ClickHouse DateTime64 input format. */
export function toClickHouseDateTime(iso: string): string {
	return iso.replace("T", " ").replace(/Z$/, "");
}

/** `anthropic/claude-opus-4-8` + provider `anthropic` → `claude-opus-4-8`. */
export function stripProviderPrefix(model: string, provider: string): string {
	return provider && model.startsWith(`${provider}/`)
		? model.slice(provider.length + 1)
		: model;
}

export function eventToRow(event: TelemetryEvent): TelemetryRow {
	const data = event.data;
	return {
		id: event.id,
		type: event.type,
		agent_id: event.agentId ?? "",
		model: typeof data.model === "string" ? data.model : "",
		provider: typeof data.provider === "string" ? data.provider : "",
		prompt_tokens: asNumber(data.promptTokens),
		completion_tokens: asNumber(data.completionTokens),
		total_tokens: asNumber(data.totalTokens),
		latency_ms: asNumber(data.latencyMs),
		error: typeof data.error === "string" ? data.error : "",
		data: JSON.stringify(data),
		timestamp: toClickHouseDateTime(event.timestamp),
	};
}

/**
 * Minimal ClickHouse client over the HTTP interface (port 8123). Uses
 * JSONEachRow for inserts and FORMAT JSON for reads, so it needs no driver
 * dependency and is easy to fake in tests.
 */
export class ClickHouseSink {
	readonly config: ClickHouseConfig;
	private readonly fetchImpl: FetchLike;
	/** False after a failed request until the next successful one. */
	healthy = true;

	constructor(config: ClickHouseConfig, fetchImpl?: FetchLike) {
		this.config = config;
		this.fetchImpl = fetchImpl ?? (fetch as unknown as FetchLike);
	}

	private get table(): string {
		return `${this.config.database}.${this.config.table}`;
	}

	private async request(query: string, body?: string): Promise<string> {
		const url = new URL(this.config.url);
		url.searchParams.set("query", query);
		// UInt64 aggregates come back as JSON numbers instead of strings.
		url.searchParams.set("output_format_json_quote_64bit_integers", "0");

		try {
			const response = await this.fetchImpl(url.toString(), {
				method: "POST",
				headers: {
					"X-ClickHouse-User": this.config.username,
					"X-ClickHouse-Key": this.config.password,
				},
				body,
				// Bound every request so a hung ClickHouse degrades to the
				// in-memory fallback instead of stalling API responses.
				signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 3000),
			});
			const text = await response.text();
			if (!response.ok) {
				throw new Error(
					`ClickHouse request failed (${response.status}): ${text.slice(0, 300)}`,
				);
			}
			this.healthy = true;
			return text;
		} catch (error) {
			this.healthy = false;
			throw error;
		}
	}

	/** Creates the database and telemetry table if they do not exist. */
	async ensureSchema(): Promise<void> {
		await this.request(`CREATE DATABASE IF NOT EXISTS ${this.config.database}`);
		// ReplacingMergeTree keyed on (timestamp, id) deduplicates retried
		// inserts: if an insert commits but its response is lost, the batch is
		// requeued and written again, and the duplicate rows collapse. Reads
		// use FINAL so summaries never double-count.
		await this.request(
			`CREATE TABLE IF NOT EXISTS ${this.table} (
				id String,
				type LowCardinality(String),
				agent_id String,
				model String,
				provider LowCardinality(String),
				prompt_tokens UInt64,
				completion_tokens UInt64,
				total_tokens UInt64,
				latency_ms UInt64,
				error String,
				data String,
				timestamp DateTime64(3, 'UTC')
			) ENGINE = ReplacingMergeTree ORDER BY (timestamp, id)`,
		);
	}

	async insert(events: TelemetryEvent[]): Promise<void> {
		if (events.length === 0) return;
		const body = events
			.map((event) => JSON.stringify(eventToRow(event)))
			.join("\n");
		await this.request(`INSERT INTO ${this.table} FORMAT JSONEachRow`, body);
	}

	async querySummary(): Promise<UsageSummary> {
		const text = await this.request(
			`SELECT
				model,
				provider,
				count() AS requests,
				countIf(error != '') AS errors,
				sum(prompt_tokens) AS prompt_tokens,
				sum(completion_tokens) AS completion_tokens,
				sum(total_tokens) AS total_tokens,
				round(avgIf(latency_ms, error = '')) AS avg_latency_ms
			FROM ${this.table} FINAL
			WHERE type IN ('gateway.chat', 'gateway.error')
			GROUP BY model, provider
			ORDER BY requests DESC
			FORMAT JSON`,
		);
		const parsed = JSON.parse(text) as {
			data: Array<Record<string, unknown>>;
		};
		const byModel: ModelUsage[] = parsed.data.map((row) => ({
			// Rows store the canonical routable id; strip the provider prefix
			// so ModelUsage.model matches the in-memory summary's shape.
			model: stripProviderPrefix(
				String(row.model ?? ""),
				String(row.provider ?? ""),
			),
			provider: String(row.provider ?? ""),
			requests: asNumber(row.requests),
			errors: asNumber(row.errors),
			promptTokens: asNumber(row.prompt_tokens),
			completionTokens: asNumber(row.completion_tokens),
			totalTokens: asNumber(row.total_tokens),
			avgLatencyMs: asNumber(row.avg_latency_ms),
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
			source: "clickhouse",
		};
	}
}

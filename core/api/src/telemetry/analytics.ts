import type {
	AnalyticsBreakdown,
	AnalyticsQuery,
	TelemetryCaller,
	TelemetryEvent,
	UsageAnalytics,
	UsageMetrics,
} from "@autonomo.us/common";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const GATEWAY_EVENT_TYPES = [
	"gateway.chat",
	"gateway.decisions",
	"gateway.routing",
	"gateway.error",
];

/** Additive facts, shared by retained events and durable grouped queries. */
export type AnalyticsFact = Omit<UsageMetrics, "avgLatencyMs"> & {
	timestamp: string;
	model: string;
	provider: string;
	caller: TelemetryCaller;
	operation: string;
	latencyTotal: number;
	lastSeen: string;
};

export function bucketMs(query: AnalyticsQuery): number {
	return Date.parse(query.to) - Date.parse(query.from) <= 2 * DAY_MS
		? HOUR_MS
		: DAY_MS;
}

export function eventCaller(event: TelemetryEvent): TelemetryCaller {
	const data = event.data;
	if (
		typeof data.callerId === "string" &&
		data.callerId &&
		(data.callerKind === "api-token" || data.callerKind === "owner")
	) {
		return {
			id: data.callerId,
			name: String(data.callerName || data.callerId),
			kind: data.callerKind,
		};
	}
	return event.agentId
		? { id: `agent:${event.agentId}`, name: event.agentId, kind: "agent" }
		: { id: "unattributed", name: "Unattributed", kind: "unattributed" };
}

export function eventFact(
	event: TelemetryEvent,
	interval: number,
): AnalyticsFact {
	const number = (key: string) =>
		typeof event.data[key] === "number" && Number.isFinite(event.data[key])
			? Math.max(0, event.data[key] as number)
			: 0;
	const errors = event.type === "gateway.error" || event.data.error ? 1 : 0;
	const priced =
		typeof event.data.estimatedCostUsd === "number" &&
		Number.isFinite(event.data.estimatedCostUsd) &&
		event.data.estimatedCostUsd >= 0;
	return {
		timestamp: new Date(
			Math.floor(Date.parse(event.timestamp) / interval) * interval,
		).toISOString(),
		model: String(event.data.model ?? "Unknown model"),
		provider: String(event.data.provider ?? "Unknown provider"),
		caller: eventCaller(event),
		operation: String(
			event.data.operation ??
				(event.type === "gateway.error" ? "unknown" : event.type.slice(8)),
		),
		requests: 1,
		errors,
		promptTokens: number("promptTokens"),
		completionTokens: number("completionTokens"),
		totalTokens: number("totalTokens"),
		estimatedCostUsd: priced ? number("estimatedCostUsd") : 0,
		pricedRequests: priced ? 1 : 0,
		latencyTotal: errors ? 0 : number("latencyMs"),
		lastSeen: event.timestamp,
	};
}

type Accumulator = Omit<UsageMetrics, "avgLatencyMs"> & {
	latencyTotal: number;
	lastSeen: string;
};
const empty = (): Accumulator => ({
	requests: 0,
	errors: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	estimatedCostUsd: 0,
	pricedRequests: 0,
	latencyTotal: 0,
	lastSeen: "",
});
function add(target: Accumulator, row: AnalyticsFact) {
	for (const key of [
		"requests",
		"errors",
		"promptTokens",
		"completionTokens",
		"totalTokens",
		"estimatedCostUsd",
		"pricedRequests",
		"latencyTotal",
	] as const)
		target[key] += row[key];
	if (row.lastSeen > target.lastSeen) target.lastSeen = row.lastSeen;
}
function metrics(value: Accumulator): UsageMetrics {
	return {
		requests: value.requests,
		errors: value.errors,
		promptTokens: value.promptTokens,
		completionTokens: value.completionTokens,
		totalTokens: value.totalTokens,
		estimatedCostUsd: value.estimatedCostUsd,
		pricedRequests: value.pricedRequests,
		avgLatencyMs:
			value.requests > value.errors
				? Math.round(value.latencyTotal / (value.requests - value.errors))
				: 0,
	};
}

export function buildAnalytics(
	facts: AnalyticsFact[],
	query: AnalyticsQuery,
	metadata: Pick<
		UsageAnalytics,
		"source" | "coverageFrom" | "partial" | "durableUnavailable" | "generatedAt"
	>,
): UsageAnalytics {
	const interval = bucketMs(query);
	const totals = empty();
	const models = new Map<string, Accumulator & { provider: string }>();
	const providers = new Map<string, Accumulator>();
	const callers = new Map<string, Accumulator & { caller: TelemetryCaller }>();
	const operations = new Map<string, Accumulator>();
	const series = new Map<string, Accumulator>();
	const modelOptions = new Map<string, { id: string; provider: string }>();
	const callerOptions = new Map<string, TelemetryCaller>();
	const providerOptions = new Set<string>();
	for (
		let time = Math.floor(Date.parse(query.from) / interval) * interval;
		time < Date.parse(query.to);
		time += interval
	)
		series.set(new Date(time).toISOString(), empty());
	for (const fact of facts) {
		modelOptions.set(fact.model, { id: fact.model, provider: fact.provider });
		callerOptions.set(fact.caller.id, fact.caller);
		providerOptions.add(fact.provider);
		if (
			(query.model && query.model !== fact.model) ||
			(query.provider && query.provider !== fact.provider) ||
			(query.caller && query.caller !== fact.caller.id)
		)
			continue;
		add(totals, fact);
		const model = models.get(fact.model) ?? {
			...empty(),
			provider: fact.provider,
		};
		const provider = providers.get(fact.provider) ?? empty();
		const caller = callers.get(fact.caller.id) ?? {
			...empty(),
			caller: fact.caller,
		};
		const operation = operations.get(fact.operation) ?? empty();
		if (fact.lastSeen >= caller.lastSeen) caller.caller = fact.caller;
		models.set(fact.model, model);
		providers.set(fact.provider, provider);
		callers.set(fact.caller.id, caller);
		operations.set(fact.operation, operation);
		for (const aggregate of [model, provider, caller, operation])
			add(aggregate, fact);
		const point = series.get(fact.timestamp);
		if (point) add(point, fact);
	}
	const breakdown = (
		id: string,
		value: Accumulator,
		name = id,
	): AnalyticsBreakdown => ({
		id,
		name,
		...metrics(value),
		lastSeen: value.lastSeen,
	});
	const sorted = (rows: AnalyticsBreakdown[]) =>
		rows.sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id));
	return {
		...metadata,
		query,
		bucket: interval === HOUR_MS ? "hour" : "day",
		totals: metrics(totals),
		activeCallers: [...callers.values()].filter(
			(row) => row.caller.kind !== "unattributed",
		).length,
		unattributedRequests: callers.get("unattributed")?.requests ?? 0,
		byModel: sorted(
			[...models].map(([id, value]) => ({
				...breakdown(id, value),
				provider: value.provider,
			})),
		),
		byProvider: sorted(
			[...providers].map(([id, value]) => breakdown(id, value)),
		),
		byCaller: sorted(
			[...callers].map(([id, value]) => ({
				...breakdown(id, value, value.caller.name),
				kind: value.caller.kind,
			})),
		),
		byOperation: sorted(
			[...operations].map(([id, value]) => breakdown(id, value)),
		),
		series: [...series].map(([timestamp, value]) => ({
			timestamp,
			...metrics(value),
		})),
		options: {
			models: [...modelOptions.values()].sort((a, b) =>
				a.id.localeCompare(b.id),
			),
			providers: [...providerOptions].sort(),
			callers: [...callerOptions.values()].sort((a, b) =>
				a.name.localeCompare(b.name),
			),
		},
	};
}

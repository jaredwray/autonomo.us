import type {
	AnalyticsBreakdown,
	AnalyticsQuery,
	TelemetryCaller,
	TelemetryEvent,
	UsageAnalytics,
	UsageMetrics,
	WebAnalytics,
	WebBreakdown,
	WebUsageMetrics,
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

/**
 * Caller kinds the gateway sets itself: a credential, a team member, or an
 * agent it authenticated (an agent token, an OAuth app, or a bot it runs).
 */
export const RECORDED_CALLER_KINDS = [
	"api-token",
	"owner",
	"user",
	"agent",
] as const;

/**
 * Who made a call. A caller the gateway recorded wins over a client-supplied
 * agent id, and an agent it recorded keeps its name. History from before
 * callers were recorded falls back to the agent id, named by that id.
 */
export function eventCaller(event: TelemetryEvent): TelemetryCaller {
	const data = event.data;
	const kind = RECORDED_CALLER_KINDS.find((item) => item === data.callerKind);
	if (
		kind &&
		typeof data.callerId === "string" &&
		data.callerId &&
		// Agents are always `agent:<id>`, so old and new history merge.
		(kind !== "agent" || data.callerId.startsWith("agent:"))
	) {
		return {
			id: data.callerId,
			name: String(data.callerName || data.callerId),
			kind,
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
	web: WebFacts = noWebFacts(),
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
	// Someone who only fetches pages is still a caller to filter by.
	for (const caller of webCallers(web)) callerOptions.set(caller.id, caller);
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
		web: buildWebAnalytics(web, query),
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

/** Web fetches are recorded beside model calls and reported apart from them. */
export const WEB_EVENT_TYPE = "gateway.web";

/** Additive counts of fetches, shared by retained events and durable queries. */
type WebCounts = {
	fetches: number;
	succeeded: number;
	proxied: number;
	cached: number;
	costUsd: number;
	/** Over fetches that returned a page. */
	latencyTotal: number;
	lastSeen: string;
};
export type WebFetchFact = WebCounts & {
	caller: TelemetryCaller;
	outcome: string;
};
/**
 * One site's fetches. `caller` is set when the facts are per caller (memory);
 * MongoDB groups by site alone, already filtered to the query's caller, so
 * that a crawling agent cannot exceed the grouping limit.
 */
export type WebHostFact = WebCounts & {
	host: string;
	caller?: TelemetryCaller;
};
export type WebStepFact = {
	connection: string;
	caller: TelemetryCaller;
	attempts: number;
	succeeded: number;
	costUsd: number;
	lastSeen: string;
};
export type WebFacts = {
	fetches: WebFetchFact[];
	hosts: WebHostFact[];
	steps: WebStepFact[];
	/**
	 * Fetches recorded before the gateway kept how they ended and what they
	 * cost, by caller. They are left out of every number rather than counted
	 * as free failures, and reported as a count instead, which the caller
	 * filter applies to like the rest.
	 */
	legacy: Array<{
		/** Unset when the count was already filtered to the query's caller. */
		caller?: TelemetryCaller;
		fetches: number;
	}>;
};
export const noWebFacts = (): WebFacts => ({
	fetches: [],
	hosts: [],
	steps: [],
	legacy: [],
});

const nonNegative = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

/** `zenrows:auto` → `zenrows`; `direct` stays `direct`. */
export const stepConnection = (step: string) => step.split(":")[0] || "direct";

/**
 * Whether a recorded web event carries the details analytics need. Older
 * events, written before fetches recorded their outcome, do not.
 */
export const webEventDetailed = (event: TelemetryEvent) =>
	typeof event.data.outcome === "string" && event.data.outcome !== "";

/**
 * One retained web event as facts. Steps that were skipped (a spent budget,
 * a missing key, a back-off) made no request and are not counted.
 */
export function webEventFacts(event: TelemetryEvent): WebFacts {
	const caller = eventCaller(event);
	if (!webEventDetailed(event))
		return { ...noWebFacts(), legacy: [{ caller, fetches: 1 }] };
	const data = event.data;
	const ok = data.ok === true;
	const counts: WebCounts = {
		fetches: 1,
		succeeded: ok ? 1 : 0,
		proxied: data.proxied === true ? 1 : 0,
		cached: data.cached === true ? 1 : 0,
		costUsd: nonNegative(data.costUsd),
		latencyTotal: ok ? nonNegative(data.latencyMs) : 0,
		lastSeen: event.timestamp,
	};
	const attempts = Array.isArray(data.attempts) ? data.attempts : [];
	return {
		fetches: [{ ...counts, caller, outcome: data.outcome as string }],
		hosts: [
			{
				...counts,
				host:
					typeof data.host === "string" && data.host
						? data.host
						: "Unknown site",
				caller,
			},
		],
		steps: attempts
			.filter(
				(attempt): attempt is Record<string, unknown> =>
					Boolean(attempt) &&
					typeof attempt === "object" &&
					typeof (attempt as { step?: unknown }).step === "string" &&
					(attempt as { outcome?: unknown }).outcome !== "skipped",
			)
			.map((attempt) => ({
				connection: stepConnection(attempt.step as string),
				caller,
				attempts: 1,
				succeeded: attempt.outcome === "ok" ? 1 : 0,
				costUsd: nonNegative(attempt.costUsd),
				lastSeen: event.timestamp,
			})),
		legacy: [],
	};
}

const emptyWeb = (): WebCounts => ({
	fetches: 0,
	succeeded: 0,
	proxied: 0,
	cached: 0,
	costUsd: 0,
	latencyTotal: 0,
	lastSeen: "",
});
function addWeb(target: WebCounts, row: WebCounts) {
	for (const key of [
		"fetches",
		"succeeded",
		"proxied",
		"cached",
		"costUsd",
		"latencyTotal",
	] as const)
		target[key] += row[key];
	if (row.lastSeen > target.lastSeen) target.lastSeen = row.lastSeen;
}
function webMetrics(value: WebCounts): WebUsageMetrics {
	return {
		fetches: value.fetches,
		succeeded: value.succeeded,
		proxied: value.proxied,
		cached: value.cached,
		costUsd: value.costUsd,
		avgLatencyMs: value.succeeded
			? Math.round(value.latencyTotal / value.succeeded)
			: 0,
	};
}
/** The order sites and callers are listed in; MongoDB sorts sites the same way. */
const byFetches = (a: WebBreakdown, b: WebBreakdown) =>
	b.fetches - a.fetches || b.costUsd - a.costUsd || a.id.localeCompare(b.id);
export const WEB_TOP_SITES = 10;

/** Web usage for a window. Only the caller filter applies. */
export function buildWebAnalytics(
	facts: WebFacts,
	query: AnalyticsQuery,
): WebAnalytics {
	const keep = (caller: TelemetryCaller | undefined) =>
		!query.caller || !caller || query.caller === caller.id;
	const totals = emptyWeb();
	const callers = new Map<string, WebCounts & { caller: TelemetryCaller }>();
	const outcomes = new Map<string, number>();
	for (const fact of facts.fetches) {
		if (!keep(fact.caller)) continue;
		addWeb(totals, fact);
		const caller = callers.get(fact.caller.id) ?? {
			...emptyWeb(),
			caller: fact.caller,
		};
		if (fact.lastSeen >= caller.lastSeen) caller.caller = fact.caller;
		addWeb(caller, fact);
		callers.set(fact.caller.id, caller);
		outcomes.set(
			fact.outcome,
			(outcomes.get(fact.outcome) ?? 0) + fact.fetches,
		);
	}
	const hosts = new Map<string, WebCounts>();
	for (const fact of facts.hosts) {
		if (!keep(fact.caller)) continue;
		const host = hosts.get(fact.host) ?? emptyWeb();
		addWeb(host, fact);
		hosts.set(fact.host, host);
	}
	const connections = new Map<
		string,
		Omit<WebStepFact, "connection" | "caller">
	>();
	for (const fact of facts.steps) {
		if (!keep(fact.caller)) continue;
		const row = connections.get(fact.connection) ?? {
			attempts: 0,
			succeeded: 0,
			costUsd: 0,
			lastSeen: "",
		};
		row.attempts += fact.attempts;
		row.succeeded += fact.succeeded;
		row.costUsd += fact.costUsd;
		if (fact.lastSeen > row.lastSeen) row.lastSeen = fact.lastSeen;
		connections.set(fact.connection, row);
	}
	return {
		totals: webMetrics(totals),
		byCaller: [...callers]
			.map(([id, value]) => ({
				id,
				name: value.caller.name,
				kind: value.caller.kind,
				...webMetrics(value),
				lastSeen: value.lastSeen,
			}))
			.sort(byFetches),
		byConnection: [...connections]
			.map(([id, value]) => ({ id, ...value }))
			.sort(
				(a, b) =>
					b.attempts - a.attempts ||
					b.costUsd - a.costUsd ||
					a.id.localeCompare(b.id),
			),
		byOutcome: [...outcomes]
			.map(([id, fetches]) => ({ id, fetches }))
			.sort((a, b) => b.fetches - a.fetches || a.id.localeCompare(b.id)),
		byHost: [...hosts]
			.map(([id, value]) => ({
				id,
				name: id,
				...webMetrics(value),
				lastSeen: value.lastSeen,
			}))
			.sort(byFetches)
			.slice(0, WEB_TOP_SITES),
		legacyFetches: facts.legacy.reduce(
			(total, row) => total + (keep(row.caller) ? row.fetches : 0),
			0,
		),
	};
}

/** Callers seen in web facts, for the caller filter's choices. */
export function webCallers(facts: WebFacts): TelemetryCaller[] {
	const seen = new Map<string, { caller: TelemetryCaller; lastSeen: string }>();
	for (const fact of facts.fetches) {
		const known = seen.get(fact.caller.id);
		if (!known || fact.lastSeen >= known.lastSeen)
			seen.set(fact.caller.id, {
				caller: fact.caller,
				lastSeen: fact.lastSeen,
			});
	}
	return [...seen.values()].map((item) => item.caller);
}

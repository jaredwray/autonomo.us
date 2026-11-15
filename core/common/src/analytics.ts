/** Caller identities are credentials, team members, or reported agents. */
export type TelemetryCaller = {
	id: string;
	name: string;
	/** `owner` appears only in history from before team accounts. */
	kind: "api-token" | "owner" | "user" | "agent" | "unattributed";
};

export type ModelPricing = {
	/** USD per million tokens, from the catalog at recording time. */
	input: number;
	output: number;
};

export type AnalyticsQuery = {
	from: string;
	to: string;
	provider?: string;
	model?: string;
	caller?: string;
};

export type UsageMetrics = {
	requests: number;
	errors: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Sum for priced calls only; inspect pricedRequests before displaying. */
	estimatedCostUsd: number;
	pricedRequests: number;
	avgLatencyMs: number;
};

export type AnalyticsBreakdown = UsageMetrics & {
	id: string;
	name: string;
	provider?: string;
	kind?: TelemetryCaller["kind"];
	lastSeen: string;
};

export type UsageAnalytics = {
	query: AnalyticsQuery;
	generatedAt: string;
	source: "memory" | "mongodb";
	/** Memory only: earliest retained coverage, including process restarts. */
	coverageFrom: string | null;
	partial: boolean;
	durableUnavailable: boolean;
	bucket: "hour" | "day";
	totals: UsageMetrics;
	activeCallers: number;
	unattributedRequests: number;
	byModel: AnalyticsBreakdown[];
	byProvider: AnalyticsBreakdown[];
	byCaller: AnalyticsBreakdown[];
	byOperation: AnalyticsBreakdown[];
	series: Array<UsageMetrics & { timestamp: string }>;
	/** Web fetches in the same window; model and connection filters do not apply. */
	web: WebAnalytics;
	options: {
		models: Array<{ id: string; provider: string }>;
		providers: string[];
		callers: TelemetryCaller[];
	};
};

/**
 * Web fetches (`web_fetch`), counted apart from model calls: a fetch is one
 * page an agent, person, or token asked for, however many steps it took.
 */
export type WebUsageMetrics = {
	/** Fetches asked for, cached answers included. */
	fetches: number;
	/** Fetches that returned a page. */
	succeeded: number;
	/** Fetches that tried at least one proxy step. */
	proxied: number;
	/** Fetches answered from the gateway's cache, at no cost. */
	cached: number;
	/** What the proxies charged, as reported or estimated. */
	costUsd: number;
	/** Mean time of fetches that returned a page. */
	avgLatencyMs: number;
};

export type WebBreakdown = WebUsageMetrics & {
	id: string;
	name: string;
	kind?: TelemetryCaller["kind"];
	lastSeen: string;
};

/** Steps through one proxy connection, or `direct` for plain requests. */
export type WebConnectionUsage = {
	id: string;
	/** Steps tried through it; one fetch can try several connections. */
	attempts: number;
	/** Steps that returned the page. */
	succeeded: number;
	costUsd: number;
	lastSeen: string;
};

export type WebAnalytics = {
	totals: WebUsageMetrics;
	/** Only the caller filter applies: web fetches have no model or connection. */
	byCaller: WebBreakdown[];
	byConnection: WebConnectionUsage[];
	/** How fetches ended: `ok`, or the last step's outcome, such as `blocked`. */
	byOutcome: Array<{ id: string; fetches: number }>;
	/** The sites fetched most, at most ten. */
	byHost: WebBreakdown[];
	series: Array<WebUsageMetrics & { timestamp: string }>;
};

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
	options: {
		models: Array<{ id: string; provider: string }>;
		providers: string[];
		callers: TelemetryCaller[];
	};
};

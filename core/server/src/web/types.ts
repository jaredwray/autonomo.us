import type {
	ProxyKind,
	ProxyLevel,
	WebFetchFormat,
	WebFetchOutcome,
} from "@autonomo.us/common";

/** A step that got the page. */
export type StepSuccess = {
	outcome: "ok";
	/** The site's status. */
	status: number;
	finalUrl: string;
	contentType: string;
	/** The page as text, in the form `contentFormat` names. */
	content: string;
	/** `text` is a non-HTML text type (JSON, plain text) returned as it came. */
	contentFormat: "html" | "markdown" | "text";
	costUsd: number;
	detail?: string;
};

/** A step that did not get the page, and what the ladder should make of it. */
export type StepFailure = {
	outcome: Exclude<WebFetchOutcome, "ok" | "skipped">;
	/** The site's status when the step could tell, otherwise null. */
	status: number | null;
	costUsd: number;
	/** Short and safe to show an agent: never a key or a provider URL. */
	detail: string;
	/** False when the provider charged nothing, so a reserved unit is given back. */
	billed: boolean;
	/** A problem with the connection itself that a person has to fix. */
	problem?: "key" | "credits" | "blocked";
	/** The provider asked the gateway to slow down (concurrency or rate limit). */
	retryAfterMs?: number;
};

export type StepResult = StepSuccess | StepFailure;

/** One call to a provider. The URL has already passed `checkTargetUrl`. */
export type ProxyCall = {
	url: string;
	level: ProxyLevel;
	format: WebFetchFormat;
	country?: string;
	/** Aborted at the fetch's deadline. */
	signal: AbortSignal;
};

/** A connection as the server holds it, secrets included. Never sent to a client. */
export type ProxyConfig = {
	name: string;
	kind: ProxyKind;
	apiKey?: string;
	accountId?: string;
	zone?: string;
	country?: string;
	pricePer1000Usd?: number;
	enabled: boolean;
	monthlyRequestCap: number | null;
	/** Environment connections only: another endpoint, for tests. */
	baseUrl?: string;
};

export type FetchLike = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

/** One provider kind: how to call it and how to read its answer. */
export interface ProxyAdapter {
	readonly kind: ProxyKind;
	/** The most one call at `level` can cost, reserved against the budget before the call. */
	maxCostUsd(config: ProxyConfig, level: ProxyLevel): number;
	fetch(
		config: ProxyConfig,
		call: ProxyCall,
		fetchImpl: FetchLike,
	): Promise<StepResult>;
}

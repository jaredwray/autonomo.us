/**
 * Web access for agents: the `web_fetch` tool and the proxies a workspace
 * adds for pages that block plain requests or need a browser. See
 * docs/WEB_PROXIES_PLAN.md.
 */

/** Provider kinds a proxy connection can be. */
export const PROXY_KINDS = [
	"zenrows",
	"cloudflare-browser",
	"brightdata",
] as const;
export type ProxyKind = (typeof PROXY_KINDS)[number];

export const PROXY_KIND_LABELS: Record<ProxyKind, string> = {
	zenrows: "ZenRows",
	"cloudflare-browser": "Cloudflare Browser Run",
	brightdata: "Bright Data Web Unlocker",
};

/**
 * How hard a step tries. ZenRows: `auto` lets ZenRows pick rendering and
 * proxies and bills only what worked; the others are fixed settings.
 * Cloudflare Browser Run only renders. Bright Data only unlocks.
 */
export type ProxyLevel =
	| "auto"
	| "basic"
	| "render"
	| "premium"
	| "render-premium"
	| "unlock";

export const PROXY_LEVELS: Record<ProxyKind, readonly ProxyLevel[]> = {
	zenrows: ["auto", "basic", "render", "premium", "render-premium"],
	"cloudflare-browser": ["render"],
	brightdata: ["unlock"],
};

/** The level a new ladder step uses for each kind. */
export const DEFAULT_PROXY_LEVEL: Record<ProxyKind, ProxyLevel> = {
	zenrows: "auto",
	"cloudflare-browser": "render",
	brightdata: "unlock",
};

/**
 * Which failures a step can fix. A renderer runs JavaScript but does not get
 * past bot protection; an unblocker does both.
 */
export function levelFixes(
	kind: ProxyKind,
	level: ProxyLevel,
): ReadonlyArray<"blocked" | "needs-render"> {
	if (kind === "cloudflare-browser") return ["needs-render"];
	if (kind === "brightdata") return ["blocked", "needs-render"];
	switch (level) {
		case "basic":
			return ["blocked"];
		case "render":
			return ["needs-render"];
		default:
			return ["blocked", "needs-render"];
	}
}

/** Whether a step's level runs JavaScript. */
export function levelRenders(kind: ProxyKind, level: ProxyLevel): boolean {
	return levelFixes(kind, level).includes("needs-render");
}

export const PROXY_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const COUNTRY_PATTERN = /^[a-z]{2}$/;

export const WEB_LIMITS = {
	/** Proxy connections per workspace. */
	connections: 20,
	/** Steps in a ladder, `direct` included. */
	ladderSteps: 12,
	domainRules: 200,
	urlLength: 2048,
	minChars: 1000,
	defaultMaxChars: 20_000,
	maxChars: 100_000,
	maxCallerProxyRequestsPerDay: 100_000,
	maxMonthlyBudgetUsd: 100_000,
	maxMonthlyRequestCap: 10_000_000,
	keyLength: 4096,
} as const;

/** A step of the ladder: a plain request, or a connection at a level. */
export type WebStep =
	| { kind: "direct" }
	| { kind: "proxy"; connection: string; level: ProxyLevel };

export type WebDomainRule = {
	/** A host such as `example.com`; it matches the host and its subdomains. */
	match: string;
	/**
	 * `deny`: never fetched. `start-at-proxy`: skip the plain request.
	 * `direct-only`: never sent to a proxy. `allow`: listed for `allowOnly`.
	 */
	rule: "deny" | "start-at-proxy" | "direct-only" | "allow";
};

/** One workspace's web settings. */
export type WebPolicy = {
	ladder: WebStep[];
	domains: WebDomainRule[];
	/** Only domains with a rule other than `deny` may be fetched. */
	allowOnly: boolean;
	/** Proxied requests one person, token, or agent may make in a UTC day. Bots use their own limit. */
	callerProxyRequestsPerDay: number;
	/** What every proxy together may spend in a calendar month (UTC), in US dollars. */
	monthlyBudgetUsd: number;
	revision: number;
};

export const DEFAULT_WEB_POLICY: Omit<WebPolicy, "revision"> = {
	ladder: [{ kind: "direct" }],
	domains: [],
	allowOnly: false,
	callerProxyRequestsPerDay: 100,
	monthlyBudgetUsd: 25,
};

export type UpdateWebPolicyRequest = Omit<WebPolicy, "revision"> & {
	/** The revision the caller read; a stale one is refused with 409. */
	revision: number;
};

/** Something wrong with a connection that a person has to fix. */
export type ProxyProblem = {
	kind: "key" | "credits" | "blocked";
	detail: string;
	at: string;
};

/** A connection as the dashboard and API see it. Never the key. */
export type ProxyConnection = {
	name: string;
	kind: ProxyKind;
	keyConfigured: boolean;
	/** Cloudflare only. */
	accountId?: string;
	/** Bright Data only: the Web Unlocker zone. */
	zone?: string;
	/** ISO 3166-1 alpha-2, lower case, where the kind supports it. */
	country?: string;
	/** Bright Data only: what 1,000 successful requests cost on your plan. */
	pricePer1000Usd?: number;
	enabled: boolean;
	/** Requests this connection may make in a calendar month (UTC); null for no cap. */
	monthlyRequestCap: number | null;
	source: "saved" | "environment";
	usage: { month: string; requests: number; costUsd: number };
	problem: ProxyProblem | null;
};

export type CreateProxyRequest = {
	name: string;
	kind: ProxyKind;
	apiKey: string;
	accountId?: string;
	zone?: string;
	country?: string;
	pricePer1000Usd?: number;
	monthlyRequestCap?: number | null;
	enabled?: boolean;
};

/** Fields to change. `apiKey` omitted keeps the saved key. */
export type UpdateProxyRequest = Partial<
	Omit<CreateProxyRequest, "name" | "kind">
>;

export type ProxyList = {
	connections: ProxyConnection[];
	policy: WebPolicy;
	budget: { month: string; spentUsd: number; limitUsd: number };
	persistence: "mongodb" | "memory";
	/** False when the gateway's operator turned web access off (`WEB_FETCH_DISABLED`). */
	available: boolean;
};

export type WebFetchFormat = "markdown" | "html";

export type WebFetchRequest = {
	url: string;
	format?: WebFetchFormat;
	maxChars?: number;
	/** The caller was already blocked on this URL: start at the first proxy. */
	skipDirect?: boolean;
	/** The page needs JavaScript: skip steps that do not run it. */
	render?: boolean;
};

export type ProxyTestRequest = {
	url?: string;
	level?: ProxyLevel;
};

export type WebFetchOutcome =
	| "ok"
	| "blocked"
	| "needs-render"
	| "not-found"
	| "target-error"
	| "provider-error"
	| "timeout"
	| "skipped";

export type WebFetchAttempt = {
	step: WebStep;
	outcome: WebFetchOutcome;
	/** The site's status, as far as the step could tell. */
	status: number | null;
	latencyMs: number;
	/** 0 for a plain request; an estimate for Cloudflare. */
	costUsd: number;
	/** Short, and never a key or a provider URL. */
	detail?: string;
};

export type WebFetchResult = {
	url: string;
	finalUrl: string;
	/** 0 when nothing was fetched. */
	status: number;
	ok: boolean;
	contentType: string;
	format: WebFetchFormat;
	content: string;
	truncated: boolean;
	/** `direct`, `zenrows:auto`, or `cache`. Empty when nothing worked. */
	via: string;
	attempts: WebFetchAttempt[];
	cached: boolean;
	costUsd: number;
	/** Why nothing was returned, when `ok` is false. */
	reason?: string;
};

/** A label for a step, such as `direct` or `zenrows:auto`. */
export function stepLabel(step: WebStep): string {
	return step.kind === "direct" ? "direct" : `${step.connection}:${step.level}`;
}

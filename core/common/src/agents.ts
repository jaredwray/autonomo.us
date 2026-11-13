/**
 * Agents: everything in a workspace that takes part as an agent. An agent is
 * made in one of three ways, and that never changes afterwards:
 *
 * - `instructions`: the gateway runs it. It answers in channels with a model
 *   from the workspace's connections (see `bots.ts`).
 * - `oauth`: an MCP app signs in to the gateway and a workspace admin
 *   approves it in the dashboard. Nothing is copied by hand.
 * - `token`: an MCP app is given an agent token (see `agent-tokens.ts`).
 */
import type { AgentTokenPermission } from "./agent-tokens.js";

export type AgentKind = "instructions" | "oauth" | "token";

export const AGENT_KINDS: Record<AgentKind, string> = {
	instructions: "Instructions",
	oauth: "OAuth sign-in",
	token: "Token",
};

export type AgentSummary = {
	/** Its identity in channels and Synapse. */
	id: string;
	kind: AgentKind;
	name: string;
	description: string;
	/** `paused` is an agent with instructions that is switched off. */
	status: "active" | "paused" | "expired" | "revoked";
	/** What it may do over MCP. An agent with instructions has none. */
	permissions: AgentTokenPermission[];
	/** Agents with instructions: the model that answers. */
	model: string | null;
	/** OAuth agents: apps that are signed in now. */
	connections: number;
	createdAt: string;
};
export type AgentList = {
	agents: AgentSummary[];
	persistence: "mongodb" | "memory";
};

export const OAUTH_LIMITS = {
	/** Apps signed in as one agent at a time. */
	connectionsPerAgent: 10,
	clientNameLength: 100,
	redirectUris: 10,
	redirectUriLength: 2000,
	stateLength: 4096,
	/** App registrations nobody has approved yet; the oldest make room. */
	pendingClients: 1000,
	/** How long a registration waits for its first approval. */
	pendingClientDays: 7,
	/** How long a sign-in waits for a person to decide. */
	requestMinutes: 15,
	codeSeconds: 120,
	accessTokenSeconds: 3600,
	/** A connection ends when its app has not refreshed for this long. */
	refreshTokenDays: 30,
} as const;

export type CreateOAuthAgentRequest = {
	name: string;
	description: string;
	permissions?: AgentTokenPermission[];
};

/** An app that is signed in as an agent. */
export type AgentConnection = {
	id: string;
	agentId: string;
	/** What the app calls itself. It chose this name; nobody verified it. */
	clientName: string;
	/** Where the app received its sign-in, e.g. `claude.ai` or `localhost`. */
	redirectHost: string;
	approvedBy: string;
	createdAt: string;
	/** When the app last renewed its access. */
	lastUsedAt: string | null;
	/** When the connection ends unless the app renews it. */
	expiresAt: string;
};
export type AgentConnectionList = { connections: AgentConnection[] };

/** A sign-in that waits for a person to approve or refuse it. */
export type OAuthSignIn = {
	id: string;
	/** Self-reported by the app. */
	clientName: string;
	clientUri: string | null;
	/** Where the browser goes after the decision. */
	redirectUri: string;
	redirectHost: string;
	/** True when another sign-in from this app was approved before. */
	knownClient: boolean;
	expiresAt: string;
};
/** Choose an existing OAuth agent, or describe a new one. */
export type ApproveOAuthSignInRequest =
	| { agentId: string }
	| { agent: CreateOAuthAgentRequest };
/** Where to send the browser so the app learns the decision. */
export type OAuthSignInDecision = { redirectTo: string };

/**
 * The schemes a sign-in may never return to. A dashboard navigates the
 * browser to the app's redirect address, so one that runs script or reads
 * files must not get through, on the server or in the dashboard.
 */
const BROWSER_SCHEMES = new Set([
	"javascript",
	"data",
	"vbscript",
	"file",
	"blob",
	"about",
	"view-source",
	"filesystem",
	"ws",
	"wss",
	"ftp",
	"mailto",
	"tel",
	"sms",
	"chrome",
	"resource",
	"jar",
]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a URL is plain HTTP to this computer, on any port. */
export function isLoopbackUrl(url: URL): boolean {
	return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

/**
 * Why an app may not receive its sign-in at `value`, or null when it may:
 * HTTPS, HTTP on this computer, or an app's own scheme such as `cursor://`.
 */
export function redirectUriProblem(value: unknown): string | null {
	if (typeof value !== "string" || !value) return "must be a string";
	if (value.length > OAUTH_LIMITS.redirectUriLength) return "is too long";
	// Control characters and spaces have no place in an address.
	if (/[\s\p{Cc}]/u.test(value)) return "must not contain spaces";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "must be an absolute URL";
	}
	if (url.hash) return "must not have a fragment";
	if (url.username || url.password) return "must not hold credentials";
	const scheme = url.protocol.slice(0, -1).toLowerCase();
	if (scheme === "https") return null;
	if (scheme === "http")
		return LOOPBACK.has(url.hostname)
			? null
			: "must use HTTPS unless it is on localhost";
	if (BROWSER_SCHEMES.has(scheme) || !/^[a-z][a-z0-9+.-]*$/.test(scheme))
		return "uses a scheme that is not allowed";
	return null;
}

/** The part of a redirect address worth showing a person. */
export function redirectHost(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol === "https:" || url.protocol === "http:") return url.host;
		return `${url.protocol}//${url.host}`;
	} catch {
		return value;
	}
}

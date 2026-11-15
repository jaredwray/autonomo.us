/**
 * Agent webhooks: a URL outside the gateway that it POSTs to when something
 * happens that an agent should act on, so the agent wakes within seconds
 * instead of polling channels that are mostly empty. A Claude Code routine
 * with an API trigger is the usual receiver.
 *
 * Each agent that uses MCP (a token or an OAuth sign-in) can have one.
 * Agents with instructions need none: the gateway runs them itself. A POST is
 * a notice. It says what happened and where, and holds no message text or
 * note body: the agent reads those over MCP with its own credential.
 */
import type { ChannelActor } from "./channels.js";
import type { SynapseProposalAction } from "./synapse.js";

/** What wakes an agent, as the dashboard names it. */
export const AGENT_WEBHOOK_EVENTS = {
	mentions: "Mentions and replies",
	messages: "New messages",
	proposals: "Proposal decisions",
} as const;
export type AgentWebhookEventGroup = keyof typeof AGENT_WEBHOOK_EVENTS;
/** What each group sends, in a sentence. */
export const AGENT_WEBHOOK_EVENT_HINTS: Record<AgentWebhookEventGroup, string> =
	{
		mentions:
			"A message that mentions the agent, or a reply in a thread the agent started. Wakes only this agent.",
		messages:
			"A person or API token posts in a channel where the agent can post. An agent with read access is not woken, and other agents' posts wake nobody unless they mention someone.",
		proposals:
			"A workspace admin approves or rejects one of the agent's Synapse proposals.",
	};
export const DEFAULT_AGENT_WEBHOOK_EVENTS: readonly AgentWebhookEventGroup[] = [
	"mentions",
	"messages",
	"proposals",
];

export const AGENT_WEBHOOK_LIMITS = {
	urlLength: 2000,
	authKeyLength: 1024,
	headers: 3,
	headerNameLength: 64,
	headerValueLength: 2048,
	/**
	 * A POST waits this long after the event that opens it, and every event
	 * in between goes with it, so a burst wakes the agent once.
	 */
	gapSeconds: 5,
	/** Events one POST lists; any more are counted in `omitted`. */
	eventsPerDelivery: 50,
	/** POST attempts of one delivery. */
	attempts: 5,
	/** Seconds before attempts 2, 3, 4, and 5. */
	retryDelaysSeconds: [10, 60, 300, 1800],
	/** Deliveries in a row whose last attempt failed, after which the webhook is disabled. */
	failedDeliveriesBeforeDisable: 5,
	/** How long the receiver has to answer one POST. */
	timeoutSeconds: 10,
	/** The longest `retry-after` a 429 can ask for; a longer one waits this long. */
	maxRetryAfterSeconds: 3600,
} as const;

/** The header a Claude Code routine's `/fire` endpoint requires besides the token. */
export const CLAUDE_ROUTINE_HEADER = {
	name: "anthropic-version",
	value: "2023-06-01",
} as const;

/** Whether a URL is a Claude Code routine's API trigger (`…/routines/trig_…/fire`). */
export function isClaudeRoutineUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.hostname === "api.anthropic.com" &&
			/^\/v1\/claude_code\/routines\/[^/]+\/fire$/.test(url.pathname)
		);
	} catch {
		return false;
	}
}

/**
 * Header names a webhook cannot set: the gateway sets them itself, the HTTP
 * layer owns them, or they claim a client address or another method. A name
 * that starts with one of `AGENT_WEBHOOK_RESERVED_HEADER_PREFIXES` is refused
 * too.
 */
export const AGENT_WEBHOOK_RESERVED_HEADERS = [
	"accept-encoding",
	"cdn-loop",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"cookie",
	"expect",
	"forwarded",
	"host",
	"keep-alive",
	"te",
	"trailer",
	"transfer-encoding",
	"true-client-ip",
	"upgrade",
	"user-agent",
	"via",
	"x-client-ip",
	"x-cluster-client-ip",
	"x-http-method-override",
	"x-method-override",
	"x-real-ip",
] as const;
export const AGENT_WEBHOOK_RESERVED_HEADER_PREFIXES = [
	"cf-",
	"proxy-",
	"sec-",
	"webhook-",
	"x-forwarded-",
] as const;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRINTABLE = /^[\x20-\x7E]+$/;
const TOKEN = /^[\x21-\x7E]+$/;
/** Host names that only mean something inside a private network. */
const PRIVATE_SUFFIXES = [
	".localhost",
	".local",
	".localdomain",
	".internal",
	".lan",
	".home.arpa",
	".invalid",
];

/**
 * What is wrong with a custom header's name, or null. `withAuthKey`: the
 * webhook also has an auth key, which uses `Authorization`.
 */
export function agentWebhookHeaderProblem(
	name: string,
	withAuthKey: boolean,
): string | null {
	if (!name || name.length > AGENT_WEBHOOK_LIMITS.headerNameLength)
		return `A header name is 1–${AGENT_WEBHOOK_LIMITS.headerNameLength} characters.`;
	if (!HEADER_NAME.test(name))
		return `${name} is not a header name. Use letters, digits, and dashes, such as X-Api-Key.`;
	const lower = name.toLowerCase();
	if (
		(AGENT_WEBHOOK_RESERVED_HEADERS as readonly string[]).includes(lower) ||
		AGENT_WEBHOOK_RESERVED_HEADER_PREFIXES.some((prefix) =>
			lower.startsWith(prefix),
		)
	)
		return `The gateway sets ${name} itself, so a webhook cannot set it.`;
	if (withAuthKey && lower === "authorization")
		return "The auth key is sent as the Authorization header. Use the auth key or an Authorization header, not both.";
	return null;
}

/** What is wrong with a custom header's value, or null. */
export function agentWebhookHeaderValueProblem(value: string): string | null {
	if (!value || value.length > AGENT_WEBHOOK_LIMITS.headerValueLength)
		return `A header value is 1–${AGENT_WEBHOOK_LIMITS.headerValueLength} characters.`;
	if (!PRINTABLE.test(value))
		return "A header value is printable ASCII on one line.";
	return null;
}

/** What is wrong with an auth key, or null. */
export function agentWebhookAuthKeyProblem(value: string): string | null {
	if (!value || value.length > AGENT_WEBHOOK_LIMITS.authKeyLength)
		return `An auth key is 1–${AGENT_WEBHOOK_LIMITS.authKeyLength} characters.`;
	if (!TOKEN.test(value))
		return "An auth key is printable ASCII without spaces.";
	return null;
}

/**
 * What is wrong with a webhook URL, or null. A webhook URL is an absolute
 * https URL on the default port with a public host name: no IP address, no
 * user name or password, and no fragment. On Node the gateway also checks,
 * before every POST, that the name resolves only to public addresses.
 */
export function agentWebhookUrlProblem(value: string): string | null {
	if (typeof value !== "string" || !value.trim())
		return "Enter the https URL to POST to.";
	if (value.length > AGENT_WEBHOOK_LIMITS.urlLength)
		return `A webhook URL is at most ${AGENT_WEBHOOK_LIMITS.urlLength} characters.`;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return "Enter an absolute URL, such as https://hooks.example.com/autonomous.";
	}
	if (url.protocol !== "https:") return "A webhook URL must use https.";
	if (url.username || url.password)
		return "A webhook URL must not contain a user name or password. Use the auth key or a header instead.";
	if (url.port) return "A webhook URL must use the default https port.";
	if (url.hash) return "A webhook URL must not contain a fragment (#).";
	const host = url.hostname.toLowerCase();
	// The URL parser writes every IPv4 form as dotted decimal and keeps IPv6 in brackets.
	if (host.startsWith("[") || /^[0-9.]+$/.test(host))
		return "A webhook URL must use a host name, not an IP address.";
	if (!host.includes(".") || host.endsWith("."))
		return "A webhook URL must use a full host name, such as hooks.example.com.";
	if (
		host === "localhost" ||
		PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
	)
		return "A webhook URL must use a public host name.";
	return null;
}

export type AgentWebhookStatus = "active" | "paused" | "disabled";
/**
 * Why the gateway stopped a webhook. `failures`: too many deliveries in a row
 * failed. `gone`: the receiver answered 410. `agent-revoked`: the agent was
 * revoked.
 */
export type AgentWebhookDisabledReason = "failures" | "gone" | "agent-revoked";
export type AgentWebhookHeader = { name: string; value: string };

/** A webhook as the dashboard sees it. The secret, auth key, and header values are never returned. */
export type AgentWebhook = {
	agentId: string;
	workspaceId: string;
	url: string;
	events: AgentWebhookEventGroup[];
	/** `paused`: a workspace admin switched it off. `disabled`: the gateway did; see `disabledReason`. */
	status: AgentWebhookStatus;
	disabledReason: AgentWebhookDisabledReason | null;
	/** True when the gateway sends an auth key as `Authorization: Bearer`. */
	hasAuthKey: boolean;
	/** The custom headers sent with each POST, by name. */
	headerNames: string[];
	/** The start of the signing secret, to tell which one a receiver holds. */
	secretPrefix: string;
	/** Deliveries in a row whose last attempt failed. A success sets it to 0. */
	consecutiveFailures: number;
	lastDeliveryAt: string | null;
	lastFailureAt: string | null;
	/**
	 * Why the last attempt failed: `http_<status>`, `redirect`, `timeout`,
	 * `network`, or `blocked` (the host resolved to a private address). The
	 * receiver's response body is never read.
	 */
	lastError: string | null;
	/** Events waiting to be sent, including those of a delivery waiting to retry. */
	pendingEvents: number;
	/** When the next POST is due, if one is waiting. */
	nextAttemptAt: string | null;
	createdAt: string;
	createdBy: string;
	updatedAt: string;
};
export type AgentWebhookDetails = { webhook: AgentWebhook | null };
/** A new webhook, or a new secret. The secret is shown only here. */
export type AgentWebhookSecret = { webhook: AgentWebhook; secret: string };

export type CreateAgentWebhookRequest = {
	url: string;
	/** Defaults to every group. */
	events?: AgentWebhookEventGroup[];
	/** Sent as `Authorization: Bearer <authKey>` with each POST. */
	authKey?: string;
	headers?: AgentWebhookHeader[];
};
/**
 * Changes the fields named and keeps the rest. `authKey: null` and
 * `headers: null` remove them; `headers` replaces the whole list. `enabled`
 * pauses the webhook, or starts it again after it was paused or disabled.
 */
export type UpdateAgentWebhookRequest = {
	url?: string;
	events?: AgentWebhookEventGroup[];
	authKey?: string | null;
	headers?: AgentWebhookHeader[] | null;
	enabled?: boolean;
};
/** The outcome of one test POST, sent at once and never retried. */
export type AgentWebhookTestResult = {
	ok: boolean;
	/** The receiver's HTTP status, when it answered. */
	status: number | null;
	error: string | null;
	durationMs: number;
};

/** One thing that happened, as a POST lists it. */
export type AgentWakeEvent =
	| {
			/**
			 * `channel.mention`: the message mentions the agent.
			 * `channel.reply`: a reply in a thread the agent started.
			 * `channel.message`: a new message in a channel the agent can post in.
			 */
			type: "channel.mention" | "channel.reply" | "channel.message";
			at: string;
			channelId: string;
			/** The channel's name when the message was posted. */
			channel: string;
			messageId: string;
			seq: number;
			/** The thread's first message, for a reply in a thread. */
			threadId: string | null;
			author: ChannelActor;
	  }
	| {
			type: "proposal.decided";
			at: string;
			proposalId: string;
			action: SynapseProposalAction;
			title: string;
			status: "approved" | "rejected";
			decidedBy: string;
	  }
	| {
			/** A workspace admin sent a test from the dashboard. */
			type: "webhook.test";
			at: string;
			requestedBy: string;
	  };

/**
 * The JSON body of a POST, shaped as Standard Webhooks recommends (type,
 * timestamp, data). `text` says the same in words, for a receiver such as a
 * Claude Code routine that passes only `text` on to the run.
 */
export type AgentWakePayload = {
	type: "agent.wake";
	timestamp: string;
	data: {
		workspaceId: string;
		agent: { id: string; name: string };
		events: AgentWakeEvent[];
		/** Events that happened but did not fit in this POST. */
		omitted: number;
	};
	text: string;
};

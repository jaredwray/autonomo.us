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
import type { ChannelActor, ChannelAgentAccess } from "./channels.js";
import type { SynapseActor, SynapseProposalAction } from "./synapse.js";

/** Where in the app an event comes from, as the dashboard heads each list. */
export const AGENT_WEBHOOK_AREAS = {
	channels: "Channels",
	synapse: "Synapse",
	agent: "This agent",
	workspace: "Workspace",
} as const;
export type AgentWebhookArea = keyof typeof AGENT_WEBHOOK_AREAS;

/**
 * Everything that can wake an agent, across the app, in the order the
 * dashboard lists it. A webhook chooses groups; `types` are the events each
 * group sends. An agent only hears what its own credential could read over
 * MCP, or what happened to the agent itself.
 */
export const AGENT_WEBHOOK_EVENT_GROUPS = {
	mentions: {
		area: "channels",
		label: "Mentions and replies",
		hint: "A message that mentions the agent, or a reply in a thread the agent started. Wakes only this agent.",
		types: ["channel.mention", "channel.reply"],
	},
	messages: {
		area: "channels",
		label: "New messages",
		hint: "A person or API token posts in a channel where the agent can post. An agent with read access is not woken, and other agents' posts wake nobody unless they mention someone.",
		types: ["channel.message"],
	},
	"message-changes": {
		area: "channels",
		label: "Edited and deleted messages",
		hint: "A person or API token edits or deletes a message in a channel where the agent can post. An edit that mentions the agent, and the deletion of the agent's own message, wake it whatever its access.",
		types: ["channel.message_edited", "channel.message_deleted"],
	},
	membership: {
		area: "channels",
		label: "Channel access",
		hint: "Someone adds the agent to a channel, changes its access between read and post, or removes it.",
		types: ["channel.joined", "channel.access_changed", "channel.left"],
	},
	channels: {
		area: "channels",
		label: "Channel changes",
		hint: "A channel the agent is in is renamed, gets a new topic or description, or is archived or unarchived.",
		types: ["channel.updated", "channel.archived", "channel.unarchived"],
	},
	proposals: {
		area: "synapse",
		label: "Proposal decisions",
		hint: "A workspace admin approves or rejects one of the agent's Synapse proposals.",
		types: ["proposal.decided"],
	},
	"shared-notes": {
		area: "synapse",
		label: "Shared notes",
		hint: "Someone creates, changes, deletes, or imports notes in the workspace's shared Synapse, or in the global Synapse it inherits.",
		types: [
			"synapse.note_created",
			"synapse.note_updated",
			"synapse.note_deleted",
			"synapse.imported",
		],
	},
	"own-notes": {
		area: "synapse",
		label: "Its own notes",
		hint: "Someone other than the agent creates, changes, deletes, or imports notes in the agent's private Synapse space.",
		types: [
			"synapse.note_created",
			"synapse.note_updated",
			"synapse.note_deleted",
			"synapse.imported",
		],
	},
	agent: {
		area: "agent",
		label: "Agent settings",
		hint: "A workspace admin renames the agent, changes its description or grants, or rolls its token.",
		types: ["agent.updated", "agent.permissions_changed", "agent.token_rolled"],
	},
	connections: {
		area: "agent",
		label: "App sign-ins",
		hint: "An app signs in to the agent with OAuth, or is disconnected from it.",
		types: ["agent.app_connected", "agent.app_disconnected"],
	},
	models: {
		area: "workspace",
		label: "Models",
		hint: "The workspace's models, routing, or failover change. Only an agent with the Models: Chat grant is woken.",
		types: ["models.changed"],
	},
	web: {
		area: "workspace",
		label: "Web access",
		hint: "The workspace's web policy or proxies change. Only an agent with the Web: Fetch grant is woken.",
		types: ["web.changed"],
	},
} as const satisfies Record<
	string,
	{
		area: AgentWebhookArea;
		label: string;
		hint: string;
		types: readonly AgentWakeEvent["type"][];
	}
>;
export type AgentWebhookEventGroup = keyof typeof AGENT_WEBHOOK_EVENT_GROUPS;

const groupTexts = (field: "label" | "hint") =>
	Object.fromEntries(
		Object.entries(AGENT_WEBHOOK_EVENT_GROUPS).map(([id, group]) => [
			id,
			group[field],
		]),
	) as Record<AgentWebhookEventGroup, string>;
/** What wakes an agent, as the dashboard names it. */
export const AGENT_WEBHOOK_EVENTS = groupTexts("label");
/** What each group sends, in a sentence. */
export const AGENT_WEBHOOK_EVENT_HINTS = groupTexts("hint");
/**
 * The groups a new webhook starts with: what asks the agent to act. The rest
 * report changes around it, and are chosen per webhook.
 */
export const DEFAULT_AGENT_WEBHOOK_EVENTS: readonly AgentWebhookEventGroup[] = [
	"mentions",
	"messages",
	"proposals",
];

/** The groups of one area, in the dashboard's order. */
export function agentWebhookGroupsIn(
	area: AgentWebhookArea,
): AgentWebhookEventGroup[] {
	return (
		Object.keys(AGENT_WEBHOOK_EVENT_GROUPS) as AgentWebhookEventGroup[]
	).filter((group) => AGENT_WEBHOOK_EVENT_GROUPS[group].area === area);
}

/** `groups` without repeats, in the dashboard's order. */
export function orderedAgentWebhookGroups(
	groups: Iterable<AgentWebhookEventGroup>,
): AgentWebhookEventGroup[] {
	const chosen = new Set(groups);
	return (
		Object.keys(AGENT_WEBHOOK_EVENT_GROUPS) as AgentWebhookEventGroup[]
	).filter((group) => chosen.has(group));
}

/**
 * The group a webhook must have chosen to be sent this event, or null for an
 * event no group sends (a test). A Synapse event belongs to the group of the
 * space it happened in.
 */
export function agentWakeEventGroup(
	event: AgentWakeEvent,
): AgentWebhookEventGroup | null {
	switch (event.type) {
		case "channel.mention":
		case "channel.reply":
			return "mentions";
		case "channel.message":
			return "messages";
		case "channel.message_edited":
		case "channel.message_deleted":
			return "message-changes";
		case "channel.joined":
		case "channel.access_changed":
		case "channel.left":
			return "membership";
		case "channel.updated":
		case "channel.archived":
		case "channel.unarchived":
			return "channels";
		case "proposal.decided":
			return "proposals";
		case "synapse.note_created":
		case "synapse.note_updated":
		case "synapse.note_deleted":
		case "synapse.imported":
			return event.space === "agent" ? "own-notes" : "shared-notes";
		case "agent.updated":
		case "agent.permissions_changed":
		case "agent.token_rolled":
			return "agent";
		case "agent.app_connected":
		case "agent.app_disconnected":
			return "connections";
		case "models.changed":
			return "models";
		case "web.changed":
			return "web";
		default:
			return null;
	}
}

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

/** Who did something. `system`: the gateway itself. */
export type AgentWakeActor = SynapseActor;

/** The channel an event happened in, by id and by its name at the time. */
type InChannel = { at: string; channelId: string; channel: string };
/** The message an event is about: `seq` is its number in the channel. */
type AboutMessage = InChannel & {
	messageId: string;
	seq: number;
	/** The thread's first message, for a reply in a thread. */
	threadId: string | null;
};
/**
 * Where a note lives, as the agent names it over MCP: `shared` is its
 * workspace's team canon, `global` the canon every workspace inherits, and
 * `agent` the agent's own private space.
 */
export type AgentWakeSpace = "shared" | "global" | "agent";

/** One thing that happened, as a POST lists it. */
export type AgentWakeEvent =
	| (AboutMessage & {
			/**
			 * `channel.mention`: the message mentions the agent.
			 * `channel.reply`: a reply in a thread the agent started.
			 * `channel.message`: a new message in a channel the agent can post in.
			 */
			type: "channel.mention" | "channel.reply" | "channel.message";
			author: ChannelActor;
	  })
	| (AboutMessage & {
			type: "channel.message_edited";
			by: ChannelActor;
			/** The message mentions the agent as it now reads. */
			mentioned: boolean;
	  })
	| (AboutMessage & {
			type: "channel.message_deleted";
			by: ChannelActor;
			/** The agent wrote the message. */
			own: boolean;
	  })
	| (InChannel & {
			/** The agent was added to the channel. */
			type: "channel.joined";
			access: ChannelAgentAccess;
			by: ChannelActor;
	  })
	| (InChannel & {
			type: "channel.access_changed";
			access: ChannelAgentAccess;
			previousAccess: ChannelAgentAccess;
			by: ChannelActor;
	  })
	| (InChannel & {
			/** The agent was removed from the channel. */
			type: "channel.left";
			by: ChannelActor;
	  })
	| (InChannel & {
			type: "channel.updated";
			changes: Array<"name" | "topic" | "description">;
			/** The name before, when it was renamed. */
			previousName: string | null;
			by: ChannelActor;
	  })
	| (InChannel & {
			type: "channel.archived" | "channel.unarchived";
			by: ChannelActor;
	  })
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
			type:
				| "synapse.note_created"
				| "synapse.note_updated"
				| "synapse.note_deleted";
			at: string;
			space: AgentWakeSpace;
			title: string;
			/** The title before, when the note was renamed. */
			previousTitle: string | null;
			by: AgentWakeActor;
	  }
	| {
			/** Many notes at once, reported as one event. */
			type: "synapse.imported";
			at: string;
			space: AgentWakeSpace;
			created: number;
			updated: number;
			by: AgentWakeActor;
	  }
	| {
			type: "agent.updated";
			at: string;
			changes: Array<"name" | "description">;
			/** The name before, when the agent was renamed. */
			previousName: string | null;
			by: AgentWakeActor;
	  }
	| {
			type: "agent.permissions_changed";
			at: string;
			/** Grant ids, such as `models:chat`. */
			added: string[];
			removed: string[];
			by: AgentWakeActor;
	  }
	| {
			type: "agent.token_rolled";
			at: string;
			/** When the token it replaced stops working. */
			previousValidUntil: string;
			by: AgentWakeActor;
	  }
	| {
			type: "agent.app_connected";
			at: string;
			/** The app's name, which the app chose itself. */
			app: string;
			approvedBy: string | null;
	  }
	| {
			type: "agent.app_disconnected";
			at: string;
			app: string;
			reason: string;
			/** Who disconnected it; null when the app or the gateway did. */
			by: string | null;
	  }
	| {
			type: "models.changed";
			at: string;
			/** `models`: a model or connection. `routing` and `failover`: those settings. */
			change: "models" | "routing" | "failover";
			by: AgentWakeActor;
	  }
	| {
			type: "web.changed";
			at: string;
			change: "policy" | "proxies";
			by: AgentWakeActor;
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

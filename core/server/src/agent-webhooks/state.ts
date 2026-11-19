import { randomUUID } from "node:crypto";
import {
	AGENT_WEBHOOK_LIMITS,
	type AgentWakeEvent,
	type AgentWebhook,
	type AgentWebhookDisabledReason,
	type AgentWebhookEventGroup,
	agentWakeEventGroup,
	orderedAgentWebhookGroups,
} from "@autonomo.us/common";
import type { StoredAgentWebhook, StoredDelivery } from "./repository.js";

/**
 * How a webhook's POSTs are spaced, retried, and given up on. The production
 * values come from `AGENT_WEBHOOK_LIMITS`; tests shorten them.
 */
export type WebhookTiming = {
	/** A POST waits this long after the event that opens it. */
	gapMs: number;
	/** How long a sender owns a delivery; a crashed send is retried after it. */
	leaseMs: number;
	/** Before attempts 2, 3, …; its length plus one is the number of attempts. */
	retryDelaysMs: readonly number[];
	failuresBeforeDisable: number;
	/** The shortest and longest wait a 429's `retry-after` can set. */
	minRetryAfterMs: number;
	maxRetryAfterMs: number;
	eventsPerDelivery: number;
};

export const DEFAULT_TIMING: WebhookTiming = {
	gapMs: AGENT_WEBHOOK_LIMITS.gapSeconds * 1000,
	// Longer than a POST's timeout and the access checks before it.
	leaseMs: (AGENT_WEBHOOK_LIMITS.timeoutSeconds + 50) * 1000,
	retryDelaysMs: AGENT_WEBHOOK_LIMITS.retryDelaysSeconds.map((s) => s * 1000),
	failuresBeforeDisable: AGENT_WEBHOOK_LIMITS.failedDeliveriesBeforeDisable,
	minRetryAfterMs: 10_000,
	maxRetryAfterMs: AGENT_WEBHOOK_LIMITS.maxRetryAfterSeconds * 1000,
	eventsPerDelivery: AGENT_WEBHOOK_LIMITS.eventsPerDelivery,
};

/** Keys kept to recognize an event that is reported twice. */
const RECENT_KEYS = 200;
/**
 * Messages remembered per channel, so a retried post is recognized however
 * much happens elsewhere. A retried post older than every one remembered was
 * reported long ago. A first report is never dropped, however late it comes.
 */
const CHANNEL_WINDOW = 50;

/** Whether an active webhook chose this group of events. */
export function wants(
	webhook: Pick<StoredAgentWebhook, "status" | "events">,
	group: AgentWebhookEventGroup | null,
): boolean {
	return (
		webhook.status === "active" &&
		group !== null &&
		webhook.events.includes(group)
	);
}

/** What an agent needs to read anything over MCP: to list tools, and to call one. */
const MCP_GRANTS = ["mcp:read", "mcp:call"] as const;
/**
 * The grants an agent must hold to be sent a group's events, so that a
 * webhook never tells it more than its own credential could read. The three
 * groups that came first, and what happens to the agent itself, need none.
 */
const GROUP_GRANTS: Partial<Record<AgentWebhookEventGroup, readonly string[]>> =
	{
		organization: MCP_GRANTS,
		"message-changes": MCP_GRANTS,
		membership: MCP_GRANTS,
		channels: MCP_GRANTS,
		"shared-notes": MCP_GRANTS,
		"own-notes": MCP_GRANTS,
		models: [...MCP_GRANTS, "models:chat"],
		web: [...MCP_GRANTS, "web:fetch"],
	};

/** Whether an agent holding `permissions` may be sent this event. */
export function mayHear(
	event: AgentWakeEvent,
	permissions: readonly string[],
): boolean {
	if (
		event.type === "decision.assigned" &&
		!permissions.includes("organization:decide")
	)
		return false;
	const group = agentWakeEventGroup(event);
	return (group ? (GROUP_GRANTS[group] ?? []) : []).every((grant) =>
		permissions.includes(grant),
	);
}

/** A newly posted message, which a retried post can report twice. */
type PostEvent = Extract<
	AgentWakeEvent,
	{ type: "channel.mention" | "channel.reply" | "channel.message" }
>;
const isPost = (event: AgentWakeEvent): event is PostEvent =>
	event.type === "channel.mention" ||
	event.type === "channel.reply" ||
	event.type === "channel.message";

/**
 * Events that come in bulk and say little each: plain messages, edits, and
 * note changes. A full queue drops the oldest of them to keep an event that
 * asks something of the agent. An edit that mentions the agent asks, as a
 * mention does.
 */
const isBulk = (event: AgentWakeEvent) =>
	event.type === "channel.message" ||
	(event.type === "channel.message_edited" && !event.mentioned) ||
	event.type === "channel.message_deleted" ||
	event.type === "synapse.note_created" ||
	event.type === "synapse.note_updated" ||
	event.type === "synapse.note_deleted";

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Adds an event to the next POST, or null when the webhook is not active, did
 * not choose the event's group, or already has this event. The first event
 * sets when the POST is due; later ones join it. A full queue makes room for
 * an event that asks something of the agent by dropping its oldest bulk
 * event, and otherwise counts the new event as omitted.
 */
export function enqueued(
	webhook: StoredAgentWebhook,
	event: AgentWakeEvent,
	key: string,
	now: number,
	timing: WebhookTiming,
	/** A retried post, settled again: it may have been reported already. */
	replay = false,
): StoredAgentWebhook | null {
	if (
		!wants(webhook, agentWakeEventGroup(event)) ||
		webhook.recentKeys.includes(key)
	)
		return null;
	let channelSeqs = webhook.channelSeqs ?? {};
	if (isPost(event)) {
		// Ascending, so the first is the oldest remembered.
		const seen = channelSeqs[event.channelId] ?? [];
		if (
			seen.includes(event.seq) ||
			(replay && seen.length >= CHANNEL_WINDOW && event.seq < seen[0])
		)
			return null;
		channelSeqs = {
			...channelSeqs,
			[event.channelId]: [...seen, event.seq]
				.sort((a, b) => a - b)
				.slice(-CHANNEL_WINDOW),
		};
	}
	let queue = webhook.queue;
	let omitted = webhook.omitted;
	if (queue.length < timing.eventsPerDelivery) queue = [...queue, event];
	else {
		const bulk = queue.findIndex(isBulk);
		if (!isBulk(event) && bulk >= 0)
			queue = [...queue.slice(0, bulk), ...queue.slice(bulk + 1), event];
		omitted += 1;
	}
	return {
		...webhook,
		queue,
		omitted,
		recentKeys: [...webhook.recentKeys, key].slice(-RECENT_KEYS),
		channelSeqs,
		// A delivery that is waiting or being sent keeps its own time.
		dueAt: webhook.dueAt ?? iso(now + timing.gapMs),
	};
}

/** Stops a webhook: nothing waits and nothing more is sent. */
function disabled(
	webhook: StoredAgentWebhook,
	reason: AgentWebhookDisabledReason,
): StoredAgentWebhook {
	return {
		...webhook,
		status: "disabled",
		disabledReason: reason,
		queue: [],
		omitted: 0,
		delivery: null,
		dueAt: null,
	};
}

/** After a delivery ends, the queued events go next, one gap later. */
function next(
	webhook: StoredAgentWebhook,
	now: number,
	timing: WebhookTiming,
): StoredAgentWebhook {
	return {
		...webhook,
		delivery: null,
		dueAt: webhook.queue.length ? iso(now + timing.gapMs) : null,
	};
}

/** A delivery whose last attempt failed: one more failure in a row. */
function gaveUp(
	webhook: StoredAgentWebhook,
	now: number,
	timing: WebhookTiming,
): StoredAgentWebhook {
	const failures = webhook.consecutiveFailures + 1;
	const counted = { ...webhook, consecutiveFailures: failures };
	return failures >= timing.failuresBeforeDisable
		? disabled(counted, "failures")
		: next(counted, now, timing);
}

export type Claim = {
	webhook: StoredAgentWebhook;
	/** The delivery to send, or null when the claim only tidied up. */
	delivery: StoredDelivery | null;
};

/**
 * Takes the due POST under a lease: the delivery waiting for a retry, or a
 * new one made of the queued events. Null when nothing is due or someone
 * else holds the lease. `dueAt` moves to the end of the lease, so a sender
 * that crashes leaves the delivery for the sweep. A new delivery leaves out
 * the queued events the agent's grants no longer let it hear.
 */
export function claimed(
	webhook: StoredAgentWebhook,
	leaseId: string,
	now: number,
	timing: WebhookTiming,
	/** Recorded on a new delivery; its retries keep it. */
	agentName?: string,
	/** The agent's grants now; without them every queued event is sent. */
	permissions?: readonly string[],
): Claim | null {
	const at = iso(now);
	if (webhook.status !== "active" || !webhook.dueAt || webhook.dueAt > at)
		return null;
	if (webhook.leaseUntil && webhook.leaseUntil > at) return null;
	let current: StoredAgentWebhook = {
		...webhook,
		leaseId: null,
		leaseUntil: null,
	};
	// The last allowed attempt was started and never finished: a crash.
	if (
		current.delivery &&
		current.delivery.attempts > timing.retryDelaysMs.length
	)
		current = gaveUp(
			{ ...current, lastError: "interrupted", lastFailureAt: at },
			now,
			timing,
		);
	if (current.status !== "active") return { webhook: current, delivery: null };
	let delivery = current.delivery;
	if (!delivery) {
		// Grants taken away since an event was queued take the event with them.
		const events = permissions
			? current.queue.filter((event) => mayHear(event, permissions))
			: current.queue;
		if (!events.length)
			return {
				webhook: { ...current, queue: [], omitted: 0, dueAt: null },
				delivery: null,
			};
		delivery = {
			id: `msg_${randomUUID().replaceAll("-", "")}`,
			createdAt: at,
			events,
			omitted: current.omitted,
			...(agentName === undefined ? {} : { agentName }),
			attempts: 0,
		};
		current = { ...current, queue: [], omitted: 0 };
	}
	delivery = { ...delivery, attempts: delivery.attempts + 1 };
	const leaseUntil = iso(now + timing.leaseMs);
	return {
		webhook: { ...current, delivery, leaseId, leaseUntil, dueAt: leaseUntil },
		delivery,
	};
}

/** How one attempt ended. */
export type Outcome =
	| { kind: "ok" }
	/** 410 Gone: the receiver asks the sender to stop. */
	| { kind: "gone" }
	/** 429: the receiver is up but busy. The attempt does not count. */
	| { kind: "throttled"; retryAfterMs: number | null }
	| { kind: "failed"; error: string }
	/** The agent was revoked: the webhook stops. */
	| { kind: "revoked" }
	/** Nobody can act on it now (an archived workspace, an expired token): dropped. */
	| { kind: "skipped" }
	/** The sender stopped before an answer, for a shutdown: tried again soon. */
	| { kind: "released" };

/**
 * Records how an attempt ended, for the sender that still holds the lease;
 * null for one that lost it. Decides what is due next.
 */
export function finished(
	webhook: StoredAgentWebhook,
	leaseId: string,
	outcome: Outcome,
	now: number,
	timing: WebhookTiming,
): StoredAgentWebhook | null {
	if (webhook.leaseId !== leaseId) return null;
	const at = iso(now);
	const base: StoredAgentWebhook = {
		...webhook,
		leaseId: null,
		leaseUntil: null,
	};
	const delivery = base.delivery;
	// Paused or disabled while the POST was out, which dropped the delivery:
	// release the lease and keep only what the POST learned.
	if (base.status !== "active" || !delivery) {
		const settled =
			base.status === "active"
				? next(base, now, timing)
				: { ...base, delivery: null, dueAt: null };
		return outcome.kind === "ok"
			? { ...settled, lastDeliveryAt: at, lastError: null }
			: settled;
	}
	switch (outcome.kind) {
		case "ok":
			return next(
				{
					...base,
					consecutiveFailures: 0,
					lastDeliveryAt: at,
					lastError: null,
				},
				now,
				timing,
			);
		case "gone":
			return disabled(
				{ ...base, lastError: "http_410", lastFailureAt: at },
				"gone",
			);
		case "revoked":
			return disabled(base, "agent-revoked");
		case "skipped":
			return next(base, now, timing);
		case "released":
			return {
				...base,
				delivery: { ...delivery, attempts: delivery.attempts - 1 },
				dueAt: at,
			};
		case "throttled": {
			const wait = Math.min(
				timing.maxRetryAfterMs,
				Math.max(timing.minRetryAfterMs, outcome.retryAfterMs ?? 0),
			);
			return {
				...base,
				delivery: { ...delivery, attempts: delivery.attempts - 1 },
				lastError: "http_429",
				lastFailureAt: at,
				dueAt: iso(now + wait),
			};
		}
		case "failed": {
			const failed = { ...base, lastError: outcome.error, lastFailureAt: at };
			const delay = timing.retryDelaysMs[delivery.attempts - 1];
			return delay === undefined
				? gaveUp(failed, now, timing)
				: { ...failed, dueAt: iso(now + delay) };
		}
	}
}

/**
 * Pauses or starts a webhook. Starting one clears its failures; pausing drops
 * whatever waits, since nothing would send it.
 */
export function switched(
	webhook: StoredAgentWebhook,
	enabled: boolean,
): StoredAgentWebhook {
	if (enabled)
		return webhook.status === "active"
			? webhook
			: {
					...webhook,
					status: "active",
					disabledReason: null,
					consecutiveFailures: 0,
				};
	return webhook.status === "paused"
		? webhook
		: {
				...webhook,
				status: "paused",
				disabledReason: null,
				queue: [],
				omitted: 0,
				delivery: null,
				dueAt: null,
			};
}

/** A webhook as the dashboard sees it: no secret, auth key, or header values. */
export function publicWebhook(webhook: StoredAgentWebhook): AgentWebhook {
	return {
		agentId: webhook.agentId,
		workspaceId: webhook.workspaceId,
		url: webhook.url,
		events: orderedAgentWebhookGroups(webhook.events),
		status: webhook.status,
		disabledReason: webhook.disabledReason,
		hasAuthKey: webhook.authKey !== null,
		headerNames: webhook.headers.map((header) => header.name),
		secretPrefix: `${webhook.secret.slice(0, 10)}…`,
		consecutiveFailures: webhook.consecutiveFailures,
		lastDeliveryAt: webhook.lastDeliveryAt,
		lastFailureAt: webhook.lastFailureAt,
		lastError: webhook.lastError,
		pendingEvents:
			webhook.queue.length +
			webhook.omitted +
			(webhook.delivery
				? webhook.delivery.events.length + webhook.delivery.omitted
				: 0),
		nextAttemptAt:
			webhook.leaseUntil && webhook.dueAt === webhook.leaseUntil
				? null
				: webhook.dueAt,
		createdAt: webhook.createdAt,
		createdBy: webhook.createdBy,
		updatedAt: webhook.updatedAt,
	};
}

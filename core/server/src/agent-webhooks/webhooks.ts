import { randomUUID } from "node:crypto";
import {
	AGENT_WEBHOOK_EVENTS,
	AGENT_WEBHOOK_LIMITS,
	type AgentWakeEvent,
	type AgentWebhook,
	type AgentWebhookEventGroup,
	type AgentWebhookHeader,
	type AgentWebhookSecret,
	type AgentWebhookTestResult,
	agentWakeEventGroup,
	agentWebhookAuthKeyProblem,
	agentWebhookHeaderProblem,
	agentWebhookHeaderValueProblem,
	agentWebhookUrlProblem,
	type Channel,
	type ChannelActor,
	type ChannelMessage,
	type CreateAgentWebhookRequest,
	DEFAULT_AGENT_WEBHOOK_EVENTS,
	orderedAgentWebhookGroups,
	type SynapseProposal,
	type UpdateAgentWebhookRequest,
} from "@autonomo.us/common";
import type { Resolver } from "../web/url-guard.js";
import {
	newSecret,
	type PostResult,
	post,
	type WebhookTransport,
	wakeBody,
} from "./delivery.js";
import { AgentWebhookError } from "./errors.js";
import {
	type AgentWebhookRepository,
	mutateWebhook,
	type StoredAgentWebhook,
	type StoredDelivery,
} from "./repository.js";
import {
	claimed,
	DEFAULT_TIMING,
	enqueued,
	finished,
	mayHear,
	type Outcome,
	publicWebhook,
	switched,
	type WebhookTiming,
	wants,
} from "./state.js";

/** What the gateway knows about an agent when it is about to wake it. */
export type WebhookAgent = {
	name: string;
	/** Null for an agent from before workspaces: it belongs to the default workspace. */
	workspaceId: string | null;
	status: "active" | "expired" | "revoked";
	/** The agent's grants, which decide what it may hear about. */
	permissions: readonly string[];
};

/**
 * An event for one agent, with the key that recognizes it when the same
 * thing is reported twice.
 */
export type AgentNotice = { event: AgentWakeEvent; key: string };
/** The event to queue for an agent, or null to leave that agent alone. */
export type AgentNoticeFor = (
	agentId: string,
) => AgentNotice | null | Promise<AgentNotice | null>;

export type AgentWebhooksOptions = {
	mayDeliverLoopAssignment?(
		workspaceId: string,
		agentId: string,
		event: Extract<AgentWakeEvent, { type: "loop.assigned" }>,
	): Promise<boolean>;
	mayDeliverDecision?(
		workspaceId: string,
		agentId: string,
		event: Extract<
			AgentWakeEvent,
			{ type: "decision.assigned" | "decision.outcome" }
		>,
	): Promise<boolean>;
	repository: AgentWebhookRepository;
	/** An agent by id, or null when it is unknown or revoked. */
	agents: { find(agentId: string): Promise<WebhookAgent | null> };
	workspaces: {
		get(id: string): Promise<{ archivedAt: string | null } | null>;
		defaultWorkspaceId(): Promise<string>;
	};
	/** Who wrote the first message of a thread. */
	threadAuthor(
		workspaceId: string,
		channelId: string,
		messageId: string,
	): Promise<ChannelActor | null>;
	transport: WebhookTransport;
	/** Checks a host against private addresses before a pinned POST. */
	resolver?: Resolver;
	timing?: Partial<WebhookTiming>;
	timeoutMs?: number;
	/**
	 * A POST due within this long is sent by a timer in this process; a later
	 * one waits for a sweep. The Worker keeps it short, since a request's
	 * background work has about 30 seconds.
	 */
	maxTimerMs?: number;
	/** Least time between the sweeps `catchUp` starts. */
	catchUpIntervalMs?: number;
	now?: () => number;
	log?: (message: string, details: Record<string, unknown>) => void;
};

const SWEEP_BATCH = 50;

/** One webhook per agent, so a repeated name is a mistake worth saying. */
function checkedEvents(
	events: readonly AgentWebhookEventGroup[] | undefined,
): AgentWebhookEventGroup[] {
	const list = events ?? DEFAULT_AGENT_WEBHOOK_EVENTS;
	if (!list.length)
		throw new AgentWebhookError(
			"Choose at least one event that wakes the agent.",
		);
	for (const event of list)
		if (!Object.hasOwn(AGENT_WEBHOOK_EVENTS, event))
			throw new AgentWebhookError(`${event} is not a webhook event.`);
	return orderedAgentWebhookGroups(list);
}
function checkedUrl(url: string): string {
	const problem = agentWebhookUrlProblem(url);
	if (problem) throw new AgentWebhookError(problem);
	return url.trim();
}
function checkedAuthKey(authKey: string): string {
	const problem = agentWebhookAuthKeyProblem(authKey);
	if (problem) throw new AgentWebhookError(problem);
	return authKey;
}
function checkedHeaders(
	headers: readonly AgentWebhookHeader[],
	withAuthKey: boolean,
): AgentWebhookHeader[] {
	if (headers.length > AGENT_WEBHOOK_LIMITS.headers)
		throw new AgentWebhookError(
			`A webhook sends at most ${AGENT_WEBHOOK_LIMITS.headers} custom headers.`,
		);
	const seen = new Set<string>();
	return headers.map(({ name, value }) => {
		const trimmed = { name: name.trim(), value: value.trim() };
		const problem =
			agentWebhookHeaderProblem(trimmed.name, withAuthKey) ??
			agentWebhookHeaderValueProblem(trimmed.value);
		if (problem) throw new AgentWebhookError(problem);
		const key = trimmed.name.toLowerCase();
		if (seen.has(key))
			throw new AgentWebhookError(`The header ${trimmed.name} is set twice.`);
		seen.add(key);
		return trimmed;
	});
}
const notFound = () => new AgentWebhookError("This agent has no webhook.", 404);

/**
 * Agent webhooks: the settings workspace admins keep for each agent, the
 * events that wake an agent, and the signed POSTs that tell it. Events join
 * the agent's queue; a POST goes out one gap after the first of them, with
 * every event since. A failed POST is tried again with backoff, and a
 * receiver that keeps failing is switched off.
 */
export class AgentWebhooks {
	private readonly now: () => number;
	private readonly timing: WebhookTiming;
	private readonly timeoutMs: number;
	private readonly maxTimerMs: number;
	private readonly catchUpIntervalMs: number;
	private readonly working = new Set<Promise<void>>();
	private readonly timers = new Map<
		string,
		{ at: number; timer: ReturnType<typeof setTimeout>; done: () => void }
	>();
	/** POSTs in flight, so `close` can stop them. */
	private readonly sending = new Set<AbortController>();
	private closing = false;
	private lastCatchUp = Number.NEGATIVE_INFINITY;
	constructor(private readonly options: AgentWebhooksOptions) {
		this.now = options.now ?? Date.now;
		this.timing = { ...DEFAULT_TIMING, ...options.timing };
		this.timeoutMs =
			options.timeoutMs ?? AGENT_WEBHOOK_LIMITS.timeoutSeconds * 1000;
		this.maxTimerMs = options.maxTimerMs ?? 60_000;
		this.catchUpIntervalMs = options.catchUpIntervalMs ?? 15_000;
	}
	private at() {
		return new Date(this.now()).toISOString();
	}

	// Settings, for workspace admins.

	async get(
		workspaceId: string,
		agentId: string,
	): Promise<AgentWebhook | null> {
		const stored = await this.options.repository.get(workspaceId, agentId);
		return stored ? publicWebhook(stored) : null;
	}

	async create(
		workspaceId: string,
		agentId: string,
		input: CreateAgentWebhookRequest,
		createdBy: string,
	): Promise<AgentWebhookSecret> {
		const authKey =
			input.authKey === undefined ? null : checkedAuthKey(input.authKey);
		const at = this.at();
		const webhook: StoredAgentWebhook = {
			agentId,
			workspaceId,
			url: checkedUrl(input.url),
			secret: newSecret(),
			authKey,
			headers: checkedHeaders(input.headers ?? [], authKey !== null),
			events: checkedEvents(input.events),
			status: "active",
			disabledReason: null,
			consecutiveFailures: 0,
			lastDeliveryAt: null,
			lastFailureAt: null,
			lastError: null,
			createdAt: at,
			createdBy,
			updatedAt: at,
			queue: [],
			omitted: 0,
			delivery: null,
			dueAt: null,
			leaseId: null,
			leaseUntil: null,
			recentKeys: [],
			channelSeqs: {},
			version: 1,
		};
		if (!(await this.options.repository.insert(webhook)))
			throw new AgentWebhookError(
				"This agent already has a webhook. Change it or delete it first.",
				409,
			);
		return { webhook: publicWebhook(webhook), secret: webhook.secret };
	}

	async update(
		workspaceId: string,
		agentId: string,
		input: UpdateAgentWebhookRequest,
	): Promise<AgentWebhook> {
		const url = input.url === undefined ? undefined : checkedUrl(input.url);
		const events =
			input.events === undefined ? undefined : checkedEvents(input.events);
		const authKey =
			input.authKey === undefined || input.authKey === null
				? input.authKey
				: checkedAuthKey(input.authKey);
		const updated = await mutateWebhook(
			this.options.repository,
			workspaceId,
			agentId,
			(current) => {
				const nextKey = authKey === undefined ? current.authKey : authKey;
				let next: StoredAgentWebhook = {
					...current,
					url: url ?? current.url,
					events: events ?? current.events,
					authKey: nextKey,
					headers: checkedHeaders(
						input.headers === undefined
							? current.headers
							: (input.headers ?? []),
						nextKey !== null,
					),
					updatedAt: this.at(),
				};
				if (input.enabled !== undefined) next = switched(next, input.enabled);
				return next;
			},
		);
		if (!updated) throw notFound();
		return publicWebhook(updated);
	}

	/** A new signing secret. The old one stops at once. */
	async rotateSecret(
		workspaceId: string,
		agentId: string,
	): Promise<AgentWebhookSecret> {
		const secret = newSecret();
		const updated = await mutateWebhook(
			this.options.repository,
			workspaceId,
			agentId,
			(current) => ({ ...current, secret, updatedAt: this.at() }),
		);
		if (!updated) throw notFound();
		return { webhook: publicWebhook(updated), secret };
	}

	remove(workspaceId: string, agentId: string): Promise<boolean> {
		return this.options.repository.delete(workspaceId, agentId);
	}

	/**
	 * Sends one test POST now, whatever the webhook's status, and reports
	 * how the receiver answered. It is not retried and changes nothing.
	 */
	async test(
		workspaceId: string,
		agentId: string,
		requestedBy: string,
	): Promise<AgentWebhookTestResult> {
		const stored = await this.options.repository.get(workspaceId, agentId);
		if (!stored) throw notFound();
		const agent = await this.options.agents.find(agentId);
		const at = this.at();
		const delivery = {
			id: `msg_${randomUUID().replaceAll("-", "")}`,
			createdAt: at,
			events: [{ type: "webhook.test" as const, at, requestedBy }],
			omitted: 0,
		};
		const started = this.now();
		const result = await this.send(
			stored,
			{ id: agentId, name: agent?.name ?? "this agent" },
			delivery,
		);
		return {
			ok: result.kind === "ok",
			status: result.status,
			error:
				result.kind === "ok"
					? null
					: result.kind === "failed"
						? result.error
						: result.kind === "cancelled"
							? "cancelled"
							: `http_${result.status}`,
			durationMs: Math.max(0, this.now() - started),
		};
	}

	// Events: what wakes which agent.

	/**
	 * Called for every posted message. A mention wakes the agent mentioned, a
	 * reply wakes the agent whose thread it is, and a new message from a
	 * person or token wakes the agents that can post in the channel. An agent
	 * is never woken by its own message, and another agent's message wakes
	 * nobody unless it mentions them, so two agents cannot wake each other in
	 * a loop by talking.
	 */
	async onMessage(
		channel: Channel,
		message: ChannelMessage,
		/** A retried post, settled again: it may have been reported already. */
		{ replay }: { replay: boolean } = { replay: false },
	): Promise<void> {
		if (channel.archivedAt || message.deletedAt) return;
		const author = message.author;
		const candidates = channel.agents
			.map((agent) => agent.agentTokenId)
			.filter((id) => !(author.kind === "agent" && author.id === id));
		if (!candidates.length) return;
		const webhooks = await this.options.repository.active(
			channel.workspaceId,
			candidates,
		);
		if (!webhooks.length) return;
		const mentioned = new Set(
			message.mentions
				.filter((mention) => mention.kind === "agent")
				.map((mention) => mention.id),
		);
		let threadAuthor: Promise<ChannelActor | null> | undefined;
		for (const webhook of webhooks) {
			const types: Array<
				"channel.mention" | "channel.reply" | "channel.message"
			> = [];
			if (mentioned.has(webhook.agentId)) types.push("channel.mention");
			// Like a new message, an agent's reply wakes nobody unless it mentions them.
			else if (
				message.threadId &&
				author.kind !== "agent" &&
				wants(webhook, "mentions")
			) {
				threadAuthor ??= this.options
					.threadAuthor(channel.workspaceId, channel.id, message.threadId)
					.catch(() => null);
				const root = await threadAuthor;
				if (root?.kind === "agent" && root.id === webhook.agentId)
					types.push("channel.reply");
			}
			const access = channel.agents.find(
				(agent) => agent.agentTokenId === webhook.agentId,
			)?.access;
			if (author.kind !== "agent" && access === "post")
				types.push("channel.message");
			const type = types.find((candidate) =>
				wants(
					webhook,
					candidate === "channel.message" ? "messages" : "mentions",
				),
			);
			if (!type) continue;
			await this.enqueue(
				webhook,
				{
					type,
					at: message.createdAt,
					channelId: channel.id,
					channel: channel.name,
					messageId: message.id,
					seq: message.seq,
					threadId: message.threadId,
					author,
				},
				// One event per message and agent, so a retried post adds nothing.
				`channel:${channel.id}:${message.seq}`,
				replay,
			);
		}
	}

	/** Source outboxes retry targeted wakeups if the webhook queue is unavailable. */
	private async targetedNotice(
		workspaceId: string,
		agentId: string,
		notice: AgentNotice,
	) {
		const [webhook] = await this.options.repository.active(workspaceId, [
			agentId,
		]);
		if (webhook && wants(webhook, agentWakeEventGroup(notice.event)))
			await this.enqueue(webhook, notice.event, notice.key);
	}

	onOrganizationNotice(
		workspaceId: string,
		agentId: string,
		notice: AgentNotice,
	) {
		return this.targetedNotice(workspaceId, agentId, notice);
	}

	onLoopAssignment(workspaceId: string, agentId: string, notice: AgentNotice) {
		return this.targetedNotice(workspaceId, agentId, notice);
	}

	/** Called after a workspace admin decides a proposal: its author follows up. */
	async onProposalDecided(
		workspaceId: string,
		proposal: SynapseProposal,
	): Promise<void> {
		if (proposal.author.kind !== "agent" || proposal.status === "pending")
			return;
		const [webhook] = await this.options.repository.active(workspaceId, [
			proposal.author.id,
		]);
		if (!webhook || !wants(webhook, "proposals")) return;
		await this.enqueue(
			webhook,
			{
				type: "proposal.decided",
				at: proposal.decidedAt ?? this.at(),
				proposalId: proposal.id,
				action: proposal.action,
				title: proposal.title,
				status: proposal.status,
				decidedBy: proposal.decidedBy?.name ?? "A workspace admin",
			},
			`proposal:${proposal.id}`,
		);
	}

	/**
	 * Queues an event for each of these agents whose webhook is active and
	 * chose the event's group. Everything in the app that is not a message or
	 * a proposal decision reports through here or `broadcast`.
	 */
	async notify(
		workspaceId: string,
		agentIds: readonly string[],
		notice: AgentNoticeFor,
	): Promise<void> {
		const ids = [...new Set(agentIds)];
		if (!ids.length) return;
		await this.queueFor(
			await this.options.repository.active(workspaceId, ids),
			notice,
		);
	}

	/**
	 * Queues an event for every agent whose webhook chose `group`: those of
	 * one workspace, or of every workspace when `workspaceId` is null.
	 */
	async broadcast(
		workspaceId: string | null,
		group: AgentWebhookEventGroup,
		notice: AgentNoticeFor,
	): Promise<void> {
		await this.queueFor(
			await this.options.repository.subscribed(workspaceId, group),
			notice,
		);
	}

	/** One agent's trouble never keeps the event from the others. */
	private async queueFor(
		webhooks: readonly StoredAgentWebhook[],
		notice: AgentNoticeFor,
	): Promise<void> {
		await Promise.all(
			webhooks.map(async (webhook) => {
				try {
					const made = await notice(webhook.agentId);
					if (made) await this.enqueue(webhook, made.event, made.key);
				} catch (error) {
					this.options.log?.("An agent webhook event could not be queued.", {
						error,
						agentId: webhook.agentId,
					});
				}
			}),
		);
	}

	private async enqueue(
		webhook: StoredAgentWebhook,
		event: AgentWakeEvent,
		key: string,
		replay = false,
	) {
		const updated = await mutateWebhook(
			this.options.repository,
			webhook.workspaceId,
			webhook.agentId,
			(current) =>
				enqueued(current, event, key, this.now(), this.timing, replay),
			webhook,
		);
		if (updated) this.schedule(updated);
	}

	// Delivery.

	/** Runs `work` in the background, where `idle` and `close` can wait for it. */
	private track(work: Promise<void>): Promise<void> {
		const tracked = work
			.catch((error) =>
				this.options.log?.("An agent webhook failed unexpectedly.", { error }),
			)
			.finally(() => this.working.delete(tracked));
		this.working.add(tracked);
		return tracked;
	}

	/**
	 * Sends a webhook's next POST when it is due, from a timer in this
	 * process. A POST due later than `maxTimerMs` is left to a sweep.
	 */
	private schedule(webhook: StoredAgentWebhook, minDelayMs = 0) {
		if (this.closing || !webhook.dueAt || webhook.status !== "active") return;
		const at = Math.max(Date.parse(webhook.dueAt), this.now() + minDelayMs);
		const delay = Math.max(0, at - this.now());
		if (delay > this.maxTimerMs) return;
		const key = webhook.agentId;
		const existing = this.timers.get(key);
		if (existing && existing.at <= at) return;
		if (existing) {
			clearTimeout(existing.timer);
			existing.done();
		}
		const { workspaceId, agentId } = webhook;
		this.track(
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					if (this.timers.get(key)?.timer === timer) this.timers.delete(key);
					// A failure reaches `track`, which logs it; the sweep retries.
					this.deliver(workspaceId, agentId).then(resolve, reject);
				}, delay);
				this.timers.set(key, { at, timer, done: resolve });
			}),
		);
	}

	/** Claims the webhook's due POST, sends it, and records how it went. */
	async deliver(workspaceId: string, agentId: string): Promise<void> {
		if (this.closing) return;
		const { repository } = this.options;
		const leaseId = randomUUID();
		const agent = await this.options.agents.find(agentId);
		const claim: { delivery: StoredDelivery | null } = { delivery: null };
		const held = await mutateWebhook(
			repository,
			workspaceId,
			agentId,
			(current) => {
				const taken = claimed(
					current,
					leaseId,
					this.now(),
					this.timing,
					agent?.name,
					agent?.permissions,
				);
				claim.delivery = taken?.delivery ?? null;
				return taken?.webhook ?? null;
			},
		);
		if (!held || !claim.delivery) {
			// Not due yet: a timer can fire a millisecond early, so look again.
			// Whoever holds a lease schedules what follows it, and a sender
			// that crashed leaves its delivery to the sweep.
			const current = held ?? (await repository.get(workspaceId, agentId));
			if (current && !(current.leaseUntil && current.leaseUntil > this.at()))
				this.schedule(current, 5);
			return;
		}
		const outcome = await this.attempt(held, claim.delivery, agent, leaseId);
		const after = await mutateWebhook(
			repository,
			workspaceId,
			agentId,
			(current) => finished(current, leaseId, outcome, this.now(), this.timing),
		);
		if (after) this.schedule(after);
	}

	/** Checks the agent may still be woken, then sends the delivery. */
	private async attempt(
		webhook: StoredAgentWebhook,
		delivery: StoredDelivery,
		agent: WebhookAgent | null,
		leaseId: string,
	): Promise<Outcome> {
		const own =
			agent &&
			(agent.workspaceId ??
				(await this.options.workspaces.defaultWorkspaceId()));
		if (!agent || agent.status === "revoked" || own !== webhook.workspaceId)
			return { kind: "revoked" };
		const workspace = await this.options.workspaces.get(webhook.workspaceId);
		if (agent.status === "expired" || !workspace || workspace.archivedAt)
			return { kind: "skipped" };
		const mayDeliver = (
			event: AgentWakeEvent,
			permissions: readonly string[],
		) => {
			if (event.type === "loop.assigned") {
				return (
					mayHear(event, permissions) &&
					(this.options.mayDeliverLoopAssignment?.(
						webhook.workspaceId,
						webhook.agentId,
						event,
					) ??
						false)
				);
			}
			if (
				event.type !== "decision.assigned" &&
				event.type !== "decision.outcome"
			)
				return true;
			return (
				mayHear(event, permissions) &&
				(this.options.mayDeliverDecision?.(
					webhook.workspaceId,
					webhook.agentId,
					event,
				) ??
					false)
			);
		};
		const allowed = await Promise.all(
			delivery.events.map((event) => mayDeliver(event, agent.permissions)),
		);
		const events = delivery.events.filter((_, i) => allowed[i]);
		if (!events.length) return { kind: "skipped" };
		const controller = new AbortController();
		this.sending.add(controller);
		try {
			const result = await this.send(
				webhook,
				{ id: webhook.agentId, name: delivery.agentName ?? agent.name },
				{ ...delivery, events },
				controller.signal,
				// The agent revoked or expired, or the webhook paused, deleted,
				// or taken over since the checks above: send nothing. The agent
				// is read again too, since revoking a token comes before its
				// webhook is deleted. A new secret or key is used.
				async () => {
					const [current, now] = await Promise.all([
						this.options.repository.get(webhook.workspaceId, webhook.agentId),
						this.options.agents.find(webhook.agentId),
					]);
					return now?.status === "active" &&
						current?.status === "active" &&
						current.leaseId === leaseId &&
						(
							await Promise.all(
								events.map((event) => mayDeliver(event, now.permissions)),
							)
						).every(Boolean)
						? current
						: null;
				},
			);
			if (this.closing && controller.signal.aborted)
				return { kind: "released" };
			switch (result.kind) {
				// Nothing went out; what follows depends on why (see `finished`).
				case "cancelled":
					return { kind: "released" };
				case "ok":
					return { kind: "ok" };
				case "gone":
					return { kind: "gone" };
				case "throttled":
					return { kind: "throttled", retryAfterMs: result.retryAfterMs };
				case "failed":
					return { kind: "failed", error: result.error };
			}
		} finally {
			this.sending.delete(controller);
		}
	}

	private send(
		webhook: StoredAgentWebhook,
		agent: { id: string; name: string },
		delivery: Pick<StoredDelivery, "id" | "createdAt" | "events" | "omitted">,
		signal?: AbortSignal,
		beforeSend?: () => Promise<StoredAgentWebhook | null>,
	): Promise<PostResult> {
		return post(
			webhook,
			delivery.id,
			wakeBody(webhook.workspaceId, agent, delivery),
			{
				transport: this.options.transport,
				resolver: this.options.resolver,
				timeoutMs: this.timeoutMs,
				now: this.now,
				signal,
				beforeSend,
			},
		);
	}

	/**
	 * Sends every POST that is due and nobody is sending: retries that wait
	 * longer than a timer, and deliveries a crashed process left behind.
	 */
	async sweep(): Promise<void> {
		if (this.closing) return;
		const due = await this.options.repository.due(this.at(), SWEEP_BATCH);
		await Promise.all(
			due.map((webhook) =>
				this.track(this.deliver(webhook.workspaceId, webhook.agentId)),
			),
		);
	}

	/**
	 * Starts a sweep unless one started recently. The Worker calls it after
	 * requests, since it has no timers between them.
	 */
	catchUp(): void {
		const now = this.now();
		if (this.closing || now - this.lastCatchUp < this.catchUpIntervalMs) return;
		this.lastCatchUp = now;
		void this.track(this.sweep());
	}

	/** Settles when nothing started by this process is waiting or sending. */
	async idle(): Promise<void> {
		while (this.working.size) await Promise.all([...this.working]);
	}

	/**
	 * Stops for shutdown. Waiting timers are dropped, since their POSTs stay
	 * due for the next sweep, and a POST in flight is stopped and handed back.
	 */
	async close(): Promise<void> {
		this.closing = true;
		for (const { timer, done } of this.timers.values()) {
			clearTimeout(timer);
			done();
		}
		this.timers.clear();
		for (const controller of this.sending) controller.abort();
		await this.idle();
	}
}

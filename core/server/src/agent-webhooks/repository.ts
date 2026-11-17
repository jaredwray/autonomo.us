import type {
	AgentWakeEvent,
	AgentWebhookDisabledReason,
	AgentWebhookEventGroup,
	AgentWebhookHeader,
	AgentWebhookStatus,
} from "@autonomo.us/common";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import { AgentWebhookError, webhooksUnavailable } from "./errors.js";

export const AGENT_WEBHOOKS_COLLECTION = "gateway_agent_webhooks";

/** One POST's content and how often it has been tried. */
export type StoredDelivery = {
	/** The `webhook-id` header: the same on every attempt of this delivery. */
	id: string;
	/** The payload's `timestamp`: when this delivery was made up. */
	createdAt: string;
	events: AgentWakeEvent[];
	omitted: number;
	/** The agent's name when the delivery was made up, so every attempt sends the same body. */
	agentName?: string;
	/** Attempts started so far, a crashed one included. */
	attempts: number;
};

/**
 * An agent's webhook: its settings, the events waiting for the next POST, the
 * delivery being tried, and the lease of whoever is sending it. One document
 * per agent, changed only by compare-and-set on `version`, so every rule
 * lives in `state.ts` and both stores behave alike.
 */
export type StoredAgentWebhook = {
	agentId: string;
	workspaceId: string;
	url: string;
	/** `whsec_` and the base64 of 32 random bytes. Kept in clear: the HMAC needs it. */
	secret: string;
	authKey: string | null;
	headers: AgentWebhookHeader[];
	events: AgentWebhookEventGroup[];
	status: AgentWebhookStatus;
	disabledReason: AgentWebhookDisabledReason | null;
	consecutiveFailures: number;
	lastDeliveryAt: string | null;
	lastFailureAt: string | null;
	lastError: string | null;
	createdAt: string;
	createdBy: string;
	updatedAt: string;
	/** Events since the last delivery was made up, oldest first. */
	queue: AgentWakeEvent[];
	/** Events that did not fit in `queue`. */
	omitted: number;
	/** The delivery being tried, or waiting for its next attempt. */
	delivery: StoredDelivery | null;
	/** When the next POST is due; null when nothing waits. */
	dueAt: string | null;
	leaseId: string | null;
	/** While this is in the future, the holder of `leaseId` is sending. */
	leaseUntil: string | null;
	/** Keys of recent events, so a retried post or decision is not sent twice. */
	recentKeys: string[];
	/**
	 * The latest message `seq`s reported from each channel, ascending, so a
	 * post retried long after its key left `recentKeys` is still recognized.
	 */
	channelSeqs: Record<string, number[]>;
	version: number;
};

/**
 * Storage for agent webhooks. The memory and MongoDB implementations satisfy
 * one contract (test/agent-webhooks-repository.test.ts).
 */
export interface AgentWebhookRepository {
	readonly persistence: "mongodb" | "memory";
	get(workspaceId: string, agentId: string): Promise<StoredAgentWebhook | null>;
	/** False when the agent already has a webhook. */
	insert(webhook: StoredAgentWebhook): Promise<boolean>;
	/**
	 * Replaces the webhook only while its version is still `expected`. The
	 * replacement carries its own version, `expected + 1`.
	 */
	replace(webhook: StoredAgentWebhook, expected: number): Promise<boolean>;
	delete(workspaceId: string, agentId: string): Promise<boolean>;
	/** The active webhooks of these agents. */
	active(
		workspaceId: string,
		agentIds: readonly string[],
	): Promise<StoredAgentWebhook[]>;
	/**
	 * The active webhooks that chose `group`: those of one workspace, or of
	 * every workspace when `workspaceId` is null.
	 */
	subscribed(
		workspaceId: string | null,
		group: AgentWebhookEventGroup,
	): Promise<StoredAgentWebhook[]>;
	/** Active webhooks whose next POST was due by `now`. */
	due(now: string, limit: number): Promise<StoredAgentWebhook[]>;
	close(): Promise<void>;
}

/** Most compare-and-set retries before a change gives up. */
const MAX_TRIES = 8;

/**
 * Reads a webhook, applies `change`, and writes the result if nobody wrote in
 * between, retrying from a fresh read when someone did. `change` returns null
 * to leave the webhook as it is. Returns the stored result, or null when the
 * webhook does not exist or `change` declined.
 */
export async function mutateWebhook(
	repository: AgentWebhookRepository,
	workspaceId: string,
	agentId: string,
	change: (current: StoredAgentWebhook) => StoredAgentWebhook | null,
	/** A copy read moments ago, to save the first read. */
	initial?: StoredAgentWebhook,
): Promise<StoredAgentWebhook | null> {
	let current = initial ?? (await repository.get(workspaceId, agentId));
	for (let tries = 0; tries < MAX_TRIES; tries++) {
		if (!current) return null;
		const next = change(current);
		if (!next) return null;
		const written = { ...next, version: current.version + 1 };
		if (await repository.replace(written, current.version)) return written;
		current = await repository.get(workspaceId, agentId);
	}
	throw new AgentWebhookError(
		"The webhook changed too often to save. Try again.",
		503,
	);
}

/** Agent webhooks kept in process memory, until restart. */
export class MemoryAgentWebhookRepository implements AgentWebhookRepository {
	readonly persistence = "memory" as const;
	private readonly webhooks = new Map<string, StoredAgentWebhook>();

	async get(workspaceId: string, agentId: string) {
		const found = this.webhooks.get(agentId);
		return found?.workspaceId === workspaceId ? structuredClone(found) : null;
	}
	async insert(webhook: StoredAgentWebhook) {
		if (this.webhooks.has(webhook.agentId)) return false;
		this.webhooks.set(webhook.agentId, structuredClone(webhook));
		return true;
	}
	async replace(webhook: StoredAgentWebhook, expected: number) {
		const current = this.webhooks.get(webhook.agentId);
		if (
			current?.workspaceId !== webhook.workspaceId ||
			current.version !== expected
		)
			return false;
		this.webhooks.set(webhook.agentId, structuredClone(webhook));
		return true;
	}
	async delete(workspaceId: string, agentId: string) {
		if (this.webhooks.get(agentId)?.workspaceId !== workspaceId) return false;
		return this.webhooks.delete(agentId);
	}
	async active(workspaceId: string, agentIds: readonly string[]) {
		return agentIds
			.map((id) => this.webhooks.get(id))
			.filter(
				(webhook): webhook is StoredAgentWebhook =>
					webhook?.workspaceId === workspaceId && webhook.status === "active",
			)
			.map((webhook) => structuredClone(webhook));
	}
	async subscribed(workspaceId: string | null, group: AgentWebhookEventGroup) {
		return [...this.webhooks.values()]
			.filter(
				(webhook) =>
					webhook.status === "active" &&
					webhook.events.includes(group) &&
					(workspaceId === null || webhook.workspaceId === workspaceId),
			)
			.map((webhook) => structuredClone(webhook));
	}
	async due(now: string, limit: number) {
		return [...this.webhooks.values()]
			.filter(
				(webhook) =>
					webhook.status === "active" &&
					webhook.dueAt !== null &&
					webhook.dueAt <= now,
			)
			.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))
			.slice(0, limit)
			.map((webhook) => structuredClone(webhook));
	}
	async close() {}
}

type WebhookDocument = Omit<StoredAgentWebhook, "agentId"> & { _id: string };
const toWebhook = ({ _id, ...rest }: WebhookDocument): StoredAgentWebhook => ({
	agentId: _id,
	...rest,
});

/** Agent webhooks in MongoDB, on the shared control-plane connection. */
export class MongoAgentWebhookRepository implements AgentWebhookRepository {
	readonly persistence = "mongodb" as const;
	private readonly mongo: MongoConnection;
	private indexed?: Promise<void>;
	constructor(mongo: string | MongoConnection) {
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}
	private webhooks() {
		return this.mongo.collection<WebhookDocument>(AGENT_WEBHOOKS_COLLECTION);
	}
	private ensureIndexes(): Promise<void> {
		this.indexed ??= (async () => {
			await this.webhooks().createIndexes([
				{ key: { workspaceId: 1 }, name: "workspace" },
				{ key: { status: 1, dueAt: 1 }, name: "status_due" },
			]);
		})();
		this.indexed.catch(() => {
			this.indexed = undefined;
		});
		return this.indexed;
	}
	private async storage<T>(operation: () => Promise<T>): Promise<T> {
		try {
			await this.ensureIndexes();
			return await operation();
		} catch (error) {
			if (error instanceof AgentWebhookError) throw error;
			throw webhooksUnavailable(error);
		}
	}

	async get(workspaceId: string, agentId: string) {
		// `$eq` compares values only: an id that arrived as an object cannot act as an operator.
		const found = await this.storage(() =>
			this.webhooks().findOne({
				_id: { $eq: agentId },
				workspaceId: { $eq: workspaceId },
			}),
		);
		return found ? toWebhook(found) : null;
	}
	insert(webhook: StoredAgentWebhook) {
		const { agentId, ...rest } = webhook;
		return this.storage(async () => {
			try {
				await this.webhooks().insertOne({ _id: agentId, ...rest });
				return true;
			} catch (error) {
				if (isDuplicateKey(error)) return false;
				throw error;
			}
		});
	}
	replace(webhook: StoredAgentWebhook, expected: number) {
		const { agentId, ...rest } = webhook;
		return this.storage(async () => {
			const result = await this.webhooks().replaceOne(
				{
					_id: { $eq: agentId },
					workspaceId: { $eq: webhook.workspaceId },
					version: expected,
				},
				rest,
			);
			return result.matchedCount > 0;
		});
	}
	delete(workspaceId: string, agentId: string) {
		return this.storage(async () => {
			const result = await this.webhooks().deleteOne({
				_id: { $eq: agentId },
				workspaceId: { $eq: workspaceId },
			});
			return result.deletedCount > 0;
		});
	}
	async active(workspaceId: string, agentIds: readonly string[]) {
		if (!agentIds.length) return [];
		const found = await this.storage(() =>
			this.webhooks()
				.find({
					_id: { $in: [...agentIds] },
					workspaceId: { $eq: workspaceId },
					status: "active",
				})
				.toArray(),
		);
		return found.map(toWebhook);
	}
	async subscribed(workspaceId: string | null, group: AgentWebhookEventGroup) {
		const found = await this.storage(() =>
			this.webhooks()
				.find({
					status: "active",
					// Matches a webhook whose `events` list holds the group.
					events: { $eq: group },
					...(workspaceId === null
						? {}
						: { workspaceId: { $eq: workspaceId } }),
				})
				.toArray(),
		);
		return found.map(toWebhook);
	}
	async due(now: string, limit: number) {
		const found = await this.storage(() =>
			this.webhooks()
				// ISO timestamps compare as strings.
				.find({ status: "active", dueAt: { $ne: null, $lte: now } })
				.sort({ dueAt: 1 })
				.limit(limit)
				.toArray(),
		);
		return found.map(toWebhook);
	}
	async close() {
		await this.mongo.close();
	}
}

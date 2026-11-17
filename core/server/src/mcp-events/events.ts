import { createHash, randomUUID } from "node:crypto";
import type { Channel, ChannelMessage } from "@autonomo.us/common";
import {
	argumentProblem,
	type McpAgent,
	RPC,
	RpcError,
	requireGrant,
	schema,
} from "../mcp/server.js";
import { type Callback, callbackUrl, validSecret } from "./callback.js";
import {
	type EventRepository,
	mutate,
	type Subscription,
} from "./repository.js";

const inputSchema = schema(
	{
		channel_id: {
			type: "string",
			description:
				"Exact channel ID from channels_list. The connected agent must be a member.",
			minLength: 1,
			maxLength: 100,
		},
		thread_id: {
			type: "string",
			description:
				"Optional exact root message ID to monitor only replies in that thread.",
			minLength: 1,
			maxLength: 100,
		},
	},
	["channel_id"],
);
export const EVENT_DEFINITIONS = [
	[
		"channel.message",
		"A new message from a person or API token in a channel the agent belongs to. Agent-authored messages are excluded to prevent feedback loops.",
	],
	[
		"channel.mention",
		"A new channel message explicitly mentions the connected agent. The agent's own messages are excluded.",
	],
	[
		"channel.reply",
		"A person or API token replies in a thread started by the connected agent.",
	],
].map(([name, description]) => ({
	name,
	description,
	delivery: ["webhook"],
	inputSchema,
	payloadSchema: {
		type: "object",
		properties: {
			channel_id: { type: "string" },
			message_id: { type: "string" },
			seq: { type: "integer" },
			thread_id: { type: ["string", "null"] },
			author: {
				type: "object",
				properties: {
					kind: { type: "string" },
					id: { type: "string" },
					name: { type: "string" },
				},
				required: ["kind", "id", "name"],
				additionalProperties: false,
			},
		},
		required: ["channel_id", "message_id", "seq", "thread_id", "author"],
		additionalProperties: false,
	},
}));
const invalid = () =>
	new RpcError(RPC.invalidParams, "Invalid MCP event parameters.");
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw invalid();
	return value as Record<string, unknown>;
}
/** All arguments are flat, validated scalar values; sorted keys give canonical JSON. */
export function subscriptionId(
	agent: Pick<McpAgent, "token" | "workspace" | "grantId">,
	url: string,
	name: string,
	args: Record<string, unknown>,
) {
	return `sub_${createHash("sha256")
		.update(
			JSON.stringify([
				agent.workspace.id,
				agent.token.id,
				agent.grantId ?? null,
				url,
				name,
				Object.fromEntries(
					Object.keys(args)
						.sort()
						.map((key) => [key, args[key]]),
				),
			]),
		)
		.digest("hex")}`;
}
export type EventsOptions = {
	repository: EventRepository;
	callback: Callback;
	/** Reads current token, OAuth connection, workspace and channel access. */
	authorized(
		subscription: Pick<
			Subscription,
			"workspaceId" | "agentId" | "grantId" | "arguments"
		>,
	): Promise<boolean>;
	threadAuthor(
		workspaceId: string,
		channelId: string,
		messageId: string,
	): Promise<{ kind: string; id: string } | null>;
	now?: () => number;
};
const LIFETIME = 24 * 60 * 60 * 1000;
const VERIFY_CACHE = 5 * 60 * 1000;
const ROTATION = 5 * 60 * 1000;
const BACKOFF = [1000, 5000, 30000, 120000, 600000];
export class McpEvents {
	private now: () => number;
	private working = new Set<Promise<void>>();
	private closing = false;
	private verification = new Map<string, number>();
	constructor(private readonly options: EventsOptions) {
		this.now = options.now ?? Date.now;
	}
	async handle(
		agent: McpAgent,
		method: string,
		raw: unknown,
	): Promise<unknown> {
		try {
			return await this.dispatch(agent, method, raw);
		} catch (error) {
			if (error instanceof RpcError) throw error;
			// Storage/transport exceptions can contain credentials. Never forward or log them.
			throw new RpcError(
				RPC.internal,
				"MCP Events is temporarily unavailable.",
			);
		}
	}
	private async dispatch(agent: McpAgent, method: string, raw: unknown) {
		requireGrant(agent, "mcp:read");
		const params = object(raw ?? {});
		if (method === "events/list") {
			if (
				Object.keys(params).some((key) => key !== "cursor") ||
				(params.cursor !== undefined && params.cursor !== null)
			)
				throw invalid();
			return {
				events: agent.token.permissions.includes("mcp:call")
					? EVENT_DEFINITIONS
					: [],
			};
		}
		requireGrant(agent, "mcp:call");
		if (!["events/subscribe", "events/unsubscribe"].includes(method))
			throw new RpcError(RPC.methodNotFound, "Unknown event method.");
		if (
			Object.keys(params).some(
				(key) =>
					!["name", "arguments", "delivery", "cursor", "ttlMs"].includes(key),
			)
		)
			throw invalid();
		if (
			typeof params.name !== "string" ||
			!EVENT_DEFINITIONS.some((x) => x.name === params.name) ||
			argumentProblem(inputSchema, params.arguments)
		)
			throw invalid();
		if (params.cursor !== undefined && params.cursor !== null) throw invalid();
		const args = params.arguments as Subscription["arguments"];
		const delivery = object(params.delivery);
		if (
			delivery.mode !== "webhook" ||
			Object.keys(delivery).some(
				(key) => !["mode", "url", "secret"].includes(key),
			)
		)
			throw invalid();
		const url = callbackUrl(delivery.url);
		const id = subscriptionId(agent, url, params.name, args);
		const repository = this.options.repository;
		if (method === "events/unsubscribe") {
			// Deterministic identity includes the principal; another connection cannot stop this one.
			await mutate(repository, id, (row) => ({
				...row,
				active: false,
				secret: "",
				previousSecret: undefined,
				rotateUntil: undefined,
				queue: [],
				leaseId: null,
				leaseUntil: 0,
			}));
			return {};
		}
		if (!validSecret(delivery.secret)) throw invalid();
		const ttl = params.ttlMs;
		if (
			ttl !== undefined &&
			ttl !== null &&
			(typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0)
		)
			throw invalid();
		const owner = {
			workspaceId: agent.workspace.id,
			agentId: agent.token.id,
			...(agent.grantId ? { grantId: agent.grantId } : {}),
			arguments: args,
		};
		if (!(await this.options.authorized(owner)))
			throw new RpcError(
				RPC.forbidden,
				"This agent cannot subscribe to that channel.",
			);
		const current = await repository.get(id);
		const now = this.now();
		const expiresAt =
			now + (typeof ttl === "number" ? Math.min(ttl, LIFETIME) : LIFETIME);
		// Include the secret hash to ensure a replacement key is also proven at the receiver.
		const cacheKey = createHash("sha256")
			.update(
				JSON.stringify([
					owner.workspaceId,
					owner.agentId,
					owner.grantId,
					url,
					delivery.secret,
				]),
			)
			.digest("hex");
		const cached = this.verification.get(cacheKey) ?? 0;
		let verifiedUntil =
			current?.active && current.secret === delivery.secret
				? Math.max(current.verifiedUntil, cached)
				: cached;
		if (verifiedUntil <= now) {
			await this.options.callback.verify(
				{ id, url, secret: delivery.secret },
				now,
			);
			// Bound the in-process cache; persistent per-subscription verification survives restarts.
			for (const [key, until] of this.verification)
				if (until <= now) this.verification.delete(key);
			if (this.verification.size >= 1000) this.verification.clear();
			verifiedUntil = now + VERIFY_CACHE;
			this.verification.set(cacheKey, verifiedUntil);
		}
		if (!(await this.options.authorized(owner)))
			throw new RpcError(RPC.forbidden, "Subscription access was revoked.");
		const fresh: Subscription = {
			...owner,
			id,
			name: params.name,
			url,
			secret: delivery.secret,
			expiresAt,
			verifiedUntil,
			active: true,
			queue: [],
			seen: [],
			leaseId: null,
			leaseUntil: 0,
			version: 0,
		};
		if (!(await repository.insert(fresh)))
			await mutate(repository, id, (row) => ({
				...row,
				active: true,
				expiresAt,
				verifiedUntil: fresh.verifiedUntil,
				secret: fresh.secret,
				...(row.secret && row.secret !== fresh.secret
					? { previousSecret: row.secret, rotateUntil: now + ROTATION }
					: {}),
			}));
		return {
			id,
			refreshBefore: new Date(expiresAt).toISOString(),
			cursor: null,
			truncated: false,
		};
	}
	async onMessage(channel: Channel, message: ChannelMessage): Promise<void> {
		if (channel.archivedAt || message.deletedAt || this.closing) return;
		const subscriptions = await this.options.repository.channel(
			channel.workspaceId,
			channel.id,
		);
		let root: { kind: string; id: string } | null | undefined;
		for (const row of subscriptions) {
			if (
				row.expiresAt <= this.now() ||
				(message.author.kind === "agent" &&
					message.author.id === row.agentId) ||
				(row.arguments.thread_id &&
					row.arguments.thread_id !== message.threadId)
			)
				continue;
			const mention = message.mentions.some(
				(x) => x.kind === "agent" && x.id === row.agentId,
			);
			if (row.name === "channel.mention" && !mention) continue;
			if (row.name !== "channel.mention" && message.author.kind === "agent")
				continue;
			if (row.name === "channel.reply") {
				if (!message.threadId) continue;
				if (root === undefined)
					root = await this.options.threadAuthor(
						channel.workspaceId,
						channel.id,
						message.threadId,
					);
				if (root?.kind !== "agent" || root.id !== row.agentId) continue;
			}
			if (!(await this.options.authorized(row))) continue;
			const eventId = `evt_${createHash("sha256")
				.update(
					JSON.stringify([
						channel.workspaceId,
						channel.id,
						message.id,
						row.name,
					]),
				)
				.digest("hex")}`;
			await mutate(this.options.repository, row.id, (current) => {
				if (
					!current.active ||
					current.expiresAt <= this.now() ||
					current.seen.includes(eventId) ||
					current.queue.some((x) => x.event.eventId === eventId)
				)
					return null;
				if (current.queue.length >= 1000)
					throw new Error("MCP event queue full");
				return {
					...current,
					seen: [...current.seen, eventId].slice(-1000),
					queue: [
						...current.queue,
						{
							attempts: 0,
							dueAt: this.now(),
							event: {
								eventId,
								name: row.name,
								timestamp: message.createdAt,
								cursor: null,
								data: {
									channel_id: channel.id,
									message_id: message.id,
									seq: message.seq,
									thread_id: message.threadId,
									author: message.author,
								},
							},
						},
					],
				};
			});
		}
		this.catchUp();
	}
	catchUp() {
		if (this.closing || this.working.size) return;
		void this.sweep().catch(() => {});
	}
	async sweep(maxPerSubscription = 50) {
		if (this.closing) return;
		// Control-port sweeps must drain before close() releases MongoDB too.
		const work = this.sweepBatch(maxPerSubscription);
		this.working.add(work);
		try {
			await work;
		} finally {
			this.working.delete(work);
		}
	}
	private async sweepBatch(maxPerSubscription: number) {
		const due = await this.options.repository.due(this.now());
		await Promise.all(
			due.map(async (row) => {
				for (
					let count = 0;
					count < maxPerSubscription && !this.closing;
					count++
				) {
					await this.deliver(row.id);
					const current = await this.options.repository.get(row.id);
					if (
						!current?.active ||
						!current.queue.length ||
						current.queue[0].dueAt > this.now() ||
						current.leaseUntil > this.now()
					)
						break;
				}
			}),
		);
	}
	private async deliver(id: string) {
		const leaseId = randomUUID();
		const held = await mutate(this.options.repository, id, (row) => {
			if (
				!row.active ||
				!row.queue.length ||
				row.queue[0].dueAt > this.now() ||
				row.leaseUntil > this.now()
			)
				return null;
			return {
				...row,
				leaseId,
				leaseUntil: this.now() + 60_000,
				queue: [
					{ ...row.queue[0], attempts: row.queue[0].attempts + 1 },
					...row.queue.slice(1),
				],
			};
		});
		if (!held) return;
		let status = 0;
		let authorized: boolean | undefined;
		const pending = held.queue[0];
		try {
			authorized =
				held.expiresAt > this.now() && (await this.options.authorized(held));
			if (authorized && pending.attempts <= BACKOFF.length + 1) {
				status = (
					await this.options.callback.post(
						held,
						pending.event.eventId,
						JSON.stringify(pending.event),
						this.now(),
						false,
						async () => {
							const current = await this.options.repository.get(id);
							return (
								!this.closing &&
								current?.active === true &&
								current.leaseId === leaseId &&
								current.expiresAt > this.now() &&
								current.secret === held.secret &&
								(await this.options.authorized(current))
							);
						},
					)
				).status;
			}
		} catch {
			/* Only status and attempt count are persisted, never error text. */
		}
		await mutate(this.options.repository, id, (row) => {
			if (row.leaseId !== leaseId) return null;
			const base = { ...row, leaseId: null, leaseUntil: 0 };
			if (authorized === false || status === 410 || row.expiresAt <= this.now())
				return {
					...base,
					active: false,
					secret: "",
					previousSecret: undefined,
					queue: [],
				};
			const retry =
				status === 0 || status === 408 || status === 429 || status >= 500;
			const delay = BACKOFF[pending.attempts - 1];
			if (!retry || delay === undefined)
				return { ...base, queue: row.queue.slice(1) };
			return {
				...base,
				queue: [
					{ ...row.queue[0], dueAt: this.now() + delay },
					...row.queue.slice(1),
				],
			};
		});
	}
	async idle() {
		while (this.working.size) await Promise.allSettled([...this.working]);
	}
	async close() {
		this.closing = true;
		await this.idle();
	}
}

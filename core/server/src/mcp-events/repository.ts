import type { MongoConnection } from "../mongo.js";
import { isDuplicateKey } from "../mongo.js";

export type Event = {
	eventId: string;
	name: string;
	timestamp: string;
	data: {
		channel_id: string;
		message_id: string;
		seq: number;
		thread_id: string | null;
		author: { kind: string; id: string; name: string };
	};
	cursor: null;
};
export type Subscription = {
	id: string;
	workspaceId: string;
	agentId: string;
	grantId?: string;
	name: string;
	arguments: { channel_id: string; thread_id?: string };
	url: string;
	/** Sensitive: never include in RPC responses or logs. Database access must be restricted. */
	secret: string;
	previousSecret?: string;
	rotateUntil?: number;
	expiresAt: number;
	verifiedUntil: number;
	active: boolean;
	queue: Array<{ event: Event; attempts: number; dueAt: number }>;
	/** Durable deduplication for retried channel posts. */
	seen: string[];
	leaseId: string | null;
	leaseUntil: number;
	version: number;
};

export interface EventRepository {
	get(id: string): Promise<Subscription | null>;
	insert(value: Subscription): Promise<boolean>;
	replace(value: Subscription, version: number): Promise<boolean>;
	channel(workspaceId: string, channelId: string): Promise<Subscription[]>;
	due(now: number): Promise<Subscription[]>;
}

/** Test adapter; production enables events only with MongoDB. */
export class MemoryEventRepository implements EventRepository {
	private rows = new Map<string, Subscription>();
	async get(id: string) {
		return structuredClone(this.rows.get(id) ?? null);
	}
	async insert(value: Subscription) {
		if (this.rows.has(value.id)) return false;
		this.rows.set(value.id, structuredClone(value));
		return true;
	}
	async replace(value: Subscription, version: number) {
		if (this.rows.get(value.id)?.version !== version) return false;
		this.rows.set(value.id, structuredClone(value));
		return true;
	}
	async channel(workspaceId: string, channelId: string) {
		return structuredClone(
			[...this.rows.values()].filter(
				(x) =>
					x.active &&
					x.workspaceId === workspaceId &&
					x.arguments.channel_id === channelId,
			),
		);
	}
	async due(now: number) {
		return structuredClone(
			[...this.rows.values()]
				.filter(
					(x) =>
						x.active &&
						x.queue.length &&
						x.queue[0].dueAt <= now &&
						x.leaseUntil <= now,
				)
				.slice(0, 50),
		);
	}
}

export const EVENTS_COLLECTION = "gateway_mcp_event_subscriptions";
type Document = Subscription & { _id: string; purgeAt: Date };
export class MongoEventRepository implements EventRepository {
	private indexed?: Promise<unknown>;
	constructor(private readonly mongo: MongoConnection) {}
	private async collection() {
		const collection = this.mongo.collection<Document>(EVENTS_COLLECTION);
		this.indexed ??= collection
			.createIndexes([
				{ key: { purgeAt: 1 }, name: "expiry_cleanup", expireAfterSeconds: 0 },
				{
					key: { workspaceId: 1, "arguments.channel_id": 1, active: 1 },
					name: "channel",
				},
				{ key: { active: 1, "queue.0.dueAt": 1, leaseUntil: 1 }, name: "due" },
			])
			.catch((error) => {
				this.indexed = undefined;
				throw error;
			});
		await this.indexed;
		return collection;
	}
	async get(id: string) {
		const document = await (await this.collection()).findOne({
			_id: { $eq: id },
		});
		return document ? subscription(document) : null;
	}
	async insert(value: Subscription) {
		try {
			await (await this.collection()).insertOne({
				...value,
				_id: value.id,
				purgeAt: new Date(value.expiresAt + 86400000),
			});
			return true;
		} catch (error) {
			if (isDuplicateKey(error)) return false;
			throw error;
		}
	}
	async replace(value: Subscription, version: number) {
		return (
			(
				await (
					await this.collection()
				).replaceOne(
					{ _id: { $eq: value.id }, version },
					{
						...value,
						purgeAt: new Date(value.expiresAt + 86400000),
					},
				)
			).matchedCount > 0
		);
	}
	async channel(workspaceId: string, channelId: string) {
		return (
			await (
				await this.collection()
			)
				.find({
					workspaceId: { $eq: workspaceId },
					"arguments.channel_id": { $eq: channelId },
					active: true,
				})
				.toArray()
		).map(subscription);
	}
	async due(now: number) {
		return (
			await (
				await this.collection()
			)
				.find({
					active: true,
					"queue.0.dueAt": { $lte: now },
					leaseUntil: { $lte: now },
				})
				.sort({ "queue.0.dueAt": 1 })
				.limit(50)
				.toArray()
		).map(subscription);
	}
}

export async function mutate(
	repository: EventRepository,
	id: string,
	change: (row: Subscription) => Subscription | null,
) {
	for (let i = 0; i < 12; i++) {
		const current = await repository.get(id);
		if (!current) return null;
		const next = change(current);
		if (!next) return null;
		next.version = current.version + 1;
		if (await repository.replace(next, current.version)) return next;
	}
	throw new Error("MCP event storage contention");
}

function subscription({ _id, purgeAt, ...value }: Document): Subscription {
	return value;
}

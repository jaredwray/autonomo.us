import type { Document } from "mongodb";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import { ChannelError, channelsUnavailable } from "./errors.js";
import type {
	ChannelFilter,
	ChannelRepository,
	StoredChannel,
	StoredEntry,
	StoredMessage,
} from "./repository.js";

export const CHANNELS_COLLECTION = "channels";
export const CHANNEL_MESSAGES_COLLECTION = "channel_messages";
export const CHANNEL_READS_COLLECTION = "channel_reads";

type ChannelDocument = Omit<StoredChannel, "id"> & { _id: string };
type EntryDocument = Omit<StoredEntry, "id"> & { _id: string };
type ReadDocument = {
	_id: string;
	workspaceId: string;
	channelId: string;
	readerKey: string;
	readSeq: number;
	updatedAt: string;
};

const toChannel = ({ _id, ...rest }: ChannelDocument): StoredChannel => ({
	id: _id,
	...rest,
});
const toEntry = ({ _id, ...rest }: EntryDocument) =>
	({ id: _id, ...rest }) as StoredEntry;
const readId = (channelId: string, readerKey: string) =>
	`${channelId}|${readerKey}`;

/** Channels, their logs, and read marks in MongoDB; see docs/CHANNELS_PLAN.md §4.2. */
export class MongoChannelRepository implements ChannelRepository {
	readonly persistence = "mongodb" as const;
	private readonly mongo: MongoConnection;
	private indexed?: Promise<void>;
	constructor(mongo: string | MongoConnection) {
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}
	private channels() {
		return this.mongo.collection<ChannelDocument>(CHANNELS_COLLECTION);
	}
	private entries() {
		return this.mongo.collection<EntryDocument>(CHANNEL_MESSAGES_COLLECTION);
	}
	private reads() {
		return this.mongo.collection<ReadDocument>(CHANNEL_READS_COLLECTION);
	}

	/** Created once per process; the order of the log depends on `channel_seq`. */
	ensureIndexes(): Promise<void> {
		this.indexed ??= (async () => {
			await this.channels().createIndexes([
				{
					key: { workspaceId: 1, nameKey: 1 },
					unique: true,
					name: "workspace_name",
				},
				{
					key: { workspaceId: 1, "agents.agentTokenId": 1 },
					name: "workspace_agent",
				},
				{
					key: { workspaceId: 1, createdByKey: 1, createdAt: 1 },
					name: "workspace_creator",
				},
			]);
			await this.entries().createIndexes([
				{ key: { channelId: 1, seq: 1 }, unique: true, name: "channel_seq" },
				{
					key: { channelId: 1, authorKey: 1, nonce: 1 },
					unique: true,
					partialFilterExpression: { nonce: { $type: "string" } },
					name: "channel_author_nonce",
				},
				{
					key: { channelId: 1, mentionKeys: 1, seq: 1 },
					name: "channel_mentions",
				},
				{
					key: { channelId: 1, authorKey: 1, createdAt: 1 },
					name: "channel_author",
				},
				{ key: { channelId: 1, threadId: 1, seq: 1 }, name: "channel_thread" },
			]);
			await this.reads().createIndex(
				{ workspaceId: 1, readerKey: 1 },
				{ name: "workspace_reader" },
			);
		})();
		this.indexed.catch(() => {
			this.indexed = undefined;
		});
		return this.indexed;
	}
	/** Runs `operation` once the indexes exist; driver failures become 503s. */
	private async storage<T>(operation: () => Promise<T>): Promise<T> {
		try {
			await this.ensureIndexes();
			return await operation();
		} catch (error) {
			if (error instanceof ChannelError) throw error;
			throw channelsUnavailable(error);
		}
	}

	insertChannel(channel: StoredChannel) {
		const { id, ...rest } = channel;
		return this.storage(async () => {
			try {
				await this.channels().insertOne({ _id: id, ...rest });
				return true;
			} catch (error) {
				if (isDuplicateKey(error)) return false;
				throw error;
			}
		});
	}
	async getChannel(workspaceId: string, id: string) {
		const found = await this.storage(() =>
			this.channels().findOne({ _id: id, workspaceId }),
		);
		return found ? toChannel(found) : null;
	}
	async getChannelByName(workspaceId: string, nameKey: string) {
		const found = await this.storage(() =>
			this.channels().findOne({ workspaceId, nameKey }),
		);
		return found ? toChannel(found) : null;
	}
	async listChannels(workspaceId: string, filter: ChannelFilter = {}) {
		const query: Document = { workspaceId };
		if (filter.archived !== undefined)
			query.archivedAt = filter.archived ? { $ne: null } : null;
		if (filter.agentTokenId !== undefined)
			query["agents.agentTokenId"] = filter.agentTokenId;
		const found = await this.storage(() =>
			this.channels().find(query).sort({ nameKey: 1 }).toArray(),
		);
		return found.map(toChannel);
	}
	countOpenChannels(workspaceId: string) {
		return this.storage(() =>
			this.channels().countDocuments({ workspaceId, archivedAt: null }),
		);
	}
	countChannelsCreatedBy(
		workspaceId: string,
		createdByKey: string,
		since: string,
	) {
		return this.storage(() =>
			this.channels().countDocuments({
				workspaceId,
				createdByKey,
				createdAt: { $gte: since },
			}),
		);
	}
	replaceChannel(channel: StoredChannel, expectedRevision: number) {
		// The log summary is left out: touchChannel owns it, and writing back
		// the values this caller read would move it backwards.
		const {
			id,
			workspaceId,
			lastSeq: _lastSeq,
			lastMessageSeq: _lastMessageSeq,
			lastMessageAt: _lastMessageAt,
			...fields
		} = channel;
		return this.storage(async () => {
			try {
				const result = await this.channels().updateOne(
					{ _id: id, workspaceId, revision: expectedRevision },
					{ $set: fields },
				);
				return result.matchedCount ? ("ok" as const) : ("conflict" as const);
			} catch (error) {
				if (isDuplicateKey(error)) return "name-taken" as const;
				throw error;
			}
		});
	}
	async touchChannel(
		workspaceId: string,
		id: string,
		summary: {
			lastSeq: number;
			lastMessageSeq?: number;
			lastMessageAt?: string;
		},
	) {
		await this.storage(() =>
			this.channels().updateOne(
				{ _id: id, workspaceId },
				{
					$max: {
						lastSeq: summary.lastSeq,
						...(summary.lastMessageSeq === undefined
							? {}
							: { lastMessageSeq: summary.lastMessageSeq }),
						// ISO timestamps order as strings.
						...(summary.lastMessageAt === undefined
							? {}
							: { lastMessageAt: summary.lastMessageAt }),
					},
				},
			),
		);
	}

	async topSeq(channelId: string) {
		const top = await this.storage(() =>
			this.entries().findOne(
				{ channelId },
				{ sort: { seq: -1 }, projection: { seq: 1 } },
			),
		);
		return top?.seq ?? 0;
	}
	insertEntry(entry: StoredEntry) {
		const { id, ...rest } = entry;
		return this.storage(async () => {
			try {
				await this.entries().insertOne({ _id: id, ...rest } as EntryDocument);
				return "ok" as const;
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
				const pattern = (error as { keyPattern?: Record<string, unknown> })
					.keyPattern;
				return pattern && "nonce" in pattern
					? ("nonce-taken" as const)
					: ("seq-taken" as const);
			}
		});
	}
	async getEntry(workspaceId: string, channelId: string, id: string) {
		const found = await this.storage(() =>
			this.entries().findOne({ _id: id, workspaceId, channelId }),
		);
		return found ? toEntry(found) : null;
	}
	async getEntries(channelId: string, ids: string[]) {
		if (!ids.length) return [];
		const found = await this.storage(() =>
			this.entries()
				.find({ _id: { $in: ids }, channelId })
				.toArray(),
		);
		return found.map(toEntry);
	}
	async findByNonce(channelId: string, authorKey: string, nonce: string) {
		const found = await this.storage(() =>
			this.entries().findOne({ channelId, authorKey, nonce }),
		);
		return found ? (toEntry(found) as StoredMessage) : null;
	}
	async entriesAfter(
		channelId: string,
		after: number,
		limit: number,
		filter: { mentionKey?: string } = {},
	) {
		const found = await this.storage(() =>
			this.entries()
				.find({
					channelId,
					seq: { $gt: after },
					...(filter.mentionKey === undefined
						? {}
						: { mentionKeys: filter.mentionKey }),
				})
				.sort({ seq: 1 })
				.limit(limit)
				.toArray(),
		);
		return found.map(toEntry);
	}
	async entriesBefore(
		channelId: string,
		before: number | undefined,
		limit: number,
	) {
		const found = await this.storage(() =>
			this.entries()
				.find({
					channelId,
					...(before === undefined ? {} : { seq: { $lt: before } }),
					$or: [{ type: "system" }, { type: "message", threadId: null }],
				})
				.sort({ seq: -1 })
				.limit(limit)
				.toArray(),
		);
		return found.map(toEntry);
	}
	async threadReplies(
		channelId: string,
		threadId: string,
		limit: number,
		after = 0,
	) {
		const found = await this.storage(() =>
			this.entries()
				.find({ channelId, threadId, type: "message", seq: { $gt: after } })
				.sort({ seq: 1 })
				.limit(limit)
				.toArray(),
		);
		return found.map(toEntry) as StoredMessage[];
	}
	replaceMessage(message: StoredMessage, expectedRevision: number) {
		// The reply count is left out: addReply owns it.
		const {
			id,
			channelId,
			seq: _seq,
			replyCount: _replyCount,
			...fields
		} = message;
		return this.storage(async () => {
			const result = await this.entries().updateOne(
				{ _id: id, channelId, type: "message", revision: expectedRevision },
				{ $set: fields },
			);
			return result.matchedCount > 0;
		});
	}
	async addReply(channelId: string, messageId: string) {
		await this.storage(() =>
			this.entries().updateOne(
				{ _id: messageId, channelId, type: "message" },
				{ $inc: { replyCount: 1 } },
			),
		);
	}
	countAuthorMessages(channelId: string, authorKey: string, since: string) {
		return this.storage(() =>
			this.entries().countDocuments({
				channelId,
				authorKey,
				createdAt: { $gte: since },
				type: "message",
			}),
		);
	}
	countMentions(channelId: string, mentionKey: string, afterSeq: number) {
		return this.storage(() =>
			this.entries().countDocuments({
				channelId,
				mentionKeys: mentionKey,
				seq: { $gt: afterSeq },
			}),
		);
	}

	async readMarks(workspaceId: string, readerKey: string) {
		const found = await this.storage(() =>
			this.reads().find({ workspaceId, readerKey }).toArray(),
		);
		return new Map(found.map((mark) => [mark.channelId, mark.readSeq]));
	}
	async readMark(channelId: string, readerKey: string) {
		const found = await this.storage(() =>
			this.reads().findOne({ _id: readId(channelId, readerKey) }),
		);
		return found?.readSeq ?? 0;
	}
	async raiseReadMark(
		workspaceId: string,
		channelId: string,
		readerKey: string,
		seq: number,
		at: string,
	) {
		const updated = await this.storage(() =>
			this.reads().findOneAndUpdate(
				{ _id: readId(channelId, readerKey) },
				{
					$max: { readSeq: seq },
					$set: { updatedAt: at },
					$setOnInsert: { workspaceId, channelId, readerKey },
				},
				{ upsert: true, returnDocument: "after" },
			),
		);
		return updated?.readSeq ?? seq;
	}
	async close() {
		await this.mongo.close();
	}
}

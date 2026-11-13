import type {
	Channel,
	ChannelAction,
	ChannelActor,
	ChannelMention,
} from "@autonomo.us/common";

/** A channel plus the fields queries and the channel list run on. */
export type StoredChannel = Channel & {
	/** Lowercased name; unique in the workspace. */
	nameKey: string;
	/** `<kind>:<id>` of the creator, for the creation rate limit. */
	createdByKey: string;
	/** Summary of the log, updated after each append; see `touchChannel`. */
	lastSeq: number;
	lastMessageSeq: number;
	lastMessageAt: string | null;
	/** Latest 100 changes, oldest first. */
	actions: ChannelAction[];
};

type EntryBase = {
	id: string;
	workspaceId: string;
	channelId: string;
	seq: number;
	createdAt: string;
	author: ChannelActor;
	/** `<kind>:<id>` of the author. */
	authorKey: string;
};
export type StoredMessage = EntryBase & {
	type: "message";
	body: string;
	mentions: ChannelMention[];
	/** `<kind>:<id>` of everyone mentioned. */
	mentionKeys: string[];
	threadId: string | null;
	replyCount: number;
	editedAt: string | null;
	deletedAt: string | null;
	/** Starts at 1; an edit or delete increments it. */
	revision: number;
	nonce?: string;
};
export type StoredSystemEntry = EntryBase & { type: "system"; text: string };
/** Points at the message that changed. It never stores message text. */
export type StoredChange = EntryBase & {
	type: "change";
	change: "deleted" | "edited";
	targetId: string;
};
export type StoredEntry = StoredMessage | StoredSystemEntry | StoredChange;

export type ChannelFilter = {
	archived?: boolean;
	/** Only channels whose agent list holds this agent. */
	agentTokenId?: string;
};

/**
 * Storage for channels, their logs, and read marks. The memory and MongoDB
 * implementations satisfy one contract (test/channels-repository.test.ts).
 * Every read and write names the workspace, so a lookup by id can never reach
 * another workspace's channel.
 */
export interface ChannelRepository {
	readonly persistence: "mongodb" | "memory";
	ensureIndexes(): Promise<void>;
	/** False when the workspace already has a channel with that name. */
	insertChannel(channel: StoredChannel): Promise<boolean>;
	getChannel(workspaceId: string, id: string): Promise<StoredChannel | null>;
	getChannelByName(
		workspaceId: string,
		nameKey: string,
	): Promise<StoredChannel | null>;
	/** By name. */
	listChannels(
		workspaceId: string,
		filter?: ChannelFilter,
	): Promise<StoredChannel[]>;
	countOpenChannels(workspaceId: string): Promise<number>;
	countChannelsCreatedBy(
		workspaceId: string,
		createdByKey: string,
		since: string,
	): Promise<number>;
	/**
	 * Compare-and-swap on `revision` for the channel's own fields, agents, and
	 * actions. The log summary is left to `touchChannel`.
	 */
	replaceChannel(
		channel: StoredChannel,
		expectedRevision: number,
	): Promise<"ok" | "conflict" | "name-taken">;
	/** Raises the log summary; it never moves backwards. */
	touchChannel(
		workspaceId: string,
		id: string,
		summary: {
			lastSeq: number;
			lastMessageSeq?: number;
			lastMessageAt?: string;
		},
	): Promise<void>;

	/** The highest `seq` in the channel's log; 0 when it is empty. */
	topSeq(channelId: string): Promise<number>;
	/**
	 * Appends an entry at its `seq`. The insert is the claim: `seq-taken` means
	 * another writer took that number, `nonce-taken` that this author already
	 * posted with this nonce.
	 */
	insertEntry(entry: StoredEntry): Promise<"ok" | "seq-taken" | "nonce-taken">;
	getEntry(
		workspaceId: string,
		channelId: string,
		id: string,
	): Promise<StoredEntry | null>;
	getEntries(channelId: string, ids: string[]): Promise<StoredEntry[]>;
	findByNonce(
		channelId: string,
		authorKey: string,
		nonce: string,
	): Promise<StoredMessage | null>;
	/** Entries above `after`, oldest first. */
	entriesAfter(
		channelId: string,
		after: number,
		limit: number,
		filter?: { mentionKey?: string },
	): Promise<StoredEntry[]>;
	/**
	 * Messages outside threads and system notes below `before` (or the latest),
	 * newest first.
	 */
	entriesBefore(
		channelId: string,
		before: number | undefined,
		limit: number,
	): Promise<StoredEntry[]>;
	/** A thread's replies above `after`, oldest first. */
	threadReplies(
		channelId: string,
		threadId: string,
		limit: number,
		after?: number,
	): Promise<StoredMessage[]>;
	/** Compare-and-swap on the message's `revision`. */
	replaceMessage(
		message: StoredMessage,
		expectedRevision: number,
	): Promise<boolean>;
	addReply(channelId: string, messageId: string): Promise<void>;
	/** Messages the author posted to the channel since `since`; notes and changes do not count. */
	countAuthorMessages(
		channelId: string,
		authorKey: string,
		since: string,
	): Promise<number>;
	countMentions(
		channelId: string,
		mentionKey: string,
		afterSeq: number,
	): Promise<number>;

	/** Read marks of one reader, by channel id. */
	readMarks(
		workspaceId: string,
		readerKey: string,
	): Promise<Map<string, number>>;
	readMark(channelId: string, readerKey: string): Promise<number>;
	/** Moves a read mark forward and returns where it now is. */
	raiseReadMark(
		workspaceId: string,
		channelId: string,
		readerKey: string,
		seq: number,
		at: string,
	): Promise<number>;
	close(): Promise<void>;
}

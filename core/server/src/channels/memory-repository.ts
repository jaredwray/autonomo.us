import type {
	ChannelFilter,
	ChannelRepository,
	StoredChannel,
	StoredEntry,
	StoredMessage,
} from "./repository.js";

const byName = (a: StoredChannel, b: StoredChannel) =>
	a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0;

/** Channels kept in process memory, until restart. */
export class MemoryChannelRepository implements ChannelRepository {
	readonly persistence = "memory" as const;
	private readonly channels = new Map<string, StoredChannel>();
	/** Each channel's log, in `seq` order. */
	private readonly logs = new Map<string, StoredEntry[]>();
	private readonly marks = new Map<
		string,
		{ workspaceId: string; seq: number }
	>();

	async ensureIndexes() {}
	private inWorkspace(workspaceId: string) {
		return [...this.channels.values()].filter(
			(channel) => channel.workspaceId === workspaceId,
		);
	}
	private log(channelId: string) {
		let log = this.logs.get(channelId);
		if (!log) {
			log = [];
			this.logs.set(channelId, log);
		}
		return log;
	}

	async insertChannel(channel: StoredChannel) {
		if (
			this.inWorkspace(channel.workspaceId).some(
				(item) => item.nameKey === channel.nameKey,
			)
		)
			return false;
		this.channels.set(channel.id, structuredClone(channel));
		return true;
	}
	async getChannel(workspaceId: string, id: string) {
		const channel = this.channels.get(id);
		return channel?.workspaceId === workspaceId
			? structuredClone(channel)
			: null;
	}
	async getChannelByName(workspaceId: string, nameKey: string) {
		const channel = this.inWorkspace(workspaceId).find(
			(item) => item.nameKey === nameKey,
		);
		return channel ? structuredClone(channel) : null;
	}
	async listChannels(workspaceId: string, filter: ChannelFilter = {}) {
		return this.inWorkspace(workspaceId)
			.filter(
				(channel) =>
					(filter.archived === undefined ||
						Boolean(channel.archivedAt) === filter.archived) &&
					(filter.agentTokenId === undefined ||
						channel.agents.some(
							(agent) => agent.agentTokenId === filter.agentTokenId,
						)),
			)
			.sort(byName)
			.map((channel) => structuredClone(channel));
	}
	async countOpenChannels(workspaceId: string) {
		return this.inWorkspace(workspaceId).filter(
			(channel) => !channel.archivedAt,
		).length;
	}
	async countChannelsCreatedBy(
		workspaceId: string,
		createdByKey: string,
		since: string,
	) {
		return this.inWorkspace(workspaceId).filter(
			(channel) =>
				channel.createdByKey === createdByKey && channel.createdAt >= since,
		).length;
	}
	async replaceChannel(channel: StoredChannel, expectedRevision: number) {
		const current = this.channels.get(channel.id);
		if (
			!current ||
			current.workspaceId !== channel.workspaceId ||
			current.revision !== expectedRevision
		)
			return "conflict" as const;
		if (
			this.inWorkspace(channel.workspaceId).some(
				(item) => item.id !== channel.id && item.nameKey === channel.nameKey,
			)
		)
			return "name-taken" as const;
		// The log summary belongs to touchChannel, which may have moved since
		// this caller read the channel.
		this.channels.set(channel.id, {
			...structuredClone(channel),
			lastSeq: current.lastSeq,
			lastMessageSeq: current.lastMessageSeq,
			lastMessageAt: current.lastMessageAt,
		});
		return "ok" as const;
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
		const channel = this.channels.get(id);
		if (channel?.workspaceId !== workspaceId) return;
		channel.lastSeq = Math.max(channel.lastSeq, summary.lastSeq);
		if (
			summary.lastMessageSeq !== undefined &&
			summary.lastMessageSeq > channel.lastMessageSeq
		) {
			channel.lastMessageSeq = summary.lastMessageSeq;
			channel.lastMessageAt = summary.lastMessageAt ?? channel.lastMessageAt;
		}
	}

	async topSeq(channelId: string) {
		return this.log(channelId).at(-1)?.seq ?? 0;
	}
	async insertEntry(entry: StoredEntry) {
		const log = this.log(entry.channelId);
		if (
			entry.type === "message" &&
			entry.nonce !== undefined &&
			log.some(
				(item) =>
					item.type === "message" &&
					item.authorKey === entry.authorKey &&
					item.nonce === entry.nonce,
			)
		)
			return "nonce-taken" as const;
		if (entry.seq !== (log.at(-1)?.seq ?? 0) + 1) return "seq-taken" as const;
		log.push(structuredClone(entry));
		return "ok" as const;
	}
	async getEntry(workspaceId: string, channelId: string, id: string) {
		const entry = this.log(channelId).find((item) => item.id === id);
		return entry?.workspaceId === workspaceId ? structuredClone(entry) : null;
	}
	async getEntries(channelId: string, ids: string[]) {
		const wanted = new Set(ids);
		return this.log(channelId)
			.filter((item) => wanted.has(item.id))
			.map((item) => structuredClone(item));
	}
	async findByNonce(channelId: string, authorKey: string, nonce: string) {
		const found = this.log(channelId).find(
			(item) =>
				item.type === "message" &&
				item.authorKey === authorKey &&
				item.nonce === nonce,
		);
		return found ? (structuredClone(found) as StoredMessage) : null;
	}
	async entriesAfter(
		channelId: string,
		after: number,
		limit: number,
		filter: { mentionKey?: string } = {},
	) {
		const mentionKey = filter.mentionKey;
		return this.log(channelId)
			.filter(
				(item) =>
					item.seq > after &&
					(mentionKey === undefined ||
						(item.type === "message" && item.mentionKeys.includes(mentionKey))),
			)
			.slice(0, limit)
			.map((item) => structuredClone(item));
	}
	async entriesBefore(
		channelId: string,
		before: number | undefined,
		limit: number,
	) {
		return this.log(channelId)
			.filter(
				(item) =>
					(before === undefined || item.seq < before) &&
					(item.type === "system" ||
						(item.type === "message" && item.threadId === null)),
			)
			.reverse()
			.slice(0, limit)
			.map((item) => structuredClone(item));
	}
	async threadReplies(channelId: string, threadId: string, limit: number) {
		return this.log(channelId)
			.filter(
				(item): item is StoredMessage =>
					item.type === "message" && item.threadId === threadId,
			)
			.slice(0, limit)
			.map((item) => structuredClone(item));
	}
	async replaceMessage(message: StoredMessage, expectedRevision: number) {
		const log = this.log(message.channelId);
		const index = log.findIndex((item) => item.id === message.id);
		const current = log[index];
		if (current?.type !== "message" || current.revision !== expectedRevision)
			return false;
		// The reply count belongs to addReply.
		log[index] = {
			...structuredClone(message),
			replyCount: current.replyCount,
		};
		return true;
	}
	async addReply(channelId: string, messageId: string) {
		const entry = this.log(channelId).find((item) => item.id === messageId);
		if (entry?.type === "message") entry.replyCount += 1;
	}
	async countAuthorEntries(
		channelId: string,
		authorKey: string,
		since: string,
	) {
		return this.log(channelId).filter(
			(item) => item.authorKey === authorKey && item.createdAt >= since,
		).length;
	}
	async countMentions(channelId: string, mentionKey: string, afterSeq: number) {
		return this.log(channelId).filter(
			(item) =>
				item.type === "message" &&
				item.seq > afterSeq &&
				item.mentionKeys.includes(mentionKey),
		).length;
	}

	async readMarks(workspaceId: string, readerKey: string) {
		const marks = new Map<string, number>();
		const suffix = `|${readerKey}`;
		for (const [key, mark] of this.marks)
			if (mark.workspaceId === workspaceId && key.endsWith(suffix))
				marks.set(key.slice(0, -suffix.length), mark.seq);
		return marks;
	}
	async readMark(channelId: string, readerKey: string) {
		return this.marks.get(`${channelId}|${readerKey}`)?.seq ?? 0;
	}
	async raiseReadMark(
		workspaceId: string,
		channelId: string,
		readerKey: string,
		seq: number,
	) {
		const key = `${channelId}|${readerKey}`;
		const next = Math.max(this.marks.get(key)?.seq ?? 0, seq);
		this.marks.set(key, { workspaceId, seq: next });
		return next;
	}
	async close() {}
}

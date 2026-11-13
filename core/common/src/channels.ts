/**
 * Channels: chat rooms inside a workspace where team members and bots
 * (agents) talk. Each channel is an append-only log of entries in one total
 * order; everything that reads a channel follows it by cursor. See
 * docs/CHANNELS_PLAN.md.
 */

/** Lowercase letters, digits, `-`, `_`; 1–80 characters; unique in a workspace. */
export const CHANNEL_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,79}$";
export const CHANNEL_LIMITS = {
	bodyLength: 16_000,
	topicLength: 250,
	descriptionLength: 1000,
	openChannels: 500,
	agentsPerChannel: 100,
	mentionsPerMessage: 20,
	/** Posts a minute per author per channel. */
	agentPostsPerMinute: 30,
	personPostsPerMinute: 120,
	/** Channels one person or agent may create in an hour. */
	channelsPerHour: 20,
	pageSize: 50,
	maxPageSize: 100,
	/** Longest long poll, in seconds. */
	maxWaitSeconds: 25,
} as const;

/** Who wrote something. The name is the one in use when the entry was written. */
export type ChannelActor = {
	kind: "user" | "agent" | "api-token";
	id: string;
	name: string;
};

export type ChannelAgentAccess = "read" | "post";
/** A bot in a channel: an agent token, or a bot the gateway runs. */
export type ChannelAgent = {
	agentTokenId: string;
	name: string;
	access: ChannelAgentAccess;
	addedAt: string;
	addedBy: string;
};

export type ChannelAction = {
	id: string;
	action:
		| "created"
		| "updated"
		| "archived"
		| "unarchived"
		| "agent-added"
		| "agent-changed"
		| "agent-removed";
	timestamp: string;
	actor: ChannelActor;
	detail: string;
};

export type Channel = {
	/** Server-generated UUID. The `:channel` path segment. */
	id: string;
	workspaceId: string;
	name: string;
	topic: string;
	description: string;
	agents: ChannelAgent[];
	createdAt: string;
	createdBy: ChannelActor;
	updatedAt: string;
	archivedAt: string | null;
	/** Increments on every change to the channel itself, for compare-and-swap. */
	revision: number;
};

/** A channel as one caller sees it. */
export type ChannelSummary = Channel & {
	lastMessageAt: string | null;
	/** The caller's read mark; 0 before the first read. */
	readSeq: number;
	unread: boolean;
	/** Unread messages that mention the caller. */
	mentions: number;
};

export type ChannelDetails = ChannelSummary & {
	/** Latest 100 changes to the channel and its agents, newest first. */
	actions: ChannelAction[];
};

export type ChannelList = {
	channels: ChannelSummary[];
	persistence: "mongodb" | "memory";
};

export type ChannelMention = Pick<ChannelActor, "kind" | "id">;

export type ChannelMessage = {
	id: string;
	channelId: string;
	seq: number;
	type: "message";
	createdAt: string;
	author: ChannelActor;
	/** Markdown. Empty once deleted. */
	body: string;
	mentions: ChannelMention[];
	/** The root message's id when this is a reply in a thread. */
	threadId: string | null;
	/** Replies to this message, when it is a thread's root. */
	replyCount: number;
	editedAt: string | null;
	deletedAt: string | null;
};

/** A note the server writes: an agent added, the channel renamed or archived. */
export type ChannelSystemEntry = {
	id: string;
	channelId: string;
	seq: number;
	type: "system";
	createdAt: string;
	author: ChannelActor;
	text: string;
};

/**
 * Says an earlier message changed. Stored as a reference; `message` is read
 * when the response is built and is the message's state now.
 */
export type ChannelChangeEntry = {
	id: string;
	channelId: string;
	seq: number;
	type: "change";
	createdAt: string;
	author: ChannelActor;
	change: "deleted" | "edited";
	message: ChannelMessage;
};

export type ChannelEntry =
	| ChannelMessage
	| ChannelSystemEntry
	| ChannelChangeEntry;

export type ChannelEntryList = {
	entries: ChannelEntry[];
	/** Pass as `after` to continue. Equals the request's `after` when nothing is new. */
	cursor: number;
};

/** People and bots that can be mentioned in a channel. */
export type ChannelMember = {
	kind: "user" | "agent";
	id: string;
	name: string;
	/** The text to write in a message to mention them. */
	mention: string;
	/** Agents only. */
	access?: ChannelAgentAccess;
};
export type ChannelMembers = { members: ChannelMember[] };

/** A workspace agent that can be added to a channel. */
export type ChannelAgentOption = {
	agentTokenId: string;
	name: string;
	status: "active" | "expired" | "revoked";
	/** True for a bot the gateway runs itself. */
	hosted: boolean;
};

export type CreateChannelRequest = {
	name: string;
	topic?: string;
	description?: string;
};
export type UpdateChannelRequest = {
	name?: string;
	topic?: string;
	description?: string;
	/** The revision the caller read; a stale one is refused. */
	revision?: number;
};
export type SetChannelAgentRequest = { access: ChannelAgentAccess };
export type PostChannelMessageRequest = {
	body: string;
	threadId?: string;
	/** Client-chosen, unique per author and channel. A retry with the same value returns the first message. */
	nonce?: string;
};
export type EditChannelMessageRequest = { body: string };
export type MarkChannelReadRequest = { seq: number };

/** The text that mentions a participant: `<@user:ID>` or `<@agent:ID>`. */
export const channelMention = (kind: "user" | "agent", id: string) =>
	`<@${kind}:${id}>`;
const MENTION = /<@(user|agent):([A-Za-z0-9-]{1,64})>/g;

/** Mentions in a message body, in order, without duplicates. */
export function channelMentions(body: string): ChannelMention[] {
	const found = new Map<string, ChannelMention>();
	for (const match of body.matchAll(MENTION)) {
		const kind = match[1] as "user" | "agent";
		found.set(`${kind}:${match[2]}`, { kind, id: match[2] });
	}
	return [...found.values()];
}

/** Splits a body into text and mentions, for rendering. */
export function splitChannelMentions(
	body: string,
): Array<string | ChannelMention> {
	const parts: Array<string | ChannelMention> = [];
	let index = 0;
	for (const match of body.matchAll(MENTION)) {
		if (match.index > index) parts.push(body.slice(index, match.index));
		parts.push({ kind: match[1] as "user" | "agent", id: match[2] });
		index = match.index + match[0].length;
	}
	if (index < body.length) parts.push(body.slice(index));
	return parts;
}

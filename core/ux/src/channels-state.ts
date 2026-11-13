import {
	CHANNEL_LIMITS,
	type ChannelEntry,
	type ChannelMessage,
	type ChannelSystemEntry,
} from "@autonomo.us/common";

/**
 * How the Channels view follows the gateway. Tests shorten these through
 * `setChannelTimings` instead of faking timers, since they run a real server.
 */
const DEFAULT_TIMINGS = {
	/** Seconds one long poll for new entries is held open. */
	waitSeconds: CHANNEL_LIMITS.maxWaitSeconds as number,
	/** Pause after a failed request before following again. */
	retryMs: 3000,
	/** How often the channel list (unread, mentions) is read again. */
	listIntervalMs: 30_000,
	/** How long the newest entry is on screen before the read mark moves. */
	readDelayMs: 400,
	/** How often a channel with a gateway bot asks whether one is replying. */
	activityIntervalMs: 2000,
	/** Empty answers in a row after which that asking stops until a message. */
	activityQuietPolls: 15,
};
export const channelTimings = { ...DEFAULT_TIMINGS };
export function setChannelTimings(
	next: Partial<typeof DEFAULT_TIMINGS> | null,
) {
	Object.assign(channelTimings, next ?? DEFAULT_TIMINGS);
}

/** What the main list shows: messages outside threads, and system notes. */
export type TimelineEntry = ChannelMessage | ChannelSystemEntry;

/** A message the person sent that the gateway has not confirmed yet. */
export type PendingPost = {
	/** Sent with every attempt, so a retry can never post twice. */
	nonce: string;
	body: string;
	threadId: string | null;
	createdAt: string;
	status: "sending" | "failed";
	error: string;
};

export type ThreadState = {
	rootId: string;
	/** The root message, then its replies, oldest first. */
	messages: ChannelMessage[];
	loaded: boolean;
	error: string;
};

export type RoomState = {
	loaded: boolean;
	timeline: TimelineEntry[];
	/** Whether older entries than the first one shown may exist. */
	hasEarlier: boolean;
	/** The highest entry number seen; what following continues from. */
	cursor: number;
	thread: ThreadState | null;
	pending: PendingPost[];
	/** Replies already counted on their root, so one that arrives twice counts once. */
	counted: ReadonlySet<string>;
};

export const emptyRoom: RoomState = {
	loaded: false,
	timeline: [],
	hasEarlier: false,
	cursor: 0,
	thread: null,
	pending: [],
	counted: new Set(),
};

export type RoomAction =
	| { type: "page"; entries: ChannelEntry[]; cursor: number }
	| { type: "earlier"; entries: ChannelEntry[] }
	| { type: "entries"; entries: ChannelEntry[]; cursor: number }
	/** A message's current state, from an edit or a delete made here. */
	| { type: "changed"; message: ChannelMessage }
	| { type: "thread-open"; rootId: string }
	| { type: "thread-loaded"; rootId: string; entries: ChannelEntry[] }
	| { type: "thread-failed"; rootId: string; error: string }
	| { type: "thread-close" }
	| { type: "pending-add"; post: PendingPost }
	| {
			type: "pending-status";
			nonce: string;
			status: PendingPost["status"];
			error: string;
	  }
	| { type: "pending-remove"; nonce: string }
	| { type: "posted"; nonce: string; message: ChannelMessage };

const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;

/** Adds or replaces by id, keeping the log's order. */
function upsert<T extends { id: string; seq: number }>(
	list: T[],
	item: T,
): T[] {
	const at = list.findIndex((existing) => existing.id === item.id);
	if (at >= 0)
		return list.map((existing, index) => (index === at ? item : existing));
	return [...list, item].sort(bySeq);
}

/**
 * Applies log entries to what is on screen. A message outside a thread joins
 * the timeline; a reply bumps its root's count and joins the open thread when
 * it is that one; a system note joins the timeline; a change replaces the
 * message wherever it is shown. Every step is safe to repeat, because the
 * same entry can arrive from following and from the response to a post.
 */
function applyEntries(state: RoomState, entries: ChannelEntry[]): RoomState {
	let { timeline, thread, counted } = state;
	for (const entry of entries) {
		if (entry.type === "system") {
			timeline = upsert(timeline, entry);
			continue;
		}
		const message = entry.type === "change" ? entry.message : entry;
		const isNew = entry.type === "message";
		if (message.threadId === null) {
			// A change to a message older than the loaded history has nowhere to go.
			if (isNew || timeline.some((item) => item.id === message.id))
				timeline = upsert(timeline, message);
			if (thread?.rootId === message.id)
				thread = { ...thread, messages: upsert(thread.messages, message) };
			continue;
		}
		if (isNew && !counted.has(message.id)) {
			counted = new Set(counted).add(message.id);
			const bump = (item: ChannelMessage): ChannelMessage =>
				item.id === message.threadId
					? { ...item, replyCount: item.replyCount + 1 }
					: item;
			timeline = timeline.map((item) =>
				item.type === "message" ? bump(item) : item,
			);
			if (thread?.rootId === message.threadId)
				thread = { ...thread, messages: thread.messages.map(bump) };
		}
		if (
			thread?.rootId === message.threadId &&
			(isNew || thread.messages.some((item) => item.id === message.id))
		)
			thread = { ...thread, messages: upsert(thread.messages, message) };
	}
	return { ...state, timeline, thread, counted };
}

const fullPage = (entries: ChannelEntry[]) =>
	entries.length >= CHANNEL_LIMITS.pageSize && (entries[0]?.seq ?? 1) > 1;

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
	switch (action.type) {
		case "page":
			return {
				...applyEntries(state, action.entries),
				loaded: true,
				hasEarlier: fullPage(action.entries),
				cursor: Math.max(state.cursor, action.cursor),
			};
		case "earlier":
			return {
				...applyEntries(state, action.entries),
				hasEarlier: fullPage(action.entries),
			};
		case "entries":
			return {
				...applyEntries(state, action.entries),
				cursor: Math.max(state.cursor, action.cursor),
			};
		case "changed": {
			const { message } = action;
			return {
				...state,
				timeline: state.timeline.map((item) =>
					item.id === message.id ? message : item,
				),
				thread: state.thread && {
					...state.thread,
					messages: state.thread.messages.map((item) =>
						item.id === message.id ? message : item,
					),
				},
			};
		}
		case "thread-open": {
			const root = state.timeline.find(
				(item): item is ChannelMessage =>
					item.type === "message" && item.id === action.rootId,
			);
			return {
				...state,
				thread: {
					rootId: action.rootId,
					messages: root ? [root] : [],
					loaded: false,
					error: "",
				},
			};
		}
		case "thread-loaded": {
			if (state.thread?.rootId !== action.rootId) return state;
			const fetched = action.entries.filter(
				(entry): entry is ChannelMessage => entry.type === "message",
			);
			// Replies that arrived while the thread was loading are at least as new.
			const arrived = state.thread.messages.filter(
				(message) => message.threadId !== null,
			);
			const messages = arrived.reduce(upsert, fetched);
			const root = fetched.find((message) => message.id === action.rootId);
			const counted = new Set(state.counted);
			for (const message of messages) counted.add(message.id);
			return {
				...state,
				counted,
				// The fetched root carries the true reply count.
				timeline: root
					? state.timeline.map((item) => (item.id === root.id ? root : item))
					: state.timeline,
				thread: { ...state.thread, messages, loaded: true, error: "" },
			};
		}
		case "thread-failed":
			return state.thread?.rootId === action.rootId
				? { ...state, thread: { ...state.thread, error: action.error } }
				: state;
		case "thread-close":
			return { ...state, thread: null };
		case "pending-add":
			return { ...state, pending: [...state.pending, action.post] };
		case "pending-status":
			return {
				...state,
				pending: state.pending.map((post) =>
					post.nonce === action.nonce
						? { ...post, status: action.status, error: action.error }
						: post,
				),
			};
		case "pending-remove":
			return {
				...state,
				pending: state.pending.filter((post) => post.nonce !== action.nonce),
			};
		case "posted":
			return {
				...applyEntries(state, [action.message]),
				pending: state.pending.filter((post) => post.nonce !== action.nonce),
			};
	}
}

/** A client-chosen id for one post. `randomUUID` needs HTTPS or localhost. */
export const newNonce = () =>
	typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const pad = (value: number) => String(value).padStart(2, "0");
/** The local calendar day of a timestamp, for grouping. */
export function dayKey(iso: string): string {
	const date = new Date(iso);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function dayLabel(iso: string, now = new Date()): string {
	const key = dayKey(iso);
	if (key === dayKey(now.toISOString())) return "Today";
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (key === dayKey(yesterday.toISOString())) return "Yesterday";
	const date = new Date(iso);
	return date.toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
		...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
	});
}
export const timeLabel = (iso: string) =>
	new Date(iso).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});

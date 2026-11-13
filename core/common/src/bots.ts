/**
 * Bots the gateway runs itself. A bot is a participant in channels with an
 * agent identity; when a message mentions it, the gateway calls a model from
 * the workspace's own connections and posts the reply. See
 * docs/CHANNELS_PLAN.md §16.
 */
import type { TokenUsage } from "./types.js";

export const BOT_LIMITS = {
	nameLength: 80,
	instructionsLength: 20_000,
	/** Bots per workspace. */
	bots: 50,
	/** Messages of context a reply may see. */
	maxContextMessages: 100,
	/** Bot-to-bot replies in one chain. */
	maxAgentHops: 3,
	maxRepliesPerHour: 600,
	maxOutputTokens: 16_000,
	/** Model calls in one reply when the bot uses tools. */
	maxToolSteps: 8,
} as const;

export const DEFAULT_BOT_LIMITS: BotLimits = {
	repliesPerHour: 30,
	tokensPerDay: 500_000,
	maxOutputTokens: 1500,
	contextMessages: 30,
};

export type BotLimits = {
	/** Replies the bot may start in an hour. */
	repliesPerHour: number;
	/** Model tokens the bot may use in a UTC day, input and output together. */
	tokensPerDay: number;
	/** The cap on one reply's output. */
	maxOutputTokens: number;
	/** How many recent messages a reply sees. */
	contextMessages: number;
};

export type Bot = {
	/** Its identity in channels and Synapse, used wherever an agent token ID is. */
	id: string;
	workspaceId: string;
	name: string;
	/** What the bot is for and how it should answer. */
	instructions: string;
	/** A model, pool, or `auto` from the workspace's routing. */
	model: string;
	/** A paused bot answers nothing. */
	enabled: boolean;
	/**
	 * How far a chain of bot-to-bot replies may go. 0 answers people only,
	 * which is the default; 1 also answers an agent that a person asked, and so on.
	 */
	agentHops: number;
	/** Whether a reply may use Synapse memory and read the bot's other channels. */
	tools: boolean;
	limits: BotLimits;
	createdAt: string;
	createdBy: string;
	updatedAt: string;
	revision: number;
};

export type BotRunStatus =
	| "pending"
	| "running"
	| "succeeded"
	| "failed"
	| "skipped";

/** One reply: a message that mentioned the bot, and what came of it. */
export type BotRun = {
	id: string;
	botId: string;
	workspaceId: string;
	channelId: string;
	/** The number and id of the message that started the run. */
	triggerSeq: number;
	triggerMessageId: string;
	/** 0 when a person asked; one more for each bot-to-bot step before it. */
	depth: number;
	status: BotRunStatus;
	/** Times a runner has started this run; more than one means a crash. */
	attempts: number;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	/** Why a run failed or was skipped. */
	detail: string | null;
	/** The model that answered. */
	model: string | null;
	usage: TokenUsage | null;
	replyMessageId: string | null;
};

export type BotSummary = Bot & {
	/** Replies started in the last hour, against `limits.repliesPerHour`. */
	repliesLastHour: number;
	/** Tokens used so far in the current UTC day. */
	tokensToday: number;
};
export type BotList = { bots: BotSummary[]; persistence: "mongodb" | "memory" };
export type BotDetails = BotSummary & {
	/** Latest 50 runs, newest first. */
	runs: BotRun[];
};
/** Bots that are working on a reply in a channel right now. */
export type BotActivity = { replying: Array<{ botId: string; name: string }> };

export type CreateBotRequest = {
	name: string;
	instructions: string;
	model: string;
	enabled?: boolean;
	agentHops?: number;
	tools?: boolean;
	limits?: Partial<BotLimits>;
};
export type UpdateBotRequest = Partial<CreateBotRequest> & {
	/** The revision the caller read; a stale one is refused. */
	revision?: number;
};

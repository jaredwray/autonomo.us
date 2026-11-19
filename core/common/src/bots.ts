/**
 * Bots the gateway runs itself. A bot is a participant in channels with an
 * agent identity; when a message mentions it, the gateway calls a model from
 * the workspace's own connections and posts the reply. See
 * docs/CHANNELS_PLAN.md §16.
 */
import type { LOOP_AGENT_PERMISSIONS } from "./agent-tokens.js";
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
	maxProxyRequestsPerDay: 10_000,
	/** Sites on one bot's approved list. */
	maxWebHosts: 100,
	/** Approval requests a bot may have waiting at once. */
	maxPendingWebRequests: 50,
} as const;

/**
 * What a bot with web access may fetch. `any`: any page the workspace's
 * rules allow. `mentioned`: pages on sites people linked in the messages the
 * reply sees, or on approved sites. `approved`: only approved sites.
 */
export const BOT_WEB_SCOPES = ["any", "mentioned", "approved"] as const;
export type BotWebScope = (typeof BOT_WEB_SCOPES)[number];

/**
 * Fetches after the first in one reply. `any`: anything in scope.
 * `same-site`: only sites the reply already fetched. `none`: one fetch a reply.
 */
export const BOT_WEB_FOLLOW_UPS = ["any", "same-site", "none"] as const;
export type BotWebFollowUps = (typeof BOT_WEB_FOLLOW_UPS)[number];

export const DEFAULT_BOT_LIMITS: BotLimits = {
	repliesPerHour: 30,
	tokensPerDay: 500_000,
	maxOutputTokens: 1500,
	contextMessages: 30,
	proxyRequestsPerDay: 20,
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
	/** Requests through the workspace's paid proxies in a UTC day. */
	proxyRequestsPerDay: number;
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
	/** Allows outcomes on assigned cases when tools are enabled. Absent on older bots. */
	organizationDecisions?: boolean;
	/** Optional workspace loop tools; older bots have no loop grants. */
	loopPermissions?: (typeof LOOP_AGENT_PERMISSIONS)[number][];
	/** Whether a reply may read web pages with `web_fetch`, through the workspace's proxies when needed. */
	web: boolean;
	/** What the bot may fetch; see `BOT_WEB_SCOPES`. */
	webScope: BotWebScope;
	/** Fetches after the first in one reply; see `BOT_WEB_FOLLOW_UPS`. */
	webFollowUps: BotWebFollowUps;
	/** Sites approved for this bot. Each matches the host and its subdomains. */
	webHosts: string[];
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
	organizationDecisions?: boolean;
	/** Optional workspace loop tools; older bots have no loop grants. */
	loopPermissions?: (typeof LOOP_AGENT_PERMISSIONS)[number][];
	web?: boolean;
	webScope?: BotWebScope;
	webFollowUps?: BotWebFollowUps;
	webHosts?: string[];
	limits?: Partial<BotLimits>;
};

/**
 * A site a bot tried to fetch outside its scope, waiting for a workspace
 * admin. Approving adds the host to the bot's approved sites.
 */
export type BotWebRequest = {
	id: string;
	botId: string;
	workspaceId: string;
	host: string;
	/** The page asked for, without its query string or fragment. */
	url: string;
	channelId: string | null;
	status: "pending" | "approved" | "denied";
	/** Times the bot asked while the request was pending. */
	count: number;
	requestedAt: string;
	decidedAt: string | null;
	decidedBy: string | null;
};
export type BotWebRequestList = { requests: BotWebRequest[] };
export type DecideBotWebRequest = { approve: boolean };
export type UpdateBotRequest = Partial<CreateBotRequest> & {
	/** The revision the caller read; a stale one is refused. */
	revision?: number;
};

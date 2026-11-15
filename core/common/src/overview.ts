/**
 * A workspace at a glance, for the dashboard's home page: what is waiting on
 * a person, what its agents are doing, and what is wrong. One request
 * replaces a dozen, and the sidebar's badges read it too.
 */
import type { AgentKind, AgentSummary } from "./agents.js";
import type { BotRunStatus } from "./bots.js";
import type { ProxyProblem } from "./web.js";

/** Tokens that stop working within this many days count as expiring. */
export const OVERVIEW_EXPIRING_DAYS = 7;
/** The share of the proxy budget spent before it is called out. */
export const OVERVIEW_BUDGET_WARNING = 0.8;
/** Failed bot replies listed, newest first. */
export const OVERVIEW_FAILED_RUNS = 5;
/** Shared notes listed, most recently changed first. */
export const OVERVIEW_RECENT_NOTES = 5;

export type OverviewQuery = { from?: string; to?: string };

/** Parts of the overview read from separate stores, which can fail apart. */
export type OverviewSection =
	| "synapse"
	| "channels"
	| "proxies"
	| "site-requests"
	| "connections"
	| "team"
	| "api-tokens";

/** One of the workspace's agents, with what it has done lately. */
export type OverviewAgent = Pick<
	AgentSummary,
	"id" | "name" | "status" | "model" | "connections"
> & {
	kind: AgentKind;
	/** Agents with instructions: working on a reply now. */
	replying: boolean;
	/** Agents with instructions: replies started in the last hour, and the cap. */
	replies: { used: number; limit: number } | null;
	/** Agents with instructions: tokens used today (UTC), and the cap. */
	tokens: { used: number; limit: number } | null;
	/** Token and OAuth agents: when the credential stops working. */
	expiresAt: string | null;
};

/** A bot's reply that failed, for the overview's recent list. */
export type OverviewFailedRun = {
	id: string;
	botId: string;
	name: string;
	channelId: string;
	detail: string | null;
	createdAt: string;
};

/** A note in the workspace's shared space, or one it inherits from Global. */
export type OverviewNote = {
	title: string;
	updatedAt: string;
	global: boolean;
};

export type OverviewProposal = {
	id: string;
	action: "create" | "update" | "append" | "delete";
	/** The note's title once the proposal applied (a rename's new title). */
	title: string;
	status: "approved" | "rejected";
	author: string;
	decidedAt: string;
	decidedBy: string;
};

export type WorkspaceOverview = {
	generatedAt: string;
	/** What the signed-in person may do about each item. */
	can: {
		decideProposals: boolean;
		manageAgents: boolean;
		editProxies: boolean;
		manageTokens: boolean;
		manageTeam: boolean;
	};
	waiting: {
		/** Agent proposals to change the shared space, not yet decided. */
		proposals: number;
		/** Sites bots asked to fetch outside their scope, by bot. */
		siteRequests: Array<{ botId: string; name: string; count: number }>;
		/** Proxy connections with a problem a person has to fix. */
		proxyProblems: Array<{
			name: string;
			kind: ProxyProblem["kind"];
			detail: string;
		}>;
		/** Agent credentials that stop working soon. */
		expiringAgents: Array<{ id: string; name: string; expiresAt: string }>;
		/**
		 * Bots whose replies in the query's window failed at least twice and at
		 * least as often as they succeeded: usually a model or key problem.
		 */
		failingBots: Array<{
			id: string;
			name: string;
			failed: number;
			replies: number;
		}>;
		/** Bots that used up an hourly or daily limit. */
		botsAtLimit: Array<{
			id: string;
			name: string;
			limit: "replies" | "tokens";
		}>;
		/** Unread mentions of the signed-in person, by channel. */
		mentions: Array<{ channelId: string; name: string; count: number }>;
		/**
		 * Org owners and admins: invite links not yet used, across the whole
		 * team (not this workspace alone). Null for others.
		 */
		invites: number | null;
		/** Org owners and admins: API tokens that stop working soon. Null for others. */
		expiringApiTokens: Array<{
			id: string;
			name: string;
			expiresAt: string;
		}> | null;
	};
	/** The proxy budget for the calendar month (UTC); null when proxies could not be read. */
	budget: { month: string; spentUsd: number; limitUsd: number } | null;
	agents: OverviewAgent[];
	/** Bot replies started in the query's window, by how they ended. */
	runs: Record<BotRunStatus, number>;
	failedRuns: OverviewFailedRun[];
	recentNotes: OverviewNote[];
	recentDecisions: OverviewProposal[];
	/**
	 * Sections that could not be read this time. The rest of the overview
	 * is still current; these show as unavailable rather than as empty.
	 */
	unavailable: OverviewSection[];
	health: {
		/** Where the workspace's settings live. Memory is lost on restart. */
		persistence: "mongodb" | "memory";
		/** Usage history in MongoDB: unset, writing, or failing. */
		telemetry: "none" | "healthy" | "failing";
		/** False when the operator turned web access off. */
		webAvailable: boolean;
	};
};

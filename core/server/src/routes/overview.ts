import {
	OVERVIEW_EXPIRING_DAYS,
	OVERVIEW_FAILED_RUNS,
	OVERVIEW_RECENT_NOTES,
	type OverviewAgent,
	type OverviewQuery,
	type OverviewSection,
	type WorkspaceOverview,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { memberMay, requestWorkspace, signedInMember } from "../auth/access.js";
import { AccountStore } from "../auth/accounts.js";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import type { ApiTokenStore } from "../auth/tokens.js";
import type { BotService } from "../bots/bots.js";
import type { BotWebRequestStore } from "../bots/web-requests.js";
import type { ChannelService } from "../channels/channels.js";
import { mongoErrorDetails } from "../mongo.js";
import type { OAuthService } from "../oauth/oauth.js";
import type { SynapseService } from "../synapse/synapse.js";
import { sharedSpaceId } from "../synapse/synapse.js";
import { DAY_MS } from "../telemetry/analytics.js";
import type { TelemetryService } from "../telemetry/telemetry.js";
import type { WebService } from "../web/service.js";
import type { ProxyStore } from "../web/store.js";

export type OverviewRouteOptions = {
	accounts: AccountStore;
	agentTokens: AgentTokenStore;
	tokens: ApiTokenStore;
	bots: BotService;
	botWebRequests: BotWebRequestStore;
	oauth: OAuthService;
	synapse: SynapseService;
	channels: ChannelService;
	proxies: ProxyStore;
	web: WebService;
	telemetry: TelemetryService;
	now?: () => number;
};

/** A bot is failing once this many replies in the window failed, and no fewer than succeeded. */
const FAILING_REPLIES = 2;

/**
 * `GET /overview`: the workspace's home page in one request. Signed-in
 * members only, like the views it summarizes. Everyone sees what is waiting;
 * `can` says who may act on it. Agents and bots are read first and must
 * succeed; each other section that fails is listed in `unavailable` and the
 * rest is still answered.
 */
export async function overviewRoutes(
	server: FastifyInstance,
	options: OverviewRouteOptions,
) {
	const now = options.now ?? Date.now;
	server.setErrorHandler((error: unknown, request, reply) => {
		const failure = error as { statusCode?: unknown; message?: unknown };
		const status =
			typeof failure.statusCode === "number" && failure.statusCode >= 400
				? failure.statusCode
				: 500;
		if (status >= 500)
			request.log.error(
				{ ...mongoErrorDetails(error) },
				"Overview request failed",
			);
		return reply.code(status).send({
			error: {
				message:
					status < 500
						? String(failure.message)
						: "The overview could not be loaded. Retry in a moment.",
			},
		});
	});

	server.get<{ Querystring: OverviewQuery }>(
		"/overview",
		{
			schema: {
				querystring: {
					type: "object",
					additionalProperties: false,
					properties: {
						from: { type: "string", format: "date-time" },
						to: { type: "string", format: "date-time" },
					},
				},
			},
		},
		async (request, reply): Promise<WorkspaceOverview | undefined> => {
			const at = now();
			const to = request.query.to ? Date.parse(request.query.to) : at;
			const from = request.query.from
				? Date.parse(request.query.from)
				: to - DAY_MS;
			if (
				!Number.isFinite(from) ||
				!Number.isFinite(to) ||
				from >= to ||
				to - from > 90 * DAY_MS
			) {
				reply.code(400).send({
					error: { message: "Choose a valid time range of up to 90 days." },
				});
				return;
			}
			reply.header("cache-control", "no-store");
			return overview(options, request, at, from, to);
		},
	);
}

async function overview(
	options: OverviewRouteOptions,
	request: FastifyRequest,
	at: number,
	from: number,
	to: number,
): Promise<WorkspaceOverview> {
	const workspace = requestWorkspace(request);
	const member = signedInMember(request);
	const can = {
		decideProposals: memberMay(workspace, "synapse:decide"),
		manageAgents: memberMay(workspace, "agents:manage"),
		editProxies: memberMay(workspace, "proxies:edit"),
		manageTokens: memberMay(workspace, "tokens:manage"),
		manageTeam: AccountStore.canManage(member),
	};
	const shared = sharedSpaceId(workspace);
	const nowIso = new Date(at).toISOString();
	const soon = new Date(at + OVERVIEW_EXPIRING_DAYS * DAY_MS).toISOString();
	const expiring = <Token extends { status: string; expiresAt: string | null }>(
		token: Token,
	): token is Token & { expiresAt: string } =>
		token.status === "active" &&
		token.expiresAt !== null &&
		token.expiresAt > nowIso &&
		token.expiresAt <= soon;
	const unavailable: OverviewSection[] = [];
	/** A section that may fail alone: its fallback stands in, and it is listed. */
	const section = async <T>(
		name: OverviewSection,
		read: () => Promise<T>,
		fallback: T,
	): Promise<T> => {
		try {
			return await read();
		} catch (error) {
			request.log.warn(
				{ ...mongoErrorDetails(error), section: name },
				"Overview section unavailable",
			);
			if (!unavailable.includes(name)) unavailable.push(name);
			return fallback;
		}
	};
	const [
		agentTokens,
		bots,
		connections,
		siteRequests,
		synapse,
		channels,
		proxies,
		invites,
		apiTokens,
	] = await Promise.all([
		options.agentTokens.settings(workspace, true),
		options.bots.overview(
			workspace.id,
			{ from: new Date(from).toISOString(), to: new Date(to).toISOString() },
			OVERVIEW_FAILED_RUNS,
		),
		section("connections", () => options.oauth.connections(workspace.id), []),
		section(
			"site-requests",
			() => options.botWebRequests.pending(workspace.id),
			[],
		),
		section(
			"synapse",
			async () => {
				const [proposals, decisions, notes] = await Promise.all([
					options.synapse.countProposals({ space: shared, status: "pending" }),
					options.synapse.recentDecisions(shared, OVERVIEW_RECENT_NOTES),
					options.synapse.recentNotes(shared, OVERVIEW_RECENT_NOTES),
				]);
				return { proposals, decisions, notes };
			},
			{ proposals: 0, decisions: [], notes: [] },
		),
		section(
			"channels",
			async () =>
				(
					await options.channels.listChannels(
						workspace.id,
						{
							actor: {
								kind: "user",
								id: member.id,
								name: member.name || member.email,
							},
						},
						{ archived: false },
					)
				).channels,
			[],
		),
		section(
			"proxies",
			async () => {
				const policy = await options.proxies.policy(workspace);
				const [list, budget] = await Promise.all([
					options.proxies.list(workspace),
					options.proxies.budget(workspace, policy),
				]);
				return { list, budget: budget as WorkspaceOverview["budget"] };
			},
			{ list: [], budget: null },
		),
		can.manageTeam
			? section(
					"team",
					async () => (await options.accounts.counts()).invites,
					null,
				)
			: null,
		can.manageTokens
			? section(
					"api-tokens",
					async () => (await options.tokens.settings(workspace, true)).tokens,
					null,
				)
			: null,
	]);
	const botNames = new Map(bots.bots.map((bot) => [bot.id, bot.name]));
	const connected = new Map<string, number>();
	for (const connection of connections)
		connected.set(
			connection.agentId,
			(connected.get(connection.agentId) ?? 0) + 1,
		);
	// A deleted bot's requests can never be decided; they are not waiting.
	const requestsByBot = new Map<string, number>();
	for (const item of siteRequests)
		if (botNames.has(item.botId))
			requestsByBot.set(item.botId, (requestsByBot.get(item.botId) ?? 0) + 1);
	const agents: OverviewAgent[] = [
		...bots.bots.map((bot) => ({
			id: bot.id,
			kind: "instructions" as const,
			name: bot.name,
			status: bot.enabled ? ("active" as const) : ("paused" as const),
			model: bot.model,
			connections: 0,
			replying: bots.replying.has(bot.id),
			replies: { used: bot.repliesLastHour, limit: bot.limits.repliesPerHour },
			tokens: { used: bot.tokensToday, limit: bot.limits.tokensPerDay },
			expiresAt: null,
		})),
		...agentTokens.tokens.map((token) => ({
			id: token.id,
			kind: token.auth,
			name: token.name,
			status: token.status,
			model: null,
			connections: connected.get(token.id) ?? 0,
			replying: false,
			replies: null,
			tokens: null,
			expiresAt: token.expiresAt,
		})),
	].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	const byName = (a: { name: string }, b: { name: string }) =>
		a.name.localeCompare(b.name);
	return {
		generatedAt: nowIso,
		can,
		waiting: {
			proposals: synapse.proposals,
			siteRequests: [...requestsByBot]
				.map(([botId, count]) => ({
					botId,
					name: botNames.get(botId) as string,
					count,
				}))
				.sort((a, b) => b.count - a.count || byName(a, b)),
			proxyProblems: proxies.list.flatMap((connection) =>
				connection.problem
					? [
							{
								name: connection.name,
								kind: connection.problem.kind,
								detail: connection.problem.detail,
							},
						]
					: [],
			),
			expiringAgents: agentTokens.tokens
				.filter(expiring)
				.map((token) => ({
					id: token.id,
					name: token.name,
					expiresAt: token.expiresAt,
				}))
				.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
			failingBots: bots.bots
				.flatMap((bot) => {
					const runs = bots.byBot.get(bot.id) ?? {};
					const failed = runs.failed ?? 0;
					const succeeded = runs.succeeded ?? 0;
					return failed >= FAILING_REPLIES && failed >= succeeded
						? [
								{
									id: bot.id,
									name: bot.name,
									failed,
									replies: failed + succeeded,
								},
							]
						: [];
				})
				.sort(byName),
			botsAtLimit: bots.bots
				.flatMap((bot): WorkspaceOverview["waiting"]["botsAtLimit"] =>
					!bot.enabled
						? []
						: bot.tokensToday >= bot.limits.tokensPerDay
							? [{ id: bot.id, name: bot.name, limit: "tokens" }]
							: bot.repliesLastHour >= bot.limits.repliesPerHour
								? [{ id: bot.id, name: bot.name, limit: "replies" }]
								: [],
				)
				.sort(byName),
			mentions: channels
				.filter((channel) => channel.mentions > 0)
				.map((channel) => ({
					channelId: channel.id,
					name: channel.name,
					count: channel.mentions,
				}))
				.sort((a, b) => b.count - a.count || byName(a, b)),
			invites,
			expiringApiTokens:
				apiTokens === null
					? null
					: apiTokens
							.filter(expiring)
							.map((token) => ({
								id: token.id,
								name: token.name,
								expiresAt: token.expiresAt,
							}))
							.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
		},
		budget: proxies.budget,
		agents,
		runs: bots.runs,
		failedRuns: bots.failedRuns.map((run) => ({
			id: run.id,
			botId: run.botId,
			name: botNames.get(run.botId) ?? "Removed agent",
			channelId: run.channelId,
			detail: run.detail,
			createdAt: run.createdAt,
		})),
		recentNotes: synapse.notes,
		recentDecisions: synapse.decisions.flatMap((proposal) =>
			proposal.status === "pending"
				? []
				: [
						{
							id: proposal.id,
							action: proposal.action,
							title: proposal.newTitle ?? proposal.title,
							status: proposal.status,
							author: proposal.author.name,
							decidedAt: proposal.decidedAt ?? proposal.createdAt,
							decidedBy: proposal.decidedBy?.name ?? "",
						},
					],
		),
		unavailable,
		health: {
			persistence: agentTokens.persistence,
			telemetry: !options.telemetry.sinkConfigured
				? "none"
				: options.telemetry.sinkHealthy
					? "healthy"
					: "failing",
			webAvailable: options.web.available,
		},
	};
}

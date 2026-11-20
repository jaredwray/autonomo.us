import { WEB_LIMITS, type WebFetchResult } from "@autonomo.us/common";
import cors from "@fastify/cors";
import Fastify from "fastify";
import packageJson from "../package.json" with { type: "json" };
import { AppEvents } from "./agent-webhooks/app-events.js";
import {
	fetchWebhookTransport,
	nodeWebhookTransport,
	type WebhookTransport,
} from "./agent-webhooks/delivery.js";
import {
	MemoryAgentWebhookRepository,
	MongoAgentWebhookRepository,
} from "./agent-webhooks/repository.js";
import type { WebhookTiming } from "./agent-webhooks/state.js";
import { AgentWebhooks } from "./agent-webhooks/webhooks.js";
import {
	registerApiAccess,
	requestWorkspace,
	requireRouteScopes,
} from "./auth/access.js";
import { AccountStore } from "./auth/accounts.js";
import { AgentTokenStore } from "./auth/agent-tokens.js";
import { ApiTokenStore } from "./auth/tokens.js";
import { BotService } from "./bots/bots.js";
import { MemoryBotRepository, MongoBotRepository } from "./bots/repository.js";
import { BotRunner } from "./bots/runner.js";
import { BotWebRequestStore } from "./bots/web-requests.js";
import { BudgetService } from "./budgets/service.js";
import { BudgetStore } from "./budgets/store.js";
import { ChannelService } from "./channels/channels.js";
import { channelToolSet } from "./channels/mcp.js";
import { MemoryChannelRepository } from "./channels/memory-repository.js";
import { MongoChannelRepository } from "./channels/mongo-repository.js";
import { type ApiConfig, configFromEnv } from "./config.js";
import { registerDashboard } from "./dashboard.js";
import { FailoverPolicyStore } from "./failover.js";
import { GatewayData } from "./gateway-data.js";
import { LoopsAssignments } from "./loops/assignments.js";
import { loopsToolSet } from "./loops/mcp.js";
import {
	MemoryLoopRepository,
	MongoLoopRepository,
} from "./loops/repository.js";
import { LoopsService } from "./loops/service.js";
import { registerMaintenanceRoutes } from "./maintenance-control.js";
import { mcpRoutes } from "./mcp/server.js";
import { Callback } from "./mcp-events/callback.js";
import { McpEvents } from "./mcp-events/events.js";
import {
	type EventRepository,
	MongoEventRepository,
} from "./mcp-events/repository.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import { modelToolSet } from "./models/mcp.js";
import { controlPlaneConnection, mongoErrorDetails } from "./mongo.js";
import { type OAuthAgents, OAuthService } from "./oauth/oauth.js";
import { publicOrigin } from "./oauth/origin.js";
import {
	MemoryOAuthRepository,
	MongoOAuthRepository,
} from "./oauth/repository.js";
import { organizationDirectory } from "./organization/directory.js";
import { organizationToolSet } from "./organization/mcp.js";
import { OrganizationService } from "./organization/organization.js";
import {
	MemoryOrganizationRepository,
	MongoOrganizationRepository,
} from "./organization/repository.js";
import {
	type ProviderRegistry,
	registryFromConfig,
} from "./providers/registry.js";
import { ProviderSettingsStore } from "./providers/settings.js";
import { agentTokenRoutes } from "./routes/agent-tokens.js";
import { agentWebhookRoutes } from "./routes/agent-webhooks.js";
import { agentRoutes, oauthSignInRoutes } from "./routes/agents.js";
import { apiTokenRoutes } from "./routes/api-tokens.js";
import { authRoutes } from "./routes/auth.js";
import { botRoutes } from "./routes/bots.js";
import { budgetRoutes } from "./routes/budgets.js";
import { channelRoutes } from "./routes/channels.js";
import { chatRoutes } from "./routes/chat.js";
import { decisionsRoutes } from "./routes/decisions.js";
import { failoverRoutes } from "./routes/failover.js";
import { healthRoutes } from "./routes/health.js";
import { loopsRoutes } from "./routes/loops.js";
import { catalogRoutes, modelsRoutes } from "./routes/models.js";
import { oauthRoutes } from "./routes/oauth.js";
import { organizationRoutes } from "./routes/organization.js";
import { overviewRoutes } from "./routes/overview.js";
import { routingRoutes } from "./routes/routing.js";
import { synapseRoutes } from "./routes/synapse.js";
import { teamRoutes } from "./routes/team.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import {
	redactDownloadUrl,
	videoDownloadRoutes,
	videoRoutes,
} from "./routes/video.js";
import { webRoutes } from "./routes/web.js";
import { memberRoutes, workspaceRoutes } from "./routes/workspaces.js";
import { ModelRouter } from "./routing/router.js";
import { RoutingSettingsStore } from "./routing/settings.js";
import { MAX_TASK_LENGTH } from "./synapse/context.js";
import { synapseFeatures } from "./synapse/features.js";
import { synapseToolSet } from "./synapse/mcp.js";
import { MemorySynapseRepository } from "./synapse/memory-repository.js";
import { MongoSynapseRepository } from "./synapse/mongo-repository.js";
import {
	agentSpaceId,
	SynapseService,
	sharedSpaceId,
} from "./synapse/synapse.js";
import { MongoTelemetrySink } from "./telemetry/mongo.js";
import { TelemetryService } from "./telemetry/telemetry.js";
import { VideoJobStore } from "./video/jobs.js";
import { videoToolSet } from "./video/mcp.js";
import { VideoService } from "./video/service.js";
import { VideoStore } from "./video/store.js";
import {
	type DirectTransport,
	fetchTransport,
	nodeTransport,
} from "./web/direct.js";
import { webToolSet } from "./web/mcp.js";
import { WebService } from "./web/service.js";
import { ProxyStore } from "./web/store.js";
import type { FetchLike } from "./web/types.js";
import { type Resolver, systemResolver } from "./web/url-guard.js";
import { type WorkspaceRef, WorkspaceStore } from "./workspaces/store.js";

const releases = new WeakMap<ReturnType<typeof Fastify>, () => Promise<void>>();
const backgrounds = new WeakMap<
	ReturnType<typeof Fastify>,
	{
		settle(): Promise<void>;
		sweep(maxMcpEvents?: number): Promise<void>;
		catchUp(): void;
	}
>();
const BOT_SWEEP_INTERVAL_MS = 30_000;
type PersistenceErrorHandler = (
	store: "providers" | "routing",
	error: unknown,
) => void;
const initializers = new WeakMap<
	ReturnType<typeof Fastify>,
	(onError?: PersistenceErrorHandler) => Promise<boolean>
>();

export type CreateServerOptions = {
	/** Clock for organization response deadlines and loop measurements. */
	organizationNow?: () => number;
	/** Enables dedicated-token internal maintenance routes on this server. */
	maintenanceToken?: string;
	/** Containers use durable platform invocations instead of detached interval sweeps. */
	backgroundTimers?: boolean;
	/** Explicit adapters for event integration tests. Production requires durable MongoDB and pinned HTTPS. */
	mcpEvents?: {
		repository: EventRepository;
		transport: WebhookTransport;
		resolver?: Resolver;
	};
	config?: ApiConfig;
	registry?: ProviderRegistry;
	telemetry?: TelemetryService;
	failover?: FailoverPolicyStore;
	/**
	 * Runtime model catalog. The default instance serves the bundled
	 * models.json until someone calls `start()` on it — the production
	 * entrypoint (start.ts) does, so tests never hit the network.
	 */
	modelCatalog?: ModelCatalogService;
	logger?: boolean;
	/**
	 * Workers cannot reuse a MongoDB socket across requests. The Worker
	 * entry closes clients after each request and flushes telemetry immediately.
	 */
	releaseMongoPerRequest?: boolean;
	/**
	 * Avvio's per-plugin timer. `0` disables it. The Worker sets that because
	 * a pending timer there keeps `process.nextTick` from finishing boot.
	 */
	pluginTimeout?: number;
	/** Workers compile routes at module startup, before database I/O is allowed. */
	deferPersistence?: boolean;
	/**
	 * How long a new MongoDB client may take to find the primary. The default
	 * suits a nearby database; a cold container with a fraction of a CPU needs
	 * longer for its first TLS connections to a remote one.
	 */
	mongoSelectionTimeoutMs?: number;
	/**
	 * How `web_fetch` makes a plain request. Node pins the address it checked;
	 * the Worker uses `fetch`, which cannot, and gives bot replies less time.
	 */
	webTransport?: "node" | "fetch";
	/** Replaces the transport and resolver, for tests. */
	webDirect?: { transport: DirectTransport; resolver?: Resolver };
	/** How provider APIs are called, for tests. */
	webFetch?: FetchLike;
	/** How video provider APIs are called, for tests. */
	videoFetch?: FetchLike;
	/**
	 * How agent webhooks are sent and paced, for tests. The transport
	 * defaults to Node's HTTPS client, or `fetch` with `webTransport: "fetch"`.
	 */
	agentWebhooks?: {
		transport?: WebhookTransport;
		resolver?: Resolver;
		timing?: Partial<WebhookTiming>;
		timeoutMs?: number;
	};
	/**
	 * The runtime ends TLS before the server sees a request, as Workers do, so
	 * an address taken from a request is HTTPS unless it is on localhost.
	 */
	assumeHttps?: boolean;
	/**
	 * Built dashboard directory (`core/ux/dist`). When set, this instance serves
	 * it beside the API so one process runs both. The Worker leaves it unset and
	 * serves the same files as Workers static assets instead.
	 */
	dashboardDir?: string;
};

export function createServer(options: CreateServerOptions = {}) {
	const config = options.config ?? configFromEnv();
	// Environment providers, or a registry a caller injects: the default
	// workspace's overlay. The settings store copies it and never writes into it.
	const registry = options.registry ?? registryFromConfig(config);
	const mongo = config.mongodbUrl
		? controlPlaneConnection(config.mongodbUrl, options.mongoSelectionTimeoutMs)
		: undefined;
	const workspaces = new WorkspaceStore(mongo);
	const providers = new ProviderSettingsStore(config, registry, mongo);
	const routing = new RoutingSettingsStore(
		(options.failover ?? new FailoverPolicyStore(config.failover)).get(),
		mongo,
	);
	const modelCatalog = options.modelCatalog ?? new ModelCatalogService();
	const telemetry =
		options.telemetry ??
		new TelemetryService({
			sink: config.mongodbUrl
				? new MongoTelemetrySink(config.mongodbUrl)
				: undefined,
			flushIntervalMs: options.releaseMongoPerRequest ? 0 : undefined,
		});

	// Priced by the connection's implementation kind, which every call site
	// knows; custom OpenAI-compatible endpoints stay unpriced.
	telemetry.setPricingResolver((id, provider, kind) => {
		if (!kind || kind === "openai-compatible") return undefined;
		const model = id.startsWith(`${provider}/`)
			? id.slice(provider.length + 1)
			: id;
		return modelCatalog.getPricing(kind, model);
	});

	const router = new ModelRouter(telemetry);
	const tokens = new ApiTokenStore(mongo);
	const agentTokens = new AgentTokenStore(mongo);
	const accounts = new AccountStore({
		mongo,
		defaultWorkspaceId: () => workspaces.defaultWorkspaceId(),
		setupToken: config.setupToken,
	});
	const gatewayData = new GatewayData(
		config.mongodbUrl,
		options.mongoSelectionTimeoutMs,
	);
	const synapseRepository = config.mongodbUrl
		? new MongoSynapseRepository(
				config.mongodbUrl,
				(details) => {
					// Repository-level logging covers REST, MCP and health probes equally.
					if (options.releaseMongoPerRequest) {
						const log =
							details.event === "synapse.storage_failed"
								? console.error
								: console.info;
						log(details.event, details);
					} else if (details.event === "synapse.storage_failed")
						server.log.error(details, details.event);
					else server.log.info(details, details.event);
				},
				options.mongoSelectionTimeoutMs,
			)
		: new MemorySynapseRepository();
	const synapse = new SynapseService(synapseRepository, {
		timeZone: config.synapseTimeZone ?? "UTC",
		// Agents hear of notes that change around them through their webhooks.
		onChange: (change) => appEvents.onSynapseChanged(change),
	});
	// What is built on the notes: capture, retrieval, commitments, briefings,
	// and the maintenance job the background sweep runs.
	const knowledge = synapseFeatures(synapse, {
		maintenance: {
			log: (message, details) => server.log.error(details, message),
		},
	});
	// Channels share the control-plane client, so a Worker request that
	// authenticates and posts stays on one MongoDB connection.
	const channelRepository = mongo
		? new MongoChannelRepository(mongo)
		: new MemoryChannelRepository();
	const botRepository = mongo
		? new MongoBotRepository(mongo)
		: new MemoryBotRepository();
	const bots = new BotService(botRepository);
	const botWebRequests = new BotWebRequestStore(mongo);
	const agentWebhookRepository = mongo
		? new MongoAgentWebhookRepository(mongo)
		: new MemoryAgentWebhookRepository();
	const webhookTransport =
		options.agentWebhooks?.transport ??
		(options.webTransport === "fetch"
			? fetchWebhookTransport()
			: nodeWebhookTransport());
	const webhookAgents = {
		find: async (id: string) => {
			const agent = await agentTokens.find(id);
			return (
				agent && {
					name: agent.name,
					workspaceId: agent.workspaceId,
					status: agent.status,
					permissions: agent.permissions,
				}
			);
		},
	};
	const agentWebhooks: AgentWebhooks = new AgentWebhooks({
		mayDeliverLoopAssignment: async (w, id, event) =>
			!!(await directory.resolve(w, { kind: "agent", id }))?.loopAct &&
			assignments.mayNotify(w, id, event),
		mayDeliverDecision: (w, id, event) => organization.mayNotify(w, id, event),
		repository: agentWebhookRepository,
		agents: webhookAgents,
		workspaces,
		threadAuthor: async (workspaceId, channelId, messageId) => {
			const entry = await channelRepository.getEntry(
				workspaceId,
				channelId,
				messageId,
			);
			return entry?.type === "message" ? entry.author : null;
		},
		transport: webhookTransport,
		resolver:
			options.agentWebhooks?.resolver ??
			(webhookTransport.pinsAddress ? systemResolver : undefined),
		timing: options.agentWebhooks?.timing,
		timeoutMs: options.agentWebhooks?.timeoutMs,
		// A Worker request's background work has about 30 seconds: it sends
		// the first POST, and its retries wait for a later request's sweep.
		maxTimerMs:
			options.webTransport === "fetch"
				? (options.agentWebhooks?.timing?.gapMs ?? 5_000) + 1_000
				: 60_000,
		log: (message, details) => server.log.error(details, message),
	});
	// What else happens in the app that an agent's webhook reports: changes to
	// channels, Synapse, the agent itself, and its workspace.
	const appEvents = new AppEvents({
		webhooks: agentWebhooks,
		agents: webhookAgents,
		workspaces,
	});
	const channels: ChannelService = new ChannelService(channelRepository, {
		// A message that mentions one of the gateway's own bots starts its
		// reply; one meant for an agent elsewhere wakes it through its webhook.
		onMessage: async (channel, message, context) => {
			// A message that links a commitment is recorded on it first, so a
			// bot answering the same message is briefed with the change.
			if (message.body.includes("[["))
				await workspaces
					.get(channel.workspaceId)
					.then(
						(workspace) =>
							workspace &&
							knowledge.commitments.onMessage(sharedSpaceId(workspace), {
								channelId: channel.id,
								channelName: channel.name,
								seq: message.seq,
								body: message.body,
								author: message.author,
							}),
					)
					.catch(() => {});
			await Promise.allSettled([
				botRunner.onMessage(channel, message),
				agentWebhooks.onMessage(channel, message, context),
				mcpEvents?.onMessage(channel, message),
			]);
		},
		onMessageChange: (channel, message, change) =>
			appEvents.onMessageChanged(channel, message, change),
		onChange: (channel, change) => appEvents.onChannelChanged(channel, change),
		directory: {
			// A channel's agents are agent tokens and the bots the gateway runs.
			agents: async (workspaceId) => {
				const workspace = await workspaces.get(workspaceId);
				if (!workspace) return [];
				const [tokens, hosted] = await Promise.all([
					agentTokens.settings(workspace, true),
					bots.bots(workspaceId),
				]);
				return [
					...tokens.tokens.map((token) => ({
						agentTokenId: token.id,
						name: token.name,
						status: token.status,
						hosted: false,
					})),
					...hosted.map((bot) => ({
						agentTokenId: bot.id,
						name: bot.name,
						// A paused bot can be in a channel; it answers nothing.
						status: bot.enabled ? ("active" as const) : ("revoked" as const),
						hosted: true,
					})),
				];
			},
			people: async (workspaceId) => {
				const workspace = await workspaces.get(workspaceId);
				if (!workspace) return [];
				return (await accounts.workspaceMembers(workspace)).members.map(
					(member) => ({ id: member.id, name: member.name || member.email }),
				);
			},
		},
	});
	// An app that signs in to an agent with OAuth is recorded in that agent's
	// history; the agent's own record decides what the app may do.
	const oauthAgents: OAuthAgents = {
		permissions: async (workspaceId, agentId) => {
			const agent = await agentTokens.find(agentId);
			if (!agent || agent.auth !== "oauth") return null;
			const own = agent.workspaceId ?? (await workspaces.defaultWorkspaceId());
			return own === workspaceId ? agent.permissions : null;
		},
		record: async (workspaceId, agentId, action, detail, actorName, app) => {
			const workspace = await workspaces.get(workspaceId);
			if (!workspace) return;
			await agentTokens.note(workspace, agentId, action, detail, actorName);
			if (app)
				await appEvents.onAgentApp(
					workspaceId,
					agentId,
					action === "connected"
						? {
								kind: "connected",
								app: app.name,
								approvedBy: actorName ?? null,
							}
						: {
								kind: "disconnected",
								app: app.name,
								reason: app.reason ?? "",
								by: actorName ?? null,
							},
				);
		},
	};
	const oauthRepository = mongo
		? new MongoOAuthRepository(mongo)
		: new MemoryOAuthRepository();
	const oauth = new OAuthService(oauthRepository, oauthAgents);
	const eventTransport = options.mcpEvents?.transport ?? webhookTransport;
	const eventRepository =
		options.mcpEvents?.repository ??
		(mongo ? new MongoEventRepository(mongo) : undefined);
	const mcpEvents =
		eventRepository && eventTransport.pinsAddress
			? new McpEvents({
					repository: eventRepository,
					callback: new Callback(
						eventTransport,
						options.mcpEvents?.resolver ?? systemResolver,
					),
					authorized: async (subscription) => {
						const agent = await agentTokens.find(subscription.agentId);
						if (
							!agent ||
							agent.status !== "active" ||
							!agent.permissions.includes("mcp:read") ||
							!agent.permissions.includes("mcp:call") ||
							(agent.workspaceId ?? (await workspaces.defaultWorkspaceId())) !==
								subscription.workspaceId
						)
							return false;
						const workspace = await workspaces.get(subscription.workspaceId);
						if (!workspace || workspace.archivedAt) return false;
						if (subscription.grantId) {
							const grant = await oauthRepository.getGrant(
								subscription.grantId,
							);
							if (
								!grant ||
								grant.agentId !== subscription.agentId ||
								grant.workspaceId !== subscription.workspaceId ||
								!grant.refresh ||
								Date.parse(grant.refresh.expiresAt) <= Date.now()
							)
								return false;
						}
						const channel = await channelRepository.getChannel(
							subscription.workspaceId,
							subscription.arguments.channel_id,
						);
						return (
							!!channel &&
							!channel.archivedAt &&
							channel.agents.some(
								(member) => member.agentTokenId === subscription.agentId,
							)
						);
					},
					threadAuthor: async (workspaceId, channelId, messageId) => {
						const entry = await channelRepository.getEntry(
							workspaceId,
							channelId,
							messageId,
						);
						return entry?.type === "message" ? entry.author : null;
					},
				})
			: undefined;

	const origin = (request: Parameters<typeof publicOrigin>[0]) =>
		publicOrigin(request, {
			publicUrl: config.publicUrl,
			assumeHttps: options.assumeHttps,
		});
	const proxies = new ProxyStore(config.web?.proxies ?? [], mongo);
	const web = new WebService({
		store: proxies,
		transport:
			options.webDirect?.transport ??
			(options.webTransport === "fetch" ? fetchTransport() : nodeTransport()),
		...(options.webDirect?.resolver
			? { resolver: options.webDirect.resolver }
			: {}),
		...(options.webFetch ? { fetchImpl: options.webFetch } : {}),
		telemetry,
		disabled: config.web?.disabled ?? false,
	});
	const webTools = web.available ? webToolSet(web) : undefined;
	const videoStore = new VideoStore(config.video?.connections ?? [], mongo);
	const videoJobs = new VideoJobStore(mongo);
	// A workspace's first budget is the monthly video budget it had before.
	const budgetStore = new BudgetStore(mongo, {
		seed: (workspaceId) => videoStore.budgetSeed(workspaceId),
	});
	const budgets = new BudgetService(budgetStore, {
		knownAgents: (workspace) => agentIds.ids(workspace),
		onChargeError: (error) =>
			console.error("gateway.budget_charge_failed", mongoErrorDetails(error)),
	});
	// Every priced language model call counts on the budgets that cover it.
	telemetry.setSpendListener((spend) =>
		budgets.chargeLlm(
			spend.workspaceId,
			spend.caller,
			spend.model,
			spend.costUsd,
		),
	);
	const video = new VideoService({
		store: videoStore,
		jobs: videoJobs,
		...(options.videoFetch ? { fetchImpl: options.videoFetch } : {}),
		telemetry,
		budgets,
		disabled: config.video?.disabled ?? false,
	});
	// The operator's off switch removes the tools, as it does `web_fetch`.
	const videoTools = video.available ? videoToolSet(video) : undefined;
	const orgRepository = mongo
		? new MongoOrganizationRepository(mongo)
		: new MemoryOrganizationRepository();
	const directory = organizationDirectory(
		workspaces,
		accounts,
		agentTokens,
		botRepository,
		channels,
		oauth,
	);
	const organization: OrganizationService = new OrganizationService(
		orgRepository,
		directory,
		{
			now: options.organizationNow,
			// Use the same durable-storage and pinned-transport capabilities as MCP push.
			...(eventRepository && webhookTransport.pinsAddress
				? {
						notify: (w, caseId, n) =>
							agentWebhooks.onOrganizationNotice(w, n.recipient.id, {
								key: n.key,
								event: {
									type: n.type,
									at: n.at,
									caseId,
									outcomeId: n.outcomeId,
								},
							}),
					}
				: {}),
		},
	);
	const loopRepo = mongo
		? new MongoLoopRepository(mongo)
		: new MemoryLoopRepository();
	const loops = new LoopsService(
		loopRepo,
		organization,
		directory,
		orgRepository,
		options.organizationNow,
	);
	const assignments: LoopsAssignments = new LoopsAssignments(
		loopRepo,
		(row) => loops.reconcileRun(row),
		eventRepository && webhookTransport.pinsAddress
			? (w, id, notice) => agentWebhooks.onLoopAssignment(w, id, notice)
			: undefined,
	);
	let orgSweep: Promise<void> | undefined;
	let nextOrgSweep = 0;
	const sweepOrganization = () => {
		orgSweep ??= organization
			.sweep()
			.then(() => assignments.sweep())
			.finally(() => {
				orgSweep = undefined;
			});
		return orgSweep;
	};
	const toolSets = [
		organizationToolSet(organization),
		loopsToolSet(loops, assignments),
		synapseToolSet(synapse, {
			features: knowledge,
			// A capture that names a page reads it as `web_fetch` would.
			...(webTools
				? {
						fetchPage: (agent, url, context) =>
							webTools.handlers.web_fetch(
								agent,
								{ url, maxChars: WEB_LIMITS.maxChars },
								context,
							) as Promise<WebFetchResult>,
					}
				: {}),
		}),
		channelToolSet(channels),
		modelToolSet({ providers, routing, router, telemetry, budgets }),
		// The operator's off switch removes the tool, not just its answers.
		...(webTools ? [webTools] : []),
		...(videoTools ? [videoTools] : []),
	];
	const botRunner: BotRunner = new BotRunner({
		bots: botRepository,
		channels,
		chat: { providers, routing, router, telemetry, budgets },
		workspaces,
		toolSets,
		webRequests: botWebRequests,
		// A bot that uses Synapse starts each reply knowing what applies to it.
		briefing: async (bot, workspace, task) => {
			const brief = await knowledge.briefing.brief(
				{
					own: agentSpaceId(bot.id),
					shared: sharedSpaceId(workspace),
					agentName: bot.name,
				},
				{ task: task.slice(0, MAX_TASK_LENGTH) },
				// The message is in the conversation already; a system prompt
				// does not repeat what someone in a channel wrote.
				{ titled: false },
			);
			const holds =
				brief.remit ||
				[
					brief.rules,
					brief.goals,
					brief.decisions,
					brief.evidence,
					brief.questions,
					brief.commitments,
				].some((items) => items.length);
			return holds ? brief.text : null;
		},
		// A Worker reply has about 30 seconds after its response; a proxy can take most of that.
		minProxyMs: options.webTransport === "fetch" ? 20_000 : 5_000,
		log: (message, details) => server.log.error(details, message),
	});
	/** A bot has a Synapse space of its own, like an agent token. */
	const agentIds = {
		ids: async (workspace: WorkspaceRef) =>
			new Set([
				...(await agentTokens.ids(workspace)),
				...(await bots.bots(workspace.id)).map((bot) => bot.id),
			]),
	};
	let persistenceInitialized = false;
	const server = Fastify({
		pluginTimeout: options.pluginTimeout,
		logger:
			options.logger === false
				? false
				: {
						redact: ["req.headers.authorization"],
						// Fastify's own request fields, with a video link's token masked:
						// the token is the only credential for that video.
						serializers: {
							req: (raw) => {
								// Fastify hands its own request, with `ip` and `host`.
								const request = raw as typeof raw & {
									ip?: string;
									host?: string;
								};
								const version = request.headers?.["accept-version"];
								return {
									method: request.method,
									url: redactDownloadUrl(request.url ?? ""),
									version: typeof version === "string" ? version : undefined,
									host: request.host,
									remoteAddress: request.ip,
									remotePort: request.socket?.remotePort,
								};
							},
						},
					},
	});

	const maintenance =
		options.maintenanceToken === undefined
			? undefined
			: registerMaintenanceRoutes(server, {
					token: options.maintenanceToken,
					ready: () => initializePersistence(server),
					sweep: () => sweepBackgroundWork(server, 1),
					drain: () => settleBackgroundWork(server),
				});

	// Before any route: a /v1 route without a declared scope fails to register.
	requireRouteScopes(server);
	server.register(cors, {
		origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
		methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	});
	// Install after CORS so browsers can read authentication failures too.
	server.after(() =>
		registerApiAccess(server, tokens, accounts, workspaces, config.setupToken),
	);
	server.register(healthRoutes, {
		config,
		persistenceInitialized: () => persistenceInitialized,
		synapseProbe:
			synapseRepository instanceof MongoSynapseRepository
				? () => synapseRepository.check()
				: undefined,
		// Worker clients belong to one request; never share pending I/O across them.
		synapseCacheMs: options.releaseMongoPerRequest ? 0 : 5000,
		pingTimeoutMs: options.mongoSelectionTimeoutMs,
	});
	server.register(authRoutes, {
		accounts,
		workspaces,
		data: gatewayData,
		clearData: async (fence) => {
			// Usage queued before the clear is written now if possible. The rest
			// is held aside: dropped once the data is deleted, so a later flush
			// can't restore it, and requeued if the clear fails.
			await telemetry.drain().catch(() => false);
			const held = telemetry.takePending();
			try {
				await gatewayData.clear(fence);
			} catch (error) {
				telemetry.restorePending(held);
				throw error;
			}
			workspaces.forgetDefault();
		},
	});
	server.register(teamRoutes, { accounts, workspaces });
	server.register(workspaceRoutes, { workspaces });
	server.register(oauthSignInRoutes, { oauth });
	server.register(catalogRoutes, { catalog: modelCatalog });
	// Everything a workspace owns lives under its id. The access hook resolves
	// and authorizes `:workspace` before any of these handlers run.
	server.register(
		async (scoped) => {
			scoped.register(modelsRoutes, {
				providers,
				onChanged: (workspaceId, by) =>
					appEvents.onModelsChanged(workspaceId, "models", by),
			});
			scoped.register(failoverRoutes, {
				providers,
				routing,
				onChanged: (workspaceId, by) =>
					appEvents.onModelsChanged(workspaceId, "failover", by),
			});
			scoped.register(routingRoutes, {
				routing,
				providers,
				onChanged: (workspaceId, change, by) =>
					appEvents.onModelsChanged(workspaceId, change, by),
			});
			scoped.register(chatRoutes, {
				providers,
				routing,
				router,
				telemetry,
				budgets,
				corsOrigins: config.corsOrigins,
			});
			scoped.register(decisionsRoutes, { providers, telemetry, budgets });
			scoped.register(budgetRoutes, { budgets });
			scoped.register(telemetryRoutes, { telemetry });
			scoped.register(apiTokenRoutes, { tokens });
			scoped.register(agentTokenRoutes, {
				tokens: agentTokens,
				oauth,
				webhooks: agentWebhooks,
				events: appEvents,
			});
			scoped.register(agentRoutes, { agentTokens, bots, oauth });
			scoped.register(agentWebhookRoutes, {
				webhooks: agentWebhooks,
				agentTokens,
				bots,
			});
			scoped.register(memberRoutes, { accounts });
			scoped.register(synapseRoutes, {
				synapse,
				features: knowledge,
				...(web.available
					? {
							fetchPage: (request, url, deadline) =>
								web.fetch(
									requestWorkspace(request),
									request.telemetryCaller ?? {
										id: "synapse:capture",
										name: "Synapse capture",
										kind: "user" as const,
									},
									{ url, maxChars: WEB_LIMITS.maxChars },
									{ deadline },
								),
						}
					: {}),
				agentTokens: agentIds,
				agentName: async (workspace, id) =>
					(await bots.bots(workspace.id)).find((bot) => bot.id === id)?.name ??
					(await agentTokens.find(id))?.name ??
					null,
				// The proposing agent hears the decision through its webhook.
				onProposalDecided: (workspaceId, proposal) =>
					agentWebhooks.onProposalDecided(workspaceId, proposal),
			});
			scoped.register(channelRoutes, { channels });
			scoped.register(organizationRoutes, { organization });
			scoped.register(loopsRoutes, { loops, organization, assignments });
			scoped.register(botRoutes, { bots, webRequests: botWebRequests });
			scoped.register(webRoutes, {
				store: proxies,
				web,
				onChanged: (workspaceId, change, by) =>
					appEvents.onWebChanged(workspaceId, change, by),
			});
			scoped.register(videoRoutes, { store: videoStore, video, origin });
			scoped.register(overviewRoutes, {
				accounts,
				agentTokens,
				tokens,
				bots,
				botWebRequests,
				oauth,
				synapse,
				channels,
				proxies,
				web,
				telemetry,
			});
		},
		{ prefix: "/v1/:workspace" },
	);
	// A finished video's link: the token in it is the capability.
	server.register(videoDownloadRoutes, { video });
	// How an MCP app signs in to an agent without a token to copy.
	server.register(oauthRoutes, {
		oauth,
		origin,
		dashboardUrl: config.dashboardUrl,
	});
	// Agents reach their workspace through their token: one tool set per feature.
	server.register(mcpRoutes, {
		events: mcpEvents,
		toolSets,
		agentTokens,
		oauth,
		origin,
		workspaces,
		corsOrigins: config.corsOrigins,
		version: packageJson.version,
	});
	if (options.dashboardDir) registerDashboard(server, options.dashboardDir);

	const initialize = async (onError?: PersistenceErrorHandler) => {
		let initialized = true;
		let defaultWorkspace: WorkspaceRef | undefined;
		try {
			defaultWorkspace = await workspaces.defaultWorkspace();
			await Promise.all([
				providers.ensureIndexes(),
				tokens.ensureIndexes(),
				agentTokens.ensureIndexes(),
				proxies.ensureIndexes(),
				videoStore.ensureIndexes(),
				videoJobs.ensureIndexes(),
				budgetStore.ensureIndexes(),
			]);
			await providers.check(defaultWorkspace);
		} catch (error) {
			initialized = false;
			server.log.warn(
				mongoErrorDetails(error),
				"Saved model settings could not be loaded; environment providers remain available.",
			);
			onError?.("providers", error);
		}
		try {
			// Creates the default workspace's routing document when it is missing.
			await routing.config(
				defaultWorkspace ?? (await workspaces.defaultWorkspace()),
			);
		} catch (error) {
			initialized = false;
			server.log.warn(
				mongoErrorDetails(error),
				"Saved routing settings could not be initialized or loaded.",
			);
			onError?.("routing", error);
		}
		persistenceInitialized = initialized;
		return initialized;
	};
	initializers.set(server, initialize);
	if (!options.deferPersistence)
		server.addHook("onReady", async () => {
			await initialize();
		});

	const closeAll = async () => {
		// Every store drops its client even when another one fails to close;
		// a client left behind would be reused from a later request.
		const results = await Promise.allSettled([
			telemetry.close(),
			providers.close(),
			routing.close(),
			tokens.close(),
			agentTokens.close(),
			accounts.close(),
			workspaces.close(),
			gatewayData.close(),
			synapseRepository.close(),
			channelRepository.close(),
			botRepository.close(),
			agentWebhookRepository.close(),
			oauthRepository.close(),
			proxies.close(),
			videoStore.close(),
			videoJobs.close(),
			budgetStore.close(),
		]);
		const failed = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failed) throw failed.reason;
	};
	// A crashed or restarted run is picked up here, and so is a webhook POST
	// whose retry waits longer than a timer. Workers have no timers between
	// requests: a reply interrupted there is not retried, and webhook retries
	// wait for the sweep a later request starts (`catchUpBackgroundWork`).
	let sweeper: ReturnType<typeof setInterval> | undefined;
	if (!options.deferPersistence && options.backgroundTimers !== false)
		server.addHook("onReady", async () => {
			sweeper = setInterval(() => {
				botRunner.sweep().catch(() => {});
				sweepOrganization().catch(() => {});
				agentWebhooks.sweep().catch(() => {});
				knowledge.maintenance.sweep().catch(() => {});
				mcpEvents?.catchUp();
			}, BOT_SWEEP_INTERVAL_MS);
			sweeper.unref();
		});
	backgrounds.set(server, {
		settle: async () => {
			// Bot replies can enqueue fresh webhook/MCP work. Wait for producers
			// first so a completed early consumer snapshot cannot permit sleep.
			await botRunner.idle();
			await orgSweep;
			await agentWebhooks.idle();
			await mcpEvents?.idle();
			await knowledge.maintenance.idle();
			// Budget charges for calls this request made.
			await budgets.idle();
		},
		sweep: async (maxMcpEvents = 50) => {
			await Promise.all([
				botRunner.sweep(),
				sweepOrganization(),
				agentWebhooks.sweep(),
				mcpEvents?.sweep(maxMcpEvents),
				knowledge.maintenance.sweep(),
			]);
		},
		catchUp: () => {
			if (Date.now() >= nextOrgSweep) {
				nextOrgSweep = Date.now() + BOT_SWEEP_INTERVAL_MS;
				sweepOrganization().catch(() => {});
			}
			agentWebhooks.catchUp();
			mcpEvents?.catchUp();
		},
	});
	let backgroundClosing: Promise<PromiseSettledResult<void>[]> | undefined;
	const stopBackground = () => {
		backgroundClosing ??= Promise.allSettled([
			botRunner.close(),
			orgSweep,
			agentWebhooks.close(),
			mcpEvents?.close(),
			knowledge.maintenance.close(),
		]);
		return backgroundClosing;
	};
	server.addHook("preClose", async () => {
		clearInterval(sweeper);
		// Fastify waits for active HTTP handlers before onClose. Cancel producers
		// now so maintenance drains can finish and interrupted leases are handed back.
		// Await maintenance before closing the HTTP listener, including callers that
		// disconnected. allSettled observes failures; stores stay open until onClose.
		void stopBackground();
		await maintenance?.close();
	});
	server.addHook("onClose", async () => {
		const stopped = await stopBackground();
		modelCatalog.stop();
		await closeAll();
		const failed = stopped.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	});

	if (options.releaseMongoPerRequest) releases.set(server, closeAll);

	return server;
}

/** Closes MongoDB sockets opened while handling one Worker request. */
export async function releaseRequestResources(
	server: ReturnType<typeof Fastify>,
): Promise<void> {
	await releases.get(server)?.();
}

/**
 * Settles once work started by requests but finished after them is done:
 * a bot's reply to a message. The Worker entry keeps a request's database
 * clients until then.
 */
export async function settleBackgroundWork(
	server: ReturnType<typeof Fastify>,
): Promise<void> {
	await backgrounds.get(server)?.settle();
}

/**
 * Starts a sweep of webhook POSTs that are due, unless one started in the last
 * few seconds. The Worker entry calls it after each request, since it has no
 * timers between requests; `settleBackgroundWork` then waits for it.
 */
export function catchUpBackgroundWork(server: ReturnType<typeof Fastify>) {
	backgrounds.get(server)?.catchUp();
}

/** Starts bot runs and webhook POSTs that nobody is working on, then waits for them. */
export async function sweepBackgroundWork(
	server: ReturnType<typeof Fastify>,
	maxMcpEvents = 50,
): Promise<void> {
	const background = backgrounds.get(server);
	await background?.sweep(maxMcpEvents);
	await background?.settle();
}

/** Loads durable settings inside a Worker request, after routes are compiled. */
export async function initializePersistence(
	server: ReturnType<typeof Fastify>,
	onError?: PersistenceErrorHandler,
): Promise<boolean> {
	return (await initializers.get(server)?.(onError)) ?? false;
}

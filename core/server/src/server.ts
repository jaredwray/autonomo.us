import cors from "@fastify/cors";
import Fastify from "fastify";
import packageJson from "../package.json" with { type: "json" };
import { registerApiAccess, requireRouteScopes } from "./auth/access.js";
import { AccountStore } from "./auth/accounts.js";
import { AgentTokenStore } from "./auth/agent-tokens.js";
import { ApiTokenStore } from "./auth/tokens.js";
import { BotService } from "./bots/bots.js";
import { MemoryBotRepository, MongoBotRepository } from "./bots/repository.js";
import { BotRunner } from "./bots/runner.js";
import { ChannelService } from "./channels/channels.js";
import { channelToolSet } from "./channels/mcp.js";
import { MemoryChannelRepository } from "./channels/memory-repository.js";
import { MongoChannelRepository } from "./channels/mongo-repository.js";
import { type ApiConfig, configFromEnv } from "./config.js";
import { registerDashboard } from "./dashboard.js";
import { FailoverPolicyStore } from "./failover.js";
import { GatewayData } from "./gateway-data.js";
import { mcpRoutes } from "./mcp/server.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import { controlPlaneConnection, mongoErrorDetails } from "./mongo.js";
import {
	type ProviderRegistry,
	registryFromConfig,
} from "./providers/registry.js";
import { ProviderSettingsStore } from "./providers/settings.js";
import { agentTokenRoutes } from "./routes/agent-tokens.js";
import { apiTokenRoutes } from "./routes/api-tokens.js";
import { authRoutes } from "./routes/auth.js";
import { botRoutes } from "./routes/bots.js";
import { channelRoutes } from "./routes/channels.js";
import { chatRoutes } from "./routes/chat.js";
import { decisionsRoutes } from "./routes/decisions.js";
import { failoverRoutes } from "./routes/failover.js";
import { healthRoutes } from "./routes/health.js";
import { catalogRoutes, modelsRoutes } from "./routes/models.js";
import { routingRoutes } from "./routes/routing.js";
import { synapseRoutes } from "./routes/synapse.js";
import { teamRoutes } from "./routes/team.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { memberRoutes, workspaceRoutes } from "./routes/workspaces.js";
import { ModelRouter } from "./routing/router.js";
import { RoutingSettingsStore } from "./routing/settings.js";
import { synapseToolSet } from "./synapse/mcp.js";
import { MemorySynapseRepository } from "./synapse/memory-repository.js";
import { MongoSynapseRepository } from "./synapse/mongo-repository.js";
import { SynapseService } from "./synapse/synapse.js";
import { MongoTelemetrySink } from "./telemetry/mongo.js";
import { TelemetryService } from "./telemetry/telemetry.js";
import { type WorkspaceRef, WorkspaceStore } from "./workspaces/store.js";

const releases = new WeakMap<ReturnType<typeof Fastify>, () => Promise<void>>();
const backgrounds = new WeakMap<
	ReturnType<typeof Fastify>,
	{ settle(): Promise<void>; sweep(): Promise<void> }
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
		? controlPlaneConnection(config.mongodbUrl)
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
	const gatewayData = new GatewayData(config.mongodbUrl);
	const synapseRepository = config.mongodbUrl
		? new MongoSynapseRepository(config.mongodbUrl)
		: new MemorySynapseRepository();
	const synapse = new SynapseService(synapseRepository, {
		timeZone: config.synapseTimeZone ?? "UTC",
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
	const channels: ChannelService = new ChannelService(channelRepository, {
		// A message that mentions one of the gateway's own bots starts its reply.
		onMessage: (channel, message) => botRunner.onMessage(channel, message),
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
	const toolSets = [synapseToolSet(synapse), channelToolSet(channels)];
	const botRunner: BotRunner = new BotRunner({
		bots: botRepository,
		channels,
		chat: { providers, routing, router, telemetry },
		workspaces,
		toolSets,
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
				: { redact: ["req.headers.authorization"] },
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
	server.register(catalogRoutes, { catalog: modelCatalog });
	// Everything a workspace owns lives under its id. The access hook resolves
	// and authorizes `:workspace` before any of these handlers run.
	server.register(
		async (scoped) => {
			scoped.register(modelsRoutes, { providers });
			scoped.register(failoverRoutes, { providers, routing });
			scoped.register(routingRoutes, { routing, providers });
			scoped.register(chatRoutes, {
				providers,
				routing,
				router,
				telemetry,
				corsOrigins: config.corsOrigins,
			});
			scoped.register(decisionsRoutes, { providers, telemetry });
			scoped.register(telemetryRoutes, { telemetry });
			scoped.register(apiTokenRoutes, { tokens });
			scoped.register(agentTokenRoutes, { tokens: agentTokens });
			scoped.register(memberRoutes, { accounts });
			scoped.register(synapseRoutes, { synapse, agentTokens: agentIds });
			scoped.register(channelRoutes, { channels });
			scoped.register(botRoutes, { bots });
		},
		{ prefix: "/v1/:workspace" },
	);
	// Agents reach their workspace through their token: one tool set per feature.
	server.register(mcpRoutes, {
		toolSets,
		agentTokens,
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
		]);
		const failed = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failed) throw failed.reason;
	};
	// A crashed or restarted run is picked up here. Workers have no timers
	// between requests; there the Worker entry sweeps on a schedule.
	let sweeper: ReturnType<typeof setInterval> | undefined;
	if (!options.deferPersistence)
		server.addHook("onReady", async () => {
			sweeper = setInterval(() => {
				botRunner.sweep().catch(() => {});
			}, BOT_SWEEP_INTERVAL_MS);
			sweeper.unref();
		});
	backgrounds.set(server, {
		settle: () => botRunner.idle(),
		sweep: () => botRunner.sweep(),
	});
	server.addHook("onClose", async () => {
		clearInterval(sweeper);
		// Replies in progress finish before their database client closes.
		await botRunner.idle();
		modelCatalog.stop();
		await closeAll();
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

/** Starts bot runs that nobody is working on, then waits for them. */
export async function sweepBackgroundWork(
	server: ReturnType<typeof Fastify>,
): Promise<void> {
	const background = backgrounds.get(server);
	await background?.sweep();
	await background?.settle();
}

/** Loads durable settings inside a Worker request, after routes are compiled. */
export async function initializePersistence(
	server: ReturnType<typeof Fastify>,
	onError?: PersistenceErrorHandler,
): Promise<boolean> {
	return (await initializers.get(server)?.(onError)) ?? false;
}

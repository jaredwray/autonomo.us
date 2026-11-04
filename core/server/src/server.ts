import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerApiAccess } from "./auth/access.js";
import { AccountStore } from "./auth/accounts.js";
import { AgentTokenStore } from "./auth/agent-tokens.js";
import { ApiTokenStore } from "./auth/tokens.js";
import { type ApiConfig, configFromEnv } from "./config.js";
import { registerDashboard } from "./dashboard.js";
import { FailoverPolicyStore } from "./failover.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import { mongoErrorDetails } from "./mongo.js";
import {
	type ProviderRegistry,
	registryFromConfig,
} from "./providers/registry.js";
import { ProviderSettingsStore } from "./providers/settings.js";
import { agentTokenRoutes } from "./routes/agent-tokens.js";
import { apiTokenRoutes } from "./routes/api-tokens.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { decisionsRoutes } from "./routes/decisions.js";
import { failoverRoutes } from "./routes/failover.js";
import { healthRoutes } from "./routes/health.js";
import { modelsRoutes } from "./routes/models.js";
import { routingRoutes } from "./routes/routing.js";
import { teamRoutes } from "./routes/team.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { ModelRouter } from "./routing/router.js";
import { RoutingSettingsStore } from "./routing/settings.js";
import { MongoTelemetrySink } from "./telemetry/mongo.js";
import { TelemetryService } from "./telemetry/telemetry.js";

const releases = new WeakMap<ReturnType<typeof Fastify>, () => Promise<void>>();
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
	const registry = options.registry ?? registryFromConfig(config);
	const settings = new ProviderSettingsStore(config, registry);
	const failover = options.failover ?? new FailoverPolicyStore(config.failover);
	const modelCatalog = options.modelCatalog ?? new ModelCatalogService();
	const telemetry =
		options.telemetry ??
		new TelemetryService({
			sink: config.mongodbUrl
				? new MongoTelemetrySink(config.mongodbUrl)
				: undefined,
			flushIntervalMs: options.releaseMongoPerRequest ? 0 : undefined,
		});

	telemetry.setPricingResolver((id, provider) => {
		const kind = registry
			.listProviders()
			.find((connection) => connection.name === provider)?.kind;
		if (!kind || kind === "openai-compatible") return undefined;
		const model = id.startsWith(`${provider}/`)
			? id.slice(provider.length + 1)
			: id;
		return modelCatalog.getPricing(kind, model);
	});

	const routing = new RoutingSettingsStore(
		registry,
		failover,
		config.mongodbUrl,
	);
	const router = new ModelRouter(registry, routing, telemetry);
	const tokens = new ApiTokenStore(config.mongodbUrl);
	const agentTokens = new AgentTokenStore(config.mongodbUrl);
	const accounts = new AccountStore({ mongodbUrl: config.mongodbUrl });
	let persistenceInitialized = false;
	const server = Fastify({
		pluginTimeout: options.pluginTimeout,
		logger:
			options.logger === false
				? false
				: { redact: ["req.headers.authorization"] },
	});

	server.register(cors, {
		origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
		methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	});
	// Install after CORS so browsers can read authentication failures too.
	server.after(() =>
		registerApiAccess(server, tokens, accounts, config.setupToken),
	);
	server.register(healthRoutes, {
		config,
		persistenceInitialized: () => persistenceInitialized,
	});
	server.register(authRoutes, {
		accounts,
		setupTokenConfigured: Boolean(config.setupToken),
	});
	server.register(teamRoutes, { accounts });
	server.register(apiTokenRoutes, { tokens });
	server.register(agentTokenRoutes, { tokens: agentTokens });
	server.register(modelsRoutes, { registry, catalog: modelCatalog, settings });
	server.register(failoverRoutes, { failover, registry, routing });
	server.register(routingRoutes, { routing });
	server.register(chatRoutes, {
		registry,
		telemetry,
		failover,
		router,
		corsOrigins: config.corsOrigins,
	});
	server.register(telemetryRoutes, { telemetry });
	server.register(decisionsRoutes, { registry, telemetry });
	if (options.dashboardDir) registerDashboard(server, options.dashboardDir);

	const initialize = async (onError?: PersistenceErrorHandler) => {
		let initialized = true;
		try {
			await settings.initialize();
		} catch (error) {
			initialized = false;
			server.log.warn(
				mongoErrorDetails(error),
				"Saved model settings could not be loaded; environment providers remain available.",
			);
			onError?.("providers", error);
		}
		try {
			await routing.initialize();
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

	server.addHook("onClose", async () => {
		modelCatalog.stop();
		await settings.close();
		await tokens.close();
		await agentTokens.close();
		await accounts.close();
		await routing.close();
		await telemetry.close();
	});

	if (options.releaseMongoPerRequest) {
		releases.set(server, async () => {
			// Every store drops its client even when another one fails to close;
			// a client left behind would be reused from a later request.
			const results = await Promise.allSettled([
				telemetry.close(),
				settings.close(),
				tokens.close(),
				agentTokens.close(),
				accounts.close(),
				routing.close(),
			]);
			const failed = results.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (failed) throw failed.reason;
		});
	}

	return server;
}

/** Closes MongoDB sockets opened while handling one Worker request. */
export async function releaseRequestResources(
	server: ReturnType<typeof Fastify>,
): Promise<void> {
	await releases.get(server)?.();
}

/** Loads durable settings inside a Worker request, after routes are compiled. */
export async function initializePersistence(
	server: ReturnType<typeof Fastify>,
	onError?: PersistenceErrorHandler,
): Promise<boolean> {
	return (await initializers.get(server)?.(onError)) ?? false;
}

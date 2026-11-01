import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerApiAccess } from "./auth/access.js";
import { ApiTokenStore } from "./auth/tokens.js";
import { type ApiConfig, configFromEnv } from "./config.js";
import { FailoverPolicyStore } from "./failover.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import {
	type ProviderRegistry,
	registryFromConfig,
} from "./providers/registry.js";
import { ProviderSettingsStore } from "./providers/settings.js";
import { apiTokenRoutes } from "./routes/api-tokens.js";
import { chatRoutes } from "./routes/chat.js";
import { decisionsRoutes } from "./routes/decisions.js";
import { failoverRoutes } from "./routes/failover.js";
import { healthRoutes } from "./routes/health.js";
import { modelsRoutes } from "./routes/models.js";
import { routingRoutes } from "./routes/routing.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { ModelRouter } from "./routing/router.js";
import { RoutingSettingsStore } from "./routing/settings.js";
import { ClickHouseSink } from "./telemetry/clickhouse.js";
import { TelemetryService } from "./telemetry/telemetry.js";

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
			sink: config.clickhouse
				? new ClickHouseSink(config.clickhouse)
				: undefined,
		});

	const routing = new RoutingSettingsStore(
		registry,
		failover,
		config.mongodbUrl,
	);
	const router = new ModelRouter(registry, routing, telemetry);
	const tokens = new ApiTokenStore(config.mongodbUrl);
	const server = Fastify({
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
	server.after(() => registerApiAccess(server, tokens, config.ownerToken));
	server.register(healthRoutes, { config });
	server.register(apiTokenRoutes, {
		tokens,
		authenticationRequired: Boolean(config.ownerToken),
	});
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

	server.addHook("onReady", async () => {
		try {
			await settings.initialize();
		} catch {
			server.log.warn(
				"Saved model settings could not be loaded; environment providers remain available.",
			);
		}
		try {
			await routing.initialize();
		} catch {
			server.log.warn("Saved routing settings could not be loaded.");
		}
	});

	server.addHook("onClose", async () => {
		modelCatalog.stop();
		await settings.close();
		await tokens.close();
		await routing.close();
		await telemetry.stop();
	});

	return server;
}

import cors from "@fastify/cors";
import Fastify from "fastify";
import { type ApiConfig, configFromEnv } from "./config.js";
import {
	type ProviderRegistry,
	registryFromConfig,
} from "./providers/registry.js";
import { chatRoutes } from "./routes/chat.js";
import { healthRoutes } from "./routes/health.js";
import { modelsRoutes } from "./routes/models.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { ClickHouseSink } from "./telemetry/clickhouse.js";
import { TelemetryService } from "./telemetry/telemetry.js";

export type CreateServerOptions = {
	config?: ApiConfig;
	registry?: ProviderRegistry;
	telemetry?: TelemetryService;
	logger?: boolean;
};

export function createServer(options: CreateServerOptions = {}) {
	const config = options.config ?? configFromEnv();
	const registry = options.registry ?? registryFromConfig(config);
	const telemetry =
		options.telemetry ??
		new TelemetryService({
			sink: config.clickhouse
				? new ClickHouseSink(config.clickhouse)
				: undefined,
		});

	const server = Fastify({
		logger: options.logger ?? true,
	});

	server.register(cors, {
		origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
	});
	server.register(healthRoutes);
	server.register(modelsRoutes, { registry });
	server.register(chatRoutes, {
		registry,
		telemetry,
		corsOrigins: config.corsOrigins,
	});
	server.register(telemetryRoutes, { telemetry });

	server.addHook("onClose", async () => {
		await telemetry.stop();
	});

	return server;
}

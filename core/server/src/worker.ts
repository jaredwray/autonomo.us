import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { configFromEnv } from "./config.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import { mongoErrorDetails, withMongoRequestScope } from "./mongo.js";
import {
	createServer,
	initializePersistence,
	releaseRequestResources,
	settleBackgroundWork,
} from "./server.js";
import {
	releaseAfterResponse,
	scheduleTicksAsMicrotasks,
} from "./worker-requests.js";

const PORT = 3000;
const modelCatalog = new ModelCatalogService({ env });

/**
 * Fastify's router and schema validators generate functions. Workers allow that
 * only during module startup, so compile before fetch and defer database I/O
 * until a request. No persistence clients or refresh timers start here.
 */
async function prepareServer() {
	const restoreTicks = scheduleTicksAsMicrotasks();
	try {
		const server = createServer({
			config: configFromEnv({
				...env,
				CORS_ORIGIN: env.CORS_ORIGIN ?? "https://dev.autonomo.us",
			}),
			modelCatalog,
			// Wrangler's Pino shim lacks the symbols Fastify requires. Emit
			// credential-free structured console events at the Worker boundary.
			logger: false,
			releaseMongoPerRequest: true,
			assumeHttps: true,
			deferPersistence: true,
			pluginTimeout: 0,
		});
		await server.listen({ port: PORT, host: "127.0.0.1" });
		return server;
	} finally {
		restoreTicks();
	}
}

const server = await prepareServer();
const handler = httpServerHandler({ port: PORT });
let catalogStarted = false;
let configurationLogged = false;

export default {
	fetch(request: Request, bindings: unknown, ctx: ExecutionContext) {
		return withMongoRequestScope(async (close) => {
			const started = Date.now();
			const end = async () => {
				try {
					// A bot's reply to a message this request posted is still
					// running: it uses this request's sockets, so keep them.
					await settleBackgroundWork(server);
				} finally {
					try {
						await releaseRequestResources(server);
					} finally {
						await close();
					}
				}
			};
			let response: Response;
			try {
				const initialized = await initializePersistence(
					server,
					(store, error) => {
						console.error("gateway.persistence_failed", {
							store,
							...mongoErrorDetails(error),
						});
					},
				);
				if (initialized && !configurationLogged) {
					configurationLogged = true;
					if (env.MONGODB_URI) console.info("gateway.persistence_ready");
					else
						console.warn("gateway.mongodb_unconfigured", {
							message:
								"Set the MONGODB_URI Worker secret to persist configuration.",
						});
				}
				if (!catalogStarted) {
					catalogStarted = true;
					ctx.waitUntil(modelCatalog.refresh());
				}
				response = await handler.fetch(request, bindings, ctx);
			} catch (error) {
				console.error("gateway.request_failed", mongoErrorDetails(error));
				response = Response.json(
					{ error: "The API is unavailable. Check Worker logs." },
					{ status: 503, headers: { "cache-control": "no-store" } },
				);
			}
			console.info("gateway.request", {
				method: request.method,
				path: new URL(request.url).pathname,
				status: response.status,
				durationMs: Date.now() - started,
			});
			// Keep request resources until streaming and telemetry writes complete.
			const tracked = releaseAfterResponse(response, end);
			ctx.waitUntil(
				tracked.finished.catch((error) => {
					console.error("gateway.cleanup_failed", mongoErrorDetails(error));
				}),
			);
			return tracked.response;
		});
	},
};

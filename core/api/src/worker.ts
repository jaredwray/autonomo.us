import { httpServerHandler } from "cloudflare:node";
import { configFromEnv } from "./config.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import { createServer, releaseRequestResources } from "./server.js";
import { RequestTracker, releaseAfterResponse } from "./worker-requests.js";

const PORT = 3000;

type WorkerEnv = Record<string, string | undefined>;

let handler:
	| {
			fetch: (
				request: Request,
				env: WorkerEnv,
				ctx: ExecutionContext,
			) => Promise<Response>;
	  }
	| undefined;
let server: ReturnType<typeof createServer> | undefined;
let starting: Promise<void> | undefined;
const requests = new RequestTracker(async () => {
	if (server) await releaseRequestResources(server);
});

/**
 * Serves the Fastify gateway on Cloudflare Workers. Construction happens
 * inside fetch: Fastify's startup timer is not allowed in Worker global scope.
 * MongoDB sockets are closed after each request because Workers cannot reuse
 * them. Set MONGODB_URL as a Worker secret. CORS_ORIGIN defaults to the
 * development dashboard.
 */
async function ensureStarted(env: WorkerEnv, ctx: ExecutionContext) {
	if (handler && server) return;
	starting ??= start(env, ctx).catch((error: unknown) => {
		starting = undefined;
		handler = undefined;
		server = undefined;
		throw error;
	});
	await starting;
}

async function start(env: WorkerEnv, ctx: ExecutionContext) {
	const modelCatalog = new ModelCatalogService({ env });
	const created = createServer({
		config: configFromEnv({
			...env,
			CORS_ORIGIN: env.CORS_ORIGIN ?? "https://dev.autonomo.us",
		}),
		modelCatalog,
		logger: false,
		releaseMongoPerRequest: true,
	});
	await created.listen({ port: PORT, host: "127.0.0.1" });
	server = created;
	handler = httpServerHandler({ port: PORT });
	ctx.waitUntil(modelCatalog.refresh());
}

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
		await ensureStarted(env, ctx);
		const respond = handler;
		if (!respond) {
			throw new Error("The development API failed to start.");
		}
		// The handler resolves once headers are written; a streamed chat keeps
		// running (and records its telemetry) until the body ends, so clients
		// are released only after the last open response in this isolate.
		const end = requests.begin();
		let response: Response;
		try {
			response = await respond.fetch(request, env, ctx);
		} catch (error) {
			ctx.waitUntil(end());
			throw error;
		}
		const tracked = releaseAfterResponse(response, end);
		ctx.waitUntil(tracked.finished);
		return tracked.response;
	},
};

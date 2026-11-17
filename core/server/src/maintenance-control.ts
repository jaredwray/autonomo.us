import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
	MAINTENANCE_PATHS,
	PUBLIC_INGRESS_HEADER,
} from "./maintenance-protocol.js";

/** Per-process coalescing, not a distributed lock. MongoDB owns delivery leases. */
export function registerMaintenanceRoutes(
	server: FastifyInstance,
	options: {
		token: string;
		ready(): Promise<boolean>;
		sweep(): Promise<void>;
		drain(): Promise<void>;
	},
) {
	if (options.token.length < 32)
		throw new Error("Missing maintenance control token");
	const expected = Buffer.from(`Bearer ${options.token}`);
	const routes = new Set<string>(Object.values(MAINTENANCE_PATHS));
	let stopping = false;
	let sweeping: Promise<void> | undefined;
	let draining: Promise<void> | undefined;
	let checking: Promise<boolean> | undefined;
	let readyUntil = 0;
	const ready = () => {
		if (stopping) return Promise.resolve(false);
		if (Date.now() < readyUntil) return Promise.resolve(true);
		checking ??= Promise.resolve()
			.then(options.ready)
			.then((value) => {
				if (value) readyUntil = Date.now() + 5000;
				return value;
			})
			.finally(() => {
				checking = undefined;
			});
		return checking;
	};
	// Register before CORS/body parsing. Route identity catches aliases normalized
	// by the router; raw URL equality rejects encoded paths, queries and suffixes.
	server.addHook("onRequest", async (request, reply) => {
		const route = request.routeOptions.url;
		if (!routes.has(route ?? "") && !request.raw.url?.startsWith("/_internal"))
			return;
		reply.header("cache-control", "no-store");
		const canonical =
			request.raw.url === route &&
			((route === MAINTENANCE_PATHS.ready && request.method === "GET") ||
				((route === MAINTENANCE_PATHS.sweep ||
					route === MAINTENANCE_PATHS.drain) &&
					request.method === "POST"));
		const actual = Buffer.from(request.headers.authorization ?? "");
		if (
			!canonical ||
			request.headers[PUBLIC_INGRESS_HEADER] !== undefined ||
			actual.length !== expected.length ||
			!timingSafeEqual(actual, expected)
		) {
			return reply.code(404).send();
		}
		if (stopping) return reply.code(503).send();
	});
	for (const [operation, url] of Object.entries(MAINTENANCE_PATHS)) {
		server.route({
			method: operation === "ready" ? "GET" : "POST",
			url,
			exposeHeadRoute: false,
			logLevel: "silent",
			handler: async (_request, reply) => {
				reply.header("cache-control", "no-store");
				try {
					if (operation === "ready")
						return reply.code((await ready()) ? 204 : 503).send();
					if (operation === "sweep") {
						if (!(await ready()) || stopping) return reply.code(503).send();
						sweeping ??= Promise.resolve()
							.then(options.sweep)
							.finally(() => {
								sweeping = undefined;
							});
						await sweeping;
					} else {
						// A drain never initializes storage or scans persisted queues.
						draining ??= Promise.resolve()
							.then(options.drain)
							.finally(() => {
								draining = undefined;
							});
						await draining;
					}
					return reply.code(204).send();
				} catch {
					return reply.code(503).send();
				}
			},
		});
	}
	server.addHook("preClose", async () => {
		stopping = true;
	});
	return {
		/** Also await work whose HTTP caller disconnected, before closing stores. */
		async close() {
			stopping = true;
			while (checking || sweeping || draining) {
				await Promise.allSettled([checking, sweeping, draining]);
			}
		},
	};
}

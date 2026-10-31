import type { FastifyInstance } from "fastify";
import { type ApiTokenStore, secretMatches, tokenHash } from "./tokens.js";

/** Fixed gateway access until the resource/action permissions plan is implemented. */
export function registerApiAccess(
	server: FastifyInstance,
	tokens: ApiTokenStore,
	ownerToken?: string,
) {
	const ownerHash = ownerToken ? tokenHash(ownerToken) : null;
	server.addHook("onRequest", async (request, reply) => {
		const path = request.url.split("?")[0];
		if (!path.startsWith("/v1/") || request.method === "OPTIONS") return;
		const authorization = request.headers.authorization;
		// Preserve the existing trusted local setup when no owner is configured.
		if (!authorization && !ownerHash) return;
		const match = /^Bearer (\S+)$/i.exec(authorization ?? "");
		if (match && ownerHash && secretMatches(match[1], ownerHash)) return;
		const token = match ? await tokens.authenticate(match[1]) : null;
		if (!token) {
			reply.header("www-authenticate", "Bearer");
			return reply
				.code(401)
				.send({ error: { message: "A valid API token is required." } });
		}
		const readModels =
			(request.method === "GET" || request.method === "HEAD") &&
			["/v1/models", "/v1/models/catalog"].includes(path);
		const inference =
			request.method === "POST" && ["/v1/chat", "/v1/decisions"].includes(path);
		if (!readModels && !inference)
			return reply.code(403).send({
				error: {
					message: "An owner credential is required to manage the gateway.",
				},
			});
	});
}

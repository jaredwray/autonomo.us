import {
	API_TOKEN_PERMISSIONS,
	type ApiTokenPermission,
} from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { type ApiTokenStore, secretMatches, tokenHash } from "./tokens.js";

// Exact routes and actions: new endpoints are denied until explicitly listed.
const routePermissions = new Map<string, ApiTokenPermission>([
	["GET /v1/models", "models:read"],
	["GET /v1/models/catalog", "models:read"],
	["GET /v1/providers", "models:read"],
	["POST /v1/models", "models:edit"],
	["GET /v1/routing", "routing:read"],
	["GET /v1/failover", "routing:read"],
	["PUT /v1/routing", "routing:edit"],
	["PUT /v1/failover", "routing:edit"],
	["POST /v1/chat", "inference:run"],
	["POST /v1/decisions", "inference:run"],
	["GET /v1/telemetry/summary", "telemetry:read"],
	["GET /v1/telemetry/events", "telemetry:read"],
]);

export function registerApiAccess(
	server: FastifyInstance,
	tokens: ApiTokenStore,
	ownerToken?: string,
) {
	const ownerHash = ownerToken ? tokenHash(ownerToken) : null;
	server.addHook("onRequest", async (request, reply) => {
		// Fastify decodes paths before matching. Use its matched route so an
		// encoded /v1 prefix cannot bypass authentication or permission checks.
		const path = request.routeOptions.url ?? request.url.split("?")[0];
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
		const method = request.method === "HEAD" ? "GET" : request.method;
		const required = routePermissions.get(`${method} ${path}`);
		const allowed =
			required &&
			(token.permissions.includes(required) ||
				(required.endsWith(":read") &&
					token.permissions.includes(
						required.replace(":read", ":edit") as ApiTokenPermission,
					)));
		if (!allowed)
			return reply.code(403).send({
				error: {
					message: required
						? `This action requires ${API_TOKEN_PERMISSIONS[required]} permission.`
						: "An owner credential is required for this action.",
				},
			});
	});
}

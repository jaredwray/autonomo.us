import {
	API_TOKEN_PERMISSIONS,
	type ApiTokenPermission,
	type TeamMember,
	type TelemetryCaller,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AccountError, type AccountStore } from "./accounts.js";
import { type ApiTokenStore, secretMatches, tokenHash } from "./tokens.js";

/** How the current request authenticated. */
export type RequestAuth =
	| { kind: "user"; member: TeamMember; expiresAt: string }
	| { kind: "api-token" }
	/** SETUP_TOKEN: accepted only on the first-run setup routes. */
	| { kind: "setup" };

declare module "fastify" {
	interface FastifyRequest {
		telemetryCaller?: TelemetryCaller;
		auth?: RequestAuth;
	}
}

/** Sign-in and invite endpoints answer without credentials. */
const publicRoutes = new Set([
	"GET /v1/auth/status",
	"POST /v1/auth/session",
	"POST /v1/invites/preview",
	"POST /v1/invites/accept",
]);
/** Open while SETUP_TOKEN is unset; otherwise they require it. Handlers refuse once setup is complete. */
const setupRoutes = new Set(["POST /v1/setup", "GET /v1/setup/token"]);

/** The signed-in member for team and account routes. */
export function signedInMember(request: FastifyRequest): TeamMember {
	if (request.auth?.kind !== "user")
		throw new AccountError("Sign in as a team member for this action.", 403);
	return request.auth.member;
}

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
	["GET /v1/telemetry/analytics", "telemetry:read"],
]);

/**
 * Every /v1 request needs a signed-in team member or an API token. There is
 * no unauthenticated mode, before or after first-run setup.
 */
export function registerApiAccess(
	server: FastifyInstance,
	tokens: ApiTokenStore,
	accounts: AccountStore,
	setupToken?: string,
) {
	const setupHash = setupToken ? tokenHash(setupToken) : null;
	server.decorateRequest("telemetryCaller", undefined);
	server.decorateRequest("auth", undefined);
	const unauthorized = (reply: FastifyReply) => {
		reply.header("www-authenticate", "Bearer");
		return reply.code(401).send({
			error: { message: "Sign in or provide a valid API token." },
		});
	};
	server.addHook("onRequest", async (request, reply) => {
		// Fastify decodes paths before matching. Use its matched route so an
		// encoded /v1 prefix cannot bypass authentication or permission checks.
		const path = request.routeOptions.url ?? request.url.split("?")[0];
		if (!path.startsWith("/v1/") || request.method === "OPTIONS") return;
		const method = request.method === "HEAD" ? "GET" : request.method;
		const route = `${method} ${path}`;
		if (publicRoutes.has(route)) return;
		const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "");
		if (setupRoutes.has(route)) {
			if (!setupHash) return;
			if (match && secretMatches(match[1], setupHash)) {
				request.auth = { kind: "setup" };
				return;
			}
			return unauthorized(reply);
		}
		if (!match) return unauthorized(reply);
		if (setupHash && secretMatches(match[1], setupHash))
			return reply.code(403).send({
				error: { message: "The setup token only unlocks first-run setup." },
			});
		if (match[1].startsWith("ses_")) {
			const session = await accounts.authenticate(match[1]);
			if (!session) return unauthorized(reply);
			// Signed-in members use every dashboard route; team routes check roles.
			request.auth = { kind: "user", ...session };
			request.telemetryCaller = {
				id: `user:${session.member.id}`,
				name: session.member.name || session.member.email,
				kind: "user",
			};
			return;
		}
		const token = await tokens.authenticate(match[1]);
		if (!token) return unauthorized(reply);
		request.auth = { kind: "api-token" };
		request.telemetryCaller = {
			id: `api-token:${token.id}`,
			name: token.name,
			kind: "api-token",
		};
		const required = routePermissions.get(route);
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
						: "Sign in to the dashboard for this action.",
				},
			});
	});
}

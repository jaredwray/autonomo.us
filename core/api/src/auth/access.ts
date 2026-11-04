import {
	API_TOKEN_PERMISSIONS,
	type ApiTokenPermission,
	type TelemetryCaller,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccountStore, TeamActor } from "./accounts.js";
import { type ApiTokenStore, secretMatches, tokenHash } from "./tokens.js";

/** How the current request authenticated. `local` is pre-setup trusted mode. */
export type RequestAuth =
	| { kind: "local" }
	| { kind: "owner" }
	| { kind: "api-token" }
	| (Extract<TeamActor, { kind: "user" }> & { expiresAt: string });

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

export function teamActor(request: FastifyRequest): TeamActor {
	const auth = request.auth;
	if (auth?.kind === "owner") return { kind: "owner" };
	if (auth?.kind === "user") return { kind: "user", member: auth.member };
	return { kind: "local" };
}

/** Token audit entries name the person who acted. */
export function tokenActor(request: FastifyRequest) {
	const auth = request.auth;
	if (auth?.kind === "user")
		return {
			actor: "user" as const,
			name: auth.member.name || auth.member.email,
		};
	return {
		actor:
			auth?.kind === "owner" ? ("owner" as const) : ("local-admin" as const),
		name: undefined,
	};
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

export function registerApiAccess(
	server: FastifyInstance,
	tokens: ApiTokenStore,
	accounts: AccountStore,
	ownerToken?: string,
) {
	const ownerHash = ownerToken ? tokenHash(ownerToken) : null;
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
		if (publicRoutes.has(`${method} ${path}`)) return;
		const authorization = request.headers.authorization;
		if (!authorization) {
			// Trusted local mode lasts only until first-run setup creates an owner
			// account. Setup state is read fresh, and failures close access (503).
			if (ownerHash || (await accounts.isSetupComplete()))
				return unauthorized(reply);
			request.auth = { kind: "local" };
			return;
		}
		const match = /^Bearer (\S+)$/i.exec(authorization);
		if (match && ownerHash && secretMatches(match[1], ownerHash)) {
			request.auth = { kind: "owner" };
			request.telemetryCaller = { id: "owner", name: "Owner", kind: "owner" };
			return;
		}
		if (match?.[1].startsWith("ses_")) {
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
		const token = match ? await tokens.authenticate(match[1]) : null;
		if (!token) return unauthorized(reply);
		request.auth = { kind: "api-token" };
		request.telemetryCaller = {
			id: `api-token:${token.id}`,
			name: token.name,
			kind: "api-token",
		};
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
						: "Sign in to the dashboard or use the owner credential for this action.",
				},
			});
	});
}

import {
	API_TOKEN_PERMISSIONS,
	type ApiTokenPermission,
	type TeamMember,
	type TelemetryCaller,
	type WorkspaceRole,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
	WORKSPACE_ID_PATTERN,
	type WorkspaceRef,
	type WorkspaceStore,
} from "../workspaces/store.js";
import { AccountError, type AccountStore } from "./accounts.js";
import { type ApiTokenStore, secretMatches, tokenHash } from "./tokens.js";

/** How the current request authenticated. */
export type RequestAuth =
	| { kind: "user"; member: TeamMember; expiresAt: string }
	| { kind: "api-token" }
	/** SETUP_TOKEN: accepted only on the first-run setup routes. */
	| { kind: "setup" };

/** The workspace a request operates on, resolved from its path by the access hook. */
export type RequestWorkspace = WorkspaceRef & {
	name: string;
	archivedAt: string | null;
	role: WorkspaceRole;
	/** Org owners and admins: admins of every workspace through their org role. */
	implicit: boolean;
};

declare module "fastify" {
	interface FastifyRequest {
		telemetryCaller?: TelemetryCaller;
		auth?: RequestAuth;
		workspace?: RequestWorkspace;
	}
}

/**
 * What a workspace route does. API token permissions double as actions; the
 * rest are dashboard-only and no token can hold them.
 */
export type WorkspaceAction =
	| ApiTokenPermission
	| "workspace:read"
	| "workspace:update"
	| "workspace:lifecycle"
	| "members:read"
	| "members:manage"
	| "tokens:manage";

type RouteRule =
	| { scope: "public" }
	| { scope: "setup" }
	/** Instance routes: signed-in members, or a token holding `token` where listed. */
	| { scope: "instance"; token?: ApiTokenPermission }
	/** The `:workspace` path segment names the workspace; see `resolveWorkspace`. */
	| { scope: "workspace"; action: WorkspaceAction; allowArchived?: boolean };

const workspace = (action: WorkspaceAction, allowArchived = false) =>
	({ scope: "workspace", action, allowArchived }) as const;
const tokenRoutes = (base: string) =>
	[
		[`GET ${base}`, workspace("tokens:manage")],
		[`POST ${base}`, workspace("tokens:manage")],
		[`PATCH ${base}/:id`, workspace("tokens:manage")],
		[`POST ${base}/:id/roll`, workspace("tokens:manage")],
		[`DELETE ${base}/:id`, workspace("tokens:manage")],
	] as const;

/**
 * Every /v1 route and its scope. Startup fails for a /v1 route missing here,
 * so a new endpoint cannot ship unscoped. A route that names a workspace in
 * its path is always `workspace`-scoped, never `instance`.
 */
export const ROUTE_RULES = new Map<string, RouteRule>([
	["GET /v1/auth/status", { scope: "public" }],
	["POST /v1/auth/session", { scope: "public" }],
	["POST /v1/invites/preview", { scope: "public" }],
	["POST /v1/invites/accept", { scope: "public" }],
	// Open while SETUP_TOKEN is unset; otherwise they require it. Handlers
	// refuse once setup is complete.
	["POST /v1/setup", { scope: "setup" }],
	["GET /v1/setup/token", { scope: "setup" }],
	["GET /v1/auth/session", { scope: "instance" }],
	["DELETE /v1/auth/session", { scope: "instance" }],
	["PUT /v1/auth/password", { scope: "instance" }],
	["GET /v1/team", { scope: "instance" }],
	["POST /v1/team", { scope: "instance" }],
	["PATCH /v1/team/:id", { scope: "instance" }],
	["PUT /v1/team/:id/password", { scope: "instance" }],
	["DELETE /v1/team/:id", { scope: "instance" }],
	["POST /v1/team/invites", { scope: "instance" }],
	["DELETE /v1/team/invites/:id", { scope: "instance" }],
	["GET /v1/workspaces", { scope: "instance" }],
	["POST /v1/workspaces", { scope: "instance" }],
	["GET /v1/models/catalog", { scope: "instance", token: "models:read" }],
	["GET /v1/workspaces/:workspace", workspace("workspace:read", true)],
	["PATCH /v1/workspaces/:workspace", workspace("workspace:update")],
	["POST /v1/workspaces/:workspace/archive", workspace("workspace:lifecycle")],
	[
		"POST /v1/workspaces/:workspace/unarchive",
		workspace("workspace:lifecycle", true),
	],
	["GET /v1/:workspace/models", workspace("models:read")],
	["POST /v1/:workspace/models", workspace("models:edit")],
	["GET /v1/:workspace/providers", workspace("models:read")],
	["GET /v1/:workspace/routing", workspace("routing:read")],
	["PUT /v1/:workspace/routing", workspace("routing:edit")],
	["GET /v1/:workspace/failover", workspace("routing:read")],
	["PUT /v1/:workspace/failover", workspace("routing:edit")],
	["POST /v1/:workspace/chat", workspace("inference:run")],
	["POST /v1/:workspace/decisions", workspace("inference:run")],
	["GET /v1/:workspace/telemetry/summary", workspace("telemetry:read")],
	["GET /v1/:workspace/telemetry/events", workspace("telemetry:read")],
	["GET /v1/:workspace/telemetry/analytics", workspace("telemetry:read")],
	...tokenRoutes("/v1/:workspace/api-tokens"),
	...tokenRoutes("/v1/:workspace/agent-tokens"),
	["GET /v1/:workspace/members", workspace("members:read")],
	["PUT /v1/:workspace/members/:userId", workspace("members:manage")],
	["DELETE /v1/:workspace/members/:userId", workspace("members:manage")],
]);

/** What each workspace role may do, as a signed-in member. */
const MEMBER_ACTIONS = new Set<WorkspaceAction>([
	"workspace:read",
	"models:read",
	"routing:read",
	"routing:edit",
	"inference:run",
	"telemetry:read",
]);
const ADMIN_ACTIONS = new Set<WorkspaceAction>([
	...MEMBER_ACTIONS,
	// D4: adding connections and changing keys needs a workspace admin.
	"models:edit",
	"workspace:update",
	"members:read",
	"members:manage",
]);
/** Org owners and admins only (D3: tokens outlive the member who made them). */
const ORG_ACTIONS = new Set<WorkspaceAction>([
	...ADMIN_ACTIONS,
	"tokens:manage",
	"workspace:lifecycle",
]);

export function memberMay(
	access: Pick<RequestWorkspace, "role" | "implicit">,
	action: WorkspaceAction,
): boolean {
	return (
		access.implicit
			? ORG_ACTIONS
			: access.role === "admin"
				? ADMIN_ACTIONS
				: MEMBER_ACTIONS
	).has(action);
}

const ACTION_LABELS: Record<WorkspaceAction, string> = {
	...API_TOKEN_PERMISSIONS,
	"workspace:read": "Workspace: Read",
	"workspace:update": "Workspace: Edit",
	"workspace:lifecycle": "Workspace: Archive",
	"members:read": "Members: Read",
	"members:manage": "Members: Manage",
	"tokens:manage": "Tokens: Manage",
};

/** The signed-in member for team and account routes. */
export function signedInMember(request: FastifyRequest): TeamMember {
	if (request.auth?.kind !== "user")
		throw new AccountError("Sign in as a team member for this action.", 403);
	return request.auth.member;
}

/** The workspace the access hook resolved for this request. */
export function requestWorkspace(request: FastifyRequest): RequestWorkspace {
	if (!request.workspace)
		throw new Error("Workspace routes run only after the access hook.");
	return request.workspace;
}

function routeKey(method: string, url: string) {
	return `${method === "HEAD" ? "GET" : method} ${url}`;
}

/**
 * Refuses to register a /v1 route without a declared scope. Installed when the
 * server is created, before any route, so no route can skip it.
 */
export function requireRouteScopes(server: FastifyInstance) {
	server.addHook("onRoute", (route) => {
		if (!route.url.startsWith("/v1/")) return;
		const methods = Array.isArray(route.method) ? route.method : [route.method];
		for (const method of methods)
			if (method !== "OPTIONS" && !ROUTE_RULES.has(routeKey(method, route.url)))
				throw new Error(
					`Declare a scope for ${routeKey(method, route.url)} in ROUTE_RULES before registering it.`,
				);
	});
}

/**
 * Every /v1 request needs a signed-in team member or an API token. There is
 * no unauthenticated mode, before or after first-run setup. Workspace routes
 * take their workspace only from the `:workspace` path segment.
 */
export function registerApiAccess(
	server: FastifyInstance,
	tokens: ApiTokenStore,
	accounts: AccountStore,
	workspaces: WorkspaceStore,
	setupToken?: string,
) {
	const setupHash = setupToken ? tokenHash(setupToken) : null;
	server.decorateRequest("telemetryCaller", undefined);
	server.decorateRequest("auth", undefined);
	server.decorateRequest("workspace", undefined);
	const unauthorized = (reply: FastifyReply) => {
		reply.header("www-authenticate", "Bearer");
		return reply.code(401).send({
			error: { message: "Sign in or provide a valid API token." },
		});
	};
	const deny = (reply: FastifyReply, code: number, message: string) =>
		reply.code(code).send({ error: { message } });
	server.addHook("onRequest", async (request, reply) => {
		// Fastify decodes paths before matching. Use its matched route so an
		// encoded /v1 prefix cannot bypass authentication or permission checks.
		const path = request.routeOptions.url ?? request.url.split("?")[0];
		if (!path.startsWith("/v1/") || request.method === "OPTIONS") return;
		const rule = ROUTE_RULES.get(routeKey(request.method, path));
		if (rule?.scope === "public") return;
		const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "");
		if (rule?.scope === "setup") {
			if (!setupHash) return;
			if (match && secretMatches(match[1], setupHash)) {
				request.auth = { kind: "setup" };
				return;
			}
			return unauthorized(reply);
		}
		if (!match) return unauthorized(reply);
		if (setupHash && secretMatches(match[1], setupHash))
			return deny(reply, 403, "The setup token only unlocks first-run setup.");

		let member: TeamMember | undefined;
		let token: Awaited<ReturnType<ApiTokenStore["authenticate"]>> | undefined;
		if (match[1].startsWith("ses_")) {
			const session = await accounts.authenticate(match[1]);
			if (!session) return unauthorized(reply);
			member = session.member;
			request.auth = { kind: "user", ...session };
			request.telemetryCaller = {
				id: `user:${member.id}`,
				name: member.name || member.email,
				kind: "user",
			};
		} else {
			token = await tokens.authenticate(match[1]);
			if (!token) return unauthorized(reply);
			request.auth = { kind: "api-token" };
			request.telemetryCaller = {
				id: `api-token:${token.id}`,
				name: token.name,
				kind: "api-token",
			};
		}
		if (!rule) {
			// Deny by default: a matched route without a scope never runs. An
			// unmatched path falls through to Fastify's 404.
			if (request.routeOptions.url)
				return deny(reply, 403, "Sign in to the dashboard for this action.");
			return;
		}

		const tokenMay = (permission: string) =>
			token?.permissions.includes(permission as ApiTokenPermission) ||
			(permission.endsWith(":read") &&
				token?.permissions.includes(
					permission.replace(":read", ":edit") as ApiTokenPermission,
				));

		if (rule.scope === "instance") {
			if (!token) return;
			if (rule.token && tokenMay(rule.token)) return;
			return deny(
				reply,
				403,
				rule.token
					? `This action requires ${API_TOKEN_PERMISSIONS[rule.token]} permission.`
					: "Sign in to the dashboard for this action.",
			);
		}

		const id = (request.params as { workspace?: string }).workspace ?? "";
		const notFound = () => deny(reply, 404, "Workspace not found.");
		if (!WORKSPACE_ID_PATTERN.test(id)) return notFound();
		if (token) {
			// A token belongs to one workspace; null means it predates workspaces.
			const own = token.workspaceId ?? (await workspaces.defaultWorkspaceId());
			if (own !== id)
				return deny(reply, 403, "This token belongs to another workspace.");
			if (!(rule.action in API_TOKEN_PERMISSIONS))
				return deny(reply, 403, "Sign in to the dashboard for this action.");
		}
		const found = await workspaces.get(id);
		if (!found) return notFound();
		let role: WorkspaceRole = "admin";
		let implicit = false;
		if (member) {
			implicit = member.role !== "member";
			if (!implicit) {
				// Accounts from before workspaces already carry their default
				// membership: the account store applies that read rule.
				const membership = member.workspaces.find(
					(item) => item.workspaceId === id,
				);
				// No access and no workspace look the same: no oracle for ids.
				if (!membership) return notFound();
				role = membership.role;
			}
		}
		if (found.archivedAt && !rule.allowArchived)
			return deny(reply, 409, "This workspace is archived.");
		if (token && !tokenMay(rule.action))
			return deny(
				reply,
				403,
				`This action requires ${ACTION_LABELS[rule.action]} permission.`,
			);
		if (member && !memberMay({ role, implicit }, rule.action))
			return deny(
				reply,
				403,
				rule.action === "tokens:manage" || rule.action === "workspace:lifecycle"
					? "Only owners and admins can do this."
					: "Ask a workspace admin for this action.",
			);
		request.workspace = {
			id: found.id,
			isDefault: found.isDefault,
			name: found.name,
			archivedAt: found.archivedAt,
			role,
			implicit,
		};
	});
}

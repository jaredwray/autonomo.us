import {
	type AgentWakeActor,
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
	| {
			kind: "api-token";
			token: { id: string; name: string; permissions: ApiTokenPermission[] };
	  }
	/** SETUP_TOKEN: accepted only on the setup routes. */
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
	| "tokens:manage"
	| "synapse:decide"
	| "channels:manage"
	| "channels:moderate"
	| "agents:read"
	| "agents:manage";

type RouteRule =
	| { scope: "public" }
	| { scope: "setup" }
	/** Instance routes: signed-in members, or a token holding `token` where listed. */
	| { scope: "instance"; token?: ApiTokenPermission }
	/** The `:workspace` path segment names the workspace; see `resolveWorkspace`. */
	| { scope: "workspace"; action: WorkspaceAction; allowArchived?: boolean };

const workspace = (action: WorkspaceAction, allowArchived = false) =>
	({ scope: "workspace", action, allowArchived }) as const;
const synapseRoutes = (base: string) =>
	[
		[`GET ${base}/spaces`, workspace("synapse:read")],
		[`GET ${base}/templates`, workspace("synapse:read")],
		[`GET ${base}/spaces/:space/notes`, workspace("synapse:read")],
		[`POST ${base}/spaces/:space/notes`, workspace("synapse:edit")],
		[`GET ${base}/spaces/:space/notes/:title`, workspace("synapse:read")],
		[`PATCH ${base}/spaces/:space/notes/:title`, workspace("synapse:edit")],
		[
			`POST ${base}/spaces/:space/notes/:title/append`,
			workspace("synapse:edit"),
		],
		[`DELETE ${base}/spaces/:space/notes/:title`, workspace("synapse:edit")],
		[`GET ${base}/spaces/:space/unresolved`, workspace("synapse:read")],
		[`GET ${base}/spaces/:space/categories`, workspace("synapse:read")],
		[`GET ${base}/spaces/:space/graph`, workspace("synapse:read")],
		[`GET ${base}/spaces/:space/daily/:date`, workspace("synapse:read")],
		// A whole space in one response, so it needs the write-level grant.
		[`GET ${base}/spaces/:space/export`, workspace("synapse:edit")],
		[`POST ${base}/spaces/:space/import`, workspace("synapse:edit")],
		[
			`GET ${base}/spaces/:space/notes/:title/history`,
			workspace("synapse:read"),
		],
		[
			`GET ${base}/spaces/:space/notes/:title/history/:revision`,
			workspace("synapse:read"),
		],
		[
			`POST ${base}/spaces/:space/notes/:title/history/:revision/restore`,
			workspace("synapse:edit"),
		],
		[
			`POST ${base}/spaces/:space/notes/:title/evidence`,
			workspace("synapse:edit"),
		],
		[
			`POST ${base}/spaces/:space/notes/:title/status`,
			workspace("synapse:edit"),
		],
		// The handler also needs a signed-in person: approving is not for tokens.
		[
			`POST ${base}/spaces/:space/notes/:title/approve`,
			workspace("synapse:edit"),
		],
		[`POST ${base}/spaces/:space/capture`, workspace("synapse:edit")],
		[`GET ${base}/spaces/:space/retrieve`, workspace("synapse:read")],
		[`POST ${base}/spaces/:space/answers`, workspace("synapse:edit")],
		[`GET ${base}/spaces/:space/commitments`, workspace("synapse:read")],
		[`POST ${base}/spaces/:space/commitments`, workspace("synapse:edit")],
		[
			`POST ${base}/spaces/:space/commitments/:title/events`,
			workspace("synapse:edit"),
		],
		// A briefing only reads, though it is asked for with a POST.
		[`POST ${base}/context`, workspace("synapse:read")],
		[`GET ${base}/spaces/:space/maintenance`, workspace("synapse:read")],
		[`POST ${base}/spaces/:space/maintenance/run`, workspace("synapse:edit")],
		// The handler also needs a signed-in person: a review is not for tokens.
		[
			`POST ${base}/spaces/:space/maintenance/decide`,
			workspace("synapse:edit"),
		],
		[`GET ${base}/proposals`, workspace("synapse:read")],
		// Not a token permission: approvals need a person.
		[`POST ${base}/proposals/:id/decide`, workspace("synapse:decide")],
	] as const;
const organizationRoutes = (base: string) =>
	[
		[`GET ${base}/branch`, workspace("workspace:read")],
		[`GET ${base}/identities`, workspace("workspace:update")],
		[`GET ${base}/positions/:id`, workspace("workspace:read")],
		[`POST ${base}/positions`, workspace("workspace:update")],
		[`PATCH ${base}/positions/:id`, workspace("workspace:update")],
		[`PUT ${base}/settings`, workspace("workspace:update")],
		[`GET ${base}/rules`, workspace("workspace:read")],
		[`PUT ${base}/rules/:key`, workspace("workspace:update")],
		[`POST ${base}/preview`, workspace("workspace:read")],
		[`GET ${base}/cases`, workspace("workspace:read")],
		[`GET ${base}/cases/:id`, workspace("workspace:read")],
		[`POST ${base}/cases`, workspace("workspace:read")],
		[`POST ${base}/cases/:id/act`, workspace("workspace:read")],
	] as const;
const channelRoutes = (base: string) =>
	[
		[`GET ${base}`, workspace("channels:read")],
		// Creating and managing channels is for people in the dashboard and for
		// agents holding the manage grant over MCP, never for API tokens.
		[`POST ${base}`, workspace("channels:manage")],
		[`GET ${base}/agents`, workspace("channels:manage")],
		[`GET ${base}/:channel`, workspace("channels:read")],
		[`PATCH ${base}/:channel`, workspace("channels:manage")],
		[`POST ${base}/:channel/archive`, workspace("channels:manage")],
		[`POST ${base}/:channel/unarchive`, workspace("channels:manage")],
		[`GET ${base}/:channel/members`, workspace("channels:read")],
		[`PUT ${base}/:channel/agents/:agentTokenId`, workspace("channels:manage")],
		[
			`DELETE ${base}/:channel/agents/:agentTokenId`,
			workspace("channels:manage"),
		],
		[`GET ${base}/:channel/messages`, workspace("channels:read")],
		[`POST ${base}/:channel/messages`, workspace("channels:edit")],
		[`PATCH ${base}/:channel/messages/:message`, workspace("channels:edit")],
		// The author, or a workspace admin for anyone's (routes/channels.ts).
		[`DELETE ${base}/:channel/messages/:message`, workspace("channels:edit")],
		[`PUT ${base}/:channel/read`, workspace("channels:read")],
	] as const;
const tokenRoutes = (base: string, action: "tokens:manage" | "agents:manage") =>
	[
		[`GET ${base}`, workspace(action)],
		[`POST ${base}`, workspace(action)],
		[`PATCH ${base}/:id`, workspace(action)],
		[`POST ${base}/:id/roll`, workspace(action)],
		[`DELETE ${base}/:id`, workspace(action)],
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
	// refuse once setup is complete and the token is spent.
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
	// The dashboard's home page: everything a member can see, in one call.
	// Dashboard only; no token holds workspace:read.
	["GET /v1/:workspace/overview", workspace("workspace:read")],
	// API tokens reach the gateway's own REST API: org owners and admins only.
	...tokenRoutes("/v1/:workspace/api-tokens", "tokens:manage"),
	// Agents, however they are made, belong to their workspace's admins.
	...tokenRoutes("/v1/:workspace/agent-tokens", "agents:manage"),
	["GET /v1/:workspace/agents", workspace("agents:read")],
	["POST /v1/:workspace/agents/oauth", workspace("agents:manage")],
	["GET /v1/:workspace/agents/:agent/connections", workspace("agents:manage")],
	[
		"DELETE /v1/:workspace/agents/:agent/connections/:connection",
		workspace("agents:manage"),
	],
	// The URL an agent's events are POSTed to. Its settings hold the
	// receiver's credentials, so even reading them is for admins.
	["GET /v1/:workspace/agents/:agent/webhook", workspace("agents:manage")],
	["POST /v1/:workspace/agents/:agent/webhook", workspace("agents:manage")],
	["PATCH /v1/:workspace/agents/:agent/webhook", workspace("agents:manage")],
	["DELETE /v1/:workspace/agents/:agent/webhook", workspace("agents:manage")],
	[
		"POST /v1/:workspace/agents/:agent/webhook/secret",
		workspace("agents:manage"),
	],
	// A real POST, which may start a paid run at the receiver.
	[
		"POST /v1/:workspace/agents/:agent/webhook/test",
		workspace("agents:manage"),
	],
	// An app's OAuth sign-in to the MCP endpoint, decided in the dashboard.
	// Approving names a workspace and one of its agents; looking and refusing
	// grant nothing, so any signed-in person may.
	["GET /v1/oauth/sign-ins/:id", { scope: "instance" }],
	["POST /v1/oauth/sign-ins/:id/deny", { scope: "instance" }],
	[
		"POST /v1/:workspace/oauth/sign-ins/:id/approve",
		workspace("agents:manage"),
	],
	["GET /v1/:workspace/members", workspace("members:read")],
	["PUT /v1/:workspace/members/:userId", workspace("members:manage")],
	["DELETE /v1/:workspace/members/:userId", workspace("members:manage")],
	// Synapse: each workspace's shared space inherits the global one. Writes
	// to `global` also need an org owner or admin (routes/synapse.ts).
	...synapseRoutes("/v1/:workspace/synapse"),
	...channelRoutes("/v1/:workspace/channels"),
	...organizationRoutes("/v1/:workspace/organization"),
	// Agents the gateway runs. Dashboard only: no token holds these actions.
	["GET /v1/:workspace/bots", workspace("agents:read")],
	["POST /v1/:workspace/bots", workspace("agents:manage")],
	["GET /v1/:workspace/bots/activity", workspace("agents:read")],
	["GET /v1/:workspace/bots/:bot", workspace("agents:read")],
	["PATCH /v1/:workspace/bots/:bot", workspace("agents:manage")],
	["DELETE /v1/:workspace/bots/:bot", workspace("agents:manage")],
	// Sites a bot asked for outside its web scope: members look, admins decide.
	["GET /v1/:workspace/bots/:bot/web-requests", workspace("agents:read")],
	[
		"POST /v1/:workspace/bots/:bot/web-requests/:request/decide",
		workspace("agents:manage"),
	],
	// Proxies hold keys and spend money: members look, admins change them.
	["GET /v1/:workspace/proxies", workspace("proxies:read")],
	["POST /v1/:workspace/proxies", workspace("proxies:edit")],
	["PATCH /v1/:workspace/proxies/:name", workspace("proxies:edit")],
	["DELETE /v1/:workspace/proxies/:name", workspace("proxies:edit")],
	// A real, billable call through one proxy.
	["POST /v1/:workspace/proxies/:name/test", workspace("proxies:edit")],
	["GET /v1/:workspace/web/policy", workspace("proxies:read")],
	["PUT /v1/:workspace/web/policy", workspace("proxies:edit")],
	// Can spend the workspace's proxy budget, so admins only among people.
	["POST /v1/:workspace/web/fetch", workspace("web:fetch")],
	// Video providers hold keys and spend money: members look, admins change them.
	["GET /v1/:workspace/video", workspace("video:read")],
	["GET /v1/:workspace/video/models", workspace("video:read")],
	["POST /v1/:workspace/video/connections", workspace("video:edit")],
	["PATCH /v1/:workspace/video/connections/:name", workspace("video:edit")],
	["DELETE /v1/:workspace/video/connections/:name", workspace("video:edit")],
	["PUT /v1/:workspace/video/policy", workspace("video:edit")],
	// Starting a video spends the workspace's video budget, so admins only among people.
	["POST /v1/:workspace/video/jobs", workspace("video:generate")],
	["GET /v1/:workspace/video/jobs", workspace("video:generate")],
	["GET /v1/:workspace/video/jobs/:id", workspace("video:generate")],
	["POST /v1/:workspace/video/jobs/:id/cancel", workspace("video:generate")],
]);

/** What each workspace role may do, as a signed-in member. */
const MEMBER_ACTIONS = new Set<WorkspaceAction>([
	"workspace:read",
	"models:read",
	"routing:read",
	"routing:edit",
	"inference:run",
	"telemetry:read",
	"synapse:read",
	"synapse:edit",
	"channels:read",
	"channels:edit",
	// Any member creates and manages channels and their agents.
	"channels:manage",
	"agents:read",
	"proxies:read",
	"video:read",
]);
const ADMIN_ACTIONS = new Set<WorkspaceAction>([
	...MEMBER_ACTIONS,
	// D4: adding connections and changing keys needs a workspace admin.
	"models:edit",
	"workspace:update",
	"members:read",
	"members:manage",
	"synapse:decide",
	// Deleting someone else's message.
	"channels:moderate",
	// Creating and changing agents of every kind, and approving an app's
	// OAuth sign-in. An agent acts in this workspace only; one with
	// instructions spends its provider keys, like adding a connection.
	"agents:manage",
	// Proxy keys, the web policy, and fetches that spend the proxy budget.
	"proxies:edit",
	"web:fetch",
	// Video provider keys, the video limits, and videos that spend the budget.
	"video:edit",
	"video:generate",
]);
/** Org owners and admins only (D3: API tokens outlive the member who made them). */
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
	"synapse:decide": "Synapse: Decide proposals",
	"channels:manage": "Channels: Manage",
	"channels:moderate": "Channels: Moderate",
	"agents:read": "Agents: Read",
	"agents:manage": "Agents: Manage",
};

/**
 * Whether the caller of a workspace route may also do `action`, by the same
 * rules the access hook applies: a token's permissions, or a member's role.
 */
export function requestMay(
	request: FastifyRequest,
	action: WorkspaceAction,
): boolean {
	const auth = request.auth;
	if (auth?.kind === "api-token")
		return (
			auth.token.permissions.includes(action as ApiTokenPermission) ||
			(action.endsWith(":read") &&
				auth.token.permissions.includes(
					action.replace(":read", ":edit") as ApiTokenPermission,
				))
		);
	if (auth?.kind === "user")
		return memberMay(requestWorkspace(request), action);
	return false;
}

/** The signed-in member for team and account routes. */
export function signedInMember(request: FastifyRequest): TeamMember {
	if (request.auth?.kind !== "user")
		throw new AccountError("Sign in as a team member for this action.", 403);
	return request.auth.member;
}

/** Who made this request, as an event names them: a person or an API token. */
export function requestActor(request: FastifyRequest): AgentWakeActor {
	const auth = request.auth;
	if (auth?.kind === "user")
		return {
			kind: "user",
			id: auth.member.id,
			name: auth.member.name || auth.member.email,
		};
	if (auth?.kind === "api-token")
		return { kind: "api-token", id: auth.token.id, name: auth.token.name };
	return { kind: "system", id: "gateway", name: "The gateway" };
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
		for (const method of methods) {
			if (method === "OPTIONS") continue;
			const rule = ROUTE_RULES.get(routeKey(method, route.url));
			if (!rule)
				throw new Error(
					`Declare a scope for ${routeKey(method, route.url)} in ROUTE_RULES before registering it.`,
				);
			// A route that names a workspace must resolve and authorize it.
			if (route.url.includes(":workspace") && rule.scope !== "workspace")
				throw new Error(
					`${routeKey(method, route.url)} names a workspace, so its scope must be "workspace".`,
				);
		}
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
			return deny(reply, 403, "The setup token only unlocks setup.");

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
			request.auth = {
				kind: "api-token",
				token: {
					id: token.id,
					name: token.name,
					permissions: [...token.permissions],
				},
			};
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

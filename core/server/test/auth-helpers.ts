import type { ApiConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

export const PASSWORD = "correct horse battery";

export function authServer(config: Partial<ApiConfig> = {}) {
	return routeToDefaultWorkspace(
		createServer({
			config: { providers: [], corsOrigins: ["*"], ...config },
			logger: false,
		}),
	);
}

/** Stands in for the default workspace until setup or sign-in reveals its id. */
const PLACEHOLDER_WORKSPACE = "00000000-0000-4000-8000-000000000000";

/**
 * Makes `inject` send pre-workspace paths (`/v1/models`) to the default
 * workspace. Its id is learned at setup or sign-in through these helpers;
 * before that, requests go to a placeholder id (they are unauthenticated then).
 */
export function routeToDefaultWorkspace<T extends Server>(
	server: T,
): T & { workspaceId?: string } {
	const inject = server.inject.bind(server) as (
		options: object,
	) => ReturnType<Server["inject"]>;
	const target = server as T & { workspaceId?: string };
	Object.assign(server, {
		inject: (options: string | { url?: string }) => {
			const request = typeof options === "string" ? { url: options } : options;
			if (!request.url) return inject(request);
			return inject({
				...request,
				url: inWorkspace(
					request.url,
					target.workspaceId ?? PLACEHOLDER_WORKSPACE,
				),
			});
		},
	});
	return target;
}

/** Records the default workspace's id on a server wrapped by `routeToDefaultWorkspace`. */
export async function learnWorkspace(server: Server, token: string) {
	const target = server as Server & { workspaceId?: string };
	target.workspaceId ??= await defaultWorkspaceId(server, token);
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Resources that live under `/v1/:workspace/` (the catalog stays instance-level). */
const WORKSPACE_RESOURCES =
	/^\/v1\/(models(?!\/catalog)|providers|routing|failover|chat|decisions|telemetry|api-tokens|agent-tokens|members|synapse|channels|bots)(?=[/?]|$)/;

/**
 * Rewrites a pre-workspace path (`/v1/models`) to the same resource in a
 * workspace (`/v1/<id>/models`). Suites written before workspaces use it to
 * exercise the default workspace; isolation suites name workspaces directly.
 */
export function inWorkspace(url: string, workspaceId: string): string {
	return url.replace(WORKSPACE_RESOURCES, `/v1/${workspaceId}/$1`);
}

/** The default workspace's id, read through the API the way the dashboard reads it. */
export async function defaultWorkspaceId(
	server: { inject: Server["inject"] },
	token: string,
): Promise<string> {
	const response = await server.inject({
		method: "GET",
		url: "/v1/workspaces",
		headers: bearer(token),
	});
	if (response.statusCode !== 200)
		throw new Error(`Listing workspaces failed: ${response.body}`);
	const workspace = (
		response.json() as { workspaces: Array<{ id: string; isDefault: boolean }> }
	).workspaces.find((item) => item.isDefault);
	if (!workspace) throw new Error("No default workspace.");
	return workspace.id;
}

type Server = ReturnType<typeof createServer>;
type Session = { token: string; user: { id: string; email: string } };

/** Runs first-run setup through the HTTP API and returns the owner session. */
export async function completeSetup(
	server: Server,
	{
		email = "founder@example.com",
		name = "Founder",
		password = PASSWORD,
		headers = {},
	}: {
		email?: string;
		name?: string;
		password?: string;
		headers?: Record<string, string>;
	} = {},
): Promise<Session> {
	const response = await server.inject({
		method: "POST",
		url: "/v1/setup",
		headers,
		payload: { email, name, password },
	});
	if (response.statusCode !== 201)
		throw new Error(`Setup failed: ${response.body}`);
	const session = response.json() as Session;
	await learnWorkspace(server, session.token);
	return session;
}

export async function signIn(
	server: Server,
	email: string,
	password = PASSWORD,
): Promise<Session> {
	const response = await server.inject({
		method: "POST",
		url: "/v1/auth/session",
		payload: { email, password },
	});
	if (response.statusCode !== 201)
		throw new Error(`Sign-in failed: ${response.body}`);
	const session = response.json() as Session;
	await learnWorkspace(server, session.token);
	return session;
}

/** Creates an invite as `token` and redeems it as a new member. */
export async function joinWithInvite(
	server: Server,
	token: string,
	email: string,
	role = "member",
): Promise<Session> {
	// Members join the default workspace, as every member did before workspaces.
	const workspaceId = (server as Server & { workspaceId?: string }).workspaceId;
	const invite = await server.inject({
		method: "POST",
		url: "/v1/team/invites",
		headers: bearer(token),
		payload: {
			role,
			ttlDays: 7,
			...(role === "member" && workspaceId
				? { workspace: { workspaceId, role: "member" } }
				: {}),
		},
	});
	if (invite.statusCode !== 201)
		throw new Error(`Invite failed: ${invite.body}`);
	const accepted = await server.inject({
		method: "POST",
		url: "/v1/invites/accept",
		payload: {
			token: invite.json().token,
			email,
			name: email.split("@")[0],
			password: PASSWORD,
		},
	});
	if (accepted.statusCode !== 201)
		throw new Error(`Accept failed: ${accepted.body}`);
	return accepted.json();
}

/**
 * Completes first-run setup (or signs in as its owner, or reuses `token`)
 * and makes every `inject`
 * send that session unless the call sets its own authorization header.
 * Pass `authorization: ""` to send a request without credentials.
 */
export async function withSession<T extends Server>(
	server: T,
	token?: string,
): Promise<T & { session: string; workspaceId: string }> {
	// Servers sharing a database reuse the owner account created by the first.
	const setupComplete = (await server.inject("/v1/auth/status")).json()
		.setupComplete as boolean;
	const session =
		token ??
		(setupComplete
			? (await signIn(server, "founder@example.com")).token
			: (await completeSetup(server)).token);
	const inject = server.inject.bind(server) as (
		options: object,
	) => ReturnType<Server["inject"]>;
	const workspaceId = await defaultWorkspaceId(server, session);
	Object.assign(server, {
		session,
		workspaceId,
		inject: (options: string | { headers?: Record<string, string> }) => {
			const request: { url?: string; headers?: Record<string, string> } =
				typeof options === "string" ? { url: options } : options;
			const headers = {
				authorization: `Bearer ${session}`,
				...request.headers,
			};
			if (headers.authorization === "")
				delete (headers as Partial<typeof headers>).authorization;
			return inject({
				...request,
				...(request.url ? { url: inWorkspace(request.url, workspaceId) } : {}),
				headers,
			});
		},
	});
	return server as T & { session: string; workspaceId: string };
}

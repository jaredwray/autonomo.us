import type { ApiConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

export const PASSWORD = "correct horse battery";

export function authServer(config: Partial<ApiConfig> = {}) {
	return createServer({
		config: { providers: [], corsOrigins: ["*"], ...config },
		logger: false,
	});
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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
	return response.json();
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
	return response.json();
}

/** Creates an invite as `token` and redeems it as a new member. */
export async function joinWithInvite(
	server: Server,
	token: string,
	email: string,
	role = "member",
): Promise<Session> {
	const invite = await server.inject({
		method: "POST",
		url: "/v1/team/invites",
		headers: bearer(token),
		payload: { role, ttlDays: 7 },
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
): Promise<T & { session: string }> {
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
	Object.assign(server, {
		session,
		inject: (options: string | { headers?: Record<string, string> }) => {
			const request = typeof options === "string" ? { url: options } : options;
			const headers = {
				authorization: `Bearer ${session}`,
				...request.headers,
			};
			if (headers.authorization === "")
				delete (headers as Partial<typeof headers>).authorization;
			return inject({ ...request, headers });
		},
	});
	return server as T & { session: string };
}

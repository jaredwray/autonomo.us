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

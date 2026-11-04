import {
	type AcceptInviteRequest,
	type ChangePasswordRequest,
	type CurrentSession,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	type SetupRequest,
	type SignInRequest,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccountStore } from "../auth/accounts.js";

export const emailSchema = {
	type: "string",
	minLength: 3,
	maxLength: 254,
	pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
};
export const passwordSchema = {
	type: "string",
	minLength: PASSWORD_MIN_LENGTH,
	maxLength: PASSWORD_MAX_LENGTH,
};
export const nameSchema = { type: "string", maxLength: 100 };
const token = { type: "string", minLength: 1, maxLength: 200 };
const body = (properties: Record<string, object>) => ({
	type: "object",
	additionalProperties: false,
	required: Object.keys(properties),
	properties,
});

function sessionToken(request: FastifyRequest) {
	return /^Bearer (ses_\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
}

export async function authRoutes(
	server: FastifyInstance,
	options: { accounts: AccountStore; ownerCredentialConfigured: boolean },
) {
	const { accounts } = options;
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	server.get("/v1/auth/status", () =>
		accounts.status(options.ownerCredentialConfigured),
	);
	server.post<{ Body: SetupRequest }>(
		"/v1/setup",
		{
			schema: {
				body: body({
					email: emailSchema,
					name: { ...nameSchema, minLength: 1, pattern: "\\S" },
					password: passwordSchema,
				}),
			},
		},
		async (request, reply) =>
			reply.code(201).send(await accounts.completeSetup(request.body)),
	);
	server.post<{ Body: SignInRequest }>(
		"/v1/auth/session",
		{
			schema: {
				// Any stored password length may be tried; policy applies when setting one.
				body: body({
					email: emailSchema,
					password: { type: "string", minLength: 1, maxLength: 1024 },
				}),
			},
		},
		async (request, reply) =>
			reply.code(201).send(await accounts.signIn(request.body)),
	);
	server.get("/v1/auth/session", (request): CurrentSession => {
		const auth = request.auth;
		if (auth?.kind === "user")
			return { kind: "user", user: auth.member, expiresAt: auth.expiresAt };
		return {
			kind: auth?.kind === "owner" ? "owner" : "local",
			user: null,
			expiresAt: null,
		};
	});
	server.delete("/v1/auth/session", async (request, reply) => {
		const token = sessionToken(request);
		if (token) await accounts.signOut(token);
		return reply.code(204).send();
	});
	server.put<{ Body: ChangePasswordRequest }>(
		"/v1/auth/password",
		{
			schema: {
				body: body({
					currentPassword: { type: "string", minLength: 1, maxLength: 1024 },
					newPassword: passwordSchema,
				}),
			},
		},
		async (request, reply) => {
			const auth = request.auth;
			const token = sessionToken(request);
			if (auth?.kind !== "user" || !token)
				return reply.code(403).send({
					error: { message: "Sign in as a team member to change a password." },
				});
			await accounts.changePassword(auth.member, token, request.body);
			return reply.code(204).send();
		},
	);
	// Invite secrets travel in request bodies, never in URLs that reach logs.
	server.post<{ Body: { token: string } }>(
		"/v1/invites/preview",
		{ schema: { body: body({ token }) } },
		(request) => accounts.previewInvite(request.body.token),
	);
	server.post<{ Body: AcceptInviteRequest }>(
		"/v1/invites/accept",
		{
			schema: {
				body: body({
					token,
					email: emailSchema,
					name: nameSchema,
					password: passwordSchema,
				}),
			},
		},
		async (request, reply) =>
			reply.code(201).send(await accounts.acceptInvite(request.body)),
	);
}

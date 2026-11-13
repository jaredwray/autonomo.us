import {
	type AcceptInviteRequest,
	type ChangePasswordRequest,
	type CurrentSession,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	type SetupCheck,
	type SetupRequest,
	type SignInRequest,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { signedInMember } from "../auth/access.js";
import type { AccountStore } from "../auth/accounts.js";
import type { GatewayData } from "../gateway-data.js";
import type { WorkspaceStore } from "../workspaces/store.js";
import { accessibleWorkspaces } from "./workspaces.js";

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
	options: {
		accounts: AccountStore;
		workspaces: WorkspaceStore;
		/** The gateway's saved data as a whole: counted, and cleared, by setup. */
		data: GatewayData;
		/** Deletes everything and resets what this server cached about it. */
		clearData: () => Promise<void>;
	},
) {
	const { accounts, data } = options;
	// Clearing needs the setup token (the store checks) and MongoDB.
	const canClear = () => accounts.setupTokenConfigured && data.canClear;
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	server.get("/v1/auth/status", () => accounts.status());
	// The access hook has already checked SETUP_TOKEN; this confirms it and
	// reports what setup would keep or clear.
	server.get("/v1/setup/token", async (_request, reply) => {
		if (await accounts.isSetupComplete())
			return reply.code(409).send({
				error: { message: "Setup is already complete. Sign in instead." },
			});
		let saved: Awaited<ReturnType<GatewayData["inventory"]>>;
		try {
			saved = await data.inventory();
		} catch {
			return reply.code(503).send({
				error: {
					message:
						"The gateway's data is unavailable. Check MongoDB and retry.",
				},
			});
		}
		const check: SetupCheck = {
			existing: { ...(await accounts.counts()), ...saved },
			canClear: canClear(),
		};
		return check;
	});
	server.post<{ Body: SetupRequest }>(
		"/v1/setup",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["email", "name", "password"],
					properties: {
						email: emailSchema,
						name: { ...nameSchema, minLength: 1, pattern: "\\S" },
						password: passwordSchema,
						data: { type: "string", enum: ["keep", "clear"] },
					},
				},
			},
		},
		async (request, reply) =>
			reply
				.code(201)
				.send(
					await accounts.completeSetup(
						request.body,
						canClear() ? options.clearData : undefined,
					),
				),
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
	server.get("/v1/auth/session", async (request): Promise<CurrentSession> => {
		const member = signedInMember(request);
		const auth = request.auth as { expiresAt: string };
		return {
			user: member,
			expiresAt: auth.expiresAt,
			workspaces: await accessibleWorkspaces(member, options.workspaces),
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
			const member = signedInMember(request);
			await accounts.changePassword(
				member,
				sessionToken(request) ?? "",
				request.body,
			);
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

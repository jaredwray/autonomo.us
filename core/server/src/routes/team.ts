import {
	type AddTeamMemberRequest,
	type CreateTeamInviteRequest,
	type ResetPasswordRequest,
	TEAM_INVITE_TTLS,
	TEAM_ROLES,
	type UpdateTeamMemberRequest,
	WORKSPACE_ROLES,
	type WorkspaceMembership,
} from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { signedInMember } from "../auth/access.js";
import { AccountError, type AccountStore } from "../auth/accounts.js";
import type { WorkspaceStore } from "../workspaces/store.js";
import { emailSchema, nameSchema, passwordSchema } from "./auth.js";

const role = { type: "string", enum: Object.keys(TEAM_ROLES) };
const workspace = {
	type: "object",
	additionalProperties: false,
	required: ["workspaceId", "role"],
	properties: {
		workspaceId: { type: "string", format: "uuid" },
		role: { enum: Object.keys(WORKSPACE_ROLES) },
	},
};
const params = {
	type: "object",
	required: ["id"],
	properties: { id: { type: "string", format: "uuid" } },
};
const body = (properties: Record<string, object>) => ({
	type: "object",
	additionalProperties: false,
	required: Object.keys(properties),
	properties,
});

export async function teamRoutes(
	server: FastifyInstance,
	{
		accounts,
		workspaces,
	}: { accounts: AccountStore; workspaces: WorkspaceStore },
) {
	/** A membership may only name a workspace that exists and is open. */
	const assertWorkspace = async (membership?: WorkspaceMembership) => {
		if (!membership) return;
		const found = await workspaces.get(membership.workspaceId);
		if (!found || found.archivedAt)
			throw new AccountError("Choose an open workspace for this member.", 400);
	};
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	server.get("/v1/team", (request) => accounts.team(signedInMember(request)));
	server.post<{ Body: AddTeamMemberRequest }>(
		"/v1/team",
		{
			schema: {
				body: {
					...body({
						email: emailSchema,
						name: nameSchema,
						role,
						password: passwordSchema,
					}),
					properties: {
						email: emailSchema,
						name: nameSchema,
						role,
						password: passwordSchema,
						workspace,
					},
				},
			},
		},
		async (request, reply) => {
			const actor = signedInMember(request);
			await assertWorkspace(request.body.workspace);
			return reply
				.code(201)
				.send(await accounts.addMember(request.body, actor));
		},
	);
	server.patch<{ Params: { id: string }; Body: UpdateTeamMemberRequest }>(
		"/v1/team/:id",
		{ schema: { params, body: body({ name: nameSchema, role }) } },
		(request) =>
			accounts.updateMember(
				request.params.id,
				request.body,
				signedInMember(request),
			),
	);
	server.put<{ Params: { id: string }; Body: ResetPasswordRequest }>(
		"/v1/team/:id/password",
		{ schema: { params, body: body({ password: passwordSchema }) } },
		(request) =>
			accounts.resetPassword(
				request.params.id,
				request.body.password,
				signedInMember(request),
			),
	);
	server.delete<{ Params: { id: string } }>(
		"/v1/team/:id",
		{ schema: { params } },
		(request) =>
			accounts.removeMember(request.params.id, signedInMember(request)),
	);
	server.post<{ Body: CreateTeamInviteRequest }>(
		"/v1/team/invites",
		{
			schema: {
				body: {
					...body({ role, ttlDays: { enum: [...TEAM_INVITE_TTLS] } }),
					properties: {
						role,
						ttlDays: { enum: [...TEAM_INVITE_TTLS] },
						workspace,
					},
				},
			},
		},
		async (request, reply) => {
			const actor = signedInMember(request);
			await assertWorkspace(request.body.workspace);
			return reply
				.code(201)
				.send(await accounts.createInvite(request.body, actor));
		},
	);
	server.delete<{ Params: { id: string } }>(
		"/v1/team/invites/:id",
		{ schema: { params } },
		(request) =>
			accounts.revokeInvite(request.params.id, signedInMember(request)),
	);
}

import {
	type AddTeamMemberRequest,
	type CreateTeamInviteRequest,
	type ResetPasswordRequest,
	TEAM_INVITE_TTLS,
	TEAM_ROLES,
	type UpdateTeamMemberRequest,
} from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { signedInMember } from "../auth/access.js";
import type { AccountStore } from "../auth/accounts.js";
import { emailSchema, nameSchema, passwordSchema } from "./auth.js";

const role = { type: "string", enum: Object.keys(TEAM_ROLES) };
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
	{ accounts }: { accounts: AccountStore },
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	server.get("/v1/team", (request) => accounts.team(signedInMember(request)));
	server.post<{ Body: AddTeamMemberRequest }>(
		"/v1/team",
		{
			schema: {
				body: body({
					email: emailSchema,
					name: nameSchema,
					role,
					password: passwordSchema,
				}),
			},
		},
		async (request, reply) =>
			reply
				.code(201)
				.send(await accounts.addMember(request.body, signedInMember(request))),
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
				body: body({ role, ttlDays: { enum: [...TEAM_INVITE_TTLS] } }),
			},
		},
		async (request, reply) =>
			reply
				.code(201)
				.send(
					await accounts.createInvite(request.body, signedInMember(request)),
				),
	);
	server.delete<{ Params: { id: string } }>(
		"/v1/team/invites/:id",
		{ schema: { params } },
		(request) =>
			accounts.revokeInvite(request.params.id, signedInMember(request)),
	);
}

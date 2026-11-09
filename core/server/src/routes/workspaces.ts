import {
	type CreateWorkspaceRequest,
	type SetWorkspaceMemberRequest,
	type TeamMember,
	type UpdateWorkspaceRequest,
	WORKSPACE_ROLES,
	type WorkspaceAccess,
	type WorkspaceDetails,
	type WorkspaceList,
} from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { requestWorkspace, signedInMember } from "../auth/access.js";
import { AccountError, AccountStore } from "../auth/accounts.js";
import type { WorkspaceStore } from "../workspaces/store.js";

const name = { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" };
const description = { type: "string", maxLength: 1000 };
const actorName = (member: TeamMember) => member.name || member.email;

/** Workspaces a member can open, with their role in each. */
export async function accessibleWorkspaces(
	member: TeamMember,
	workspaces: WorkspaceStore,
): Promise<WorkspaceAccess[]> {
	const all = await workspaces.list();
	if (AccountStore.canManage(member))
		return all.map((workspace) => ({
			...workspace,
			role: "admin",
			implicit: true,
		}));
	const roles = new Map(
		member.workspaces.map((item) => [item.workspaceId, item.role]),
	);
	return all.flatMap((workspace) => {
		const role = roles.get(workspace.id);
		return role ? [{ ...workspace, role, implicit: false }] : [];
	});
}

/** Workspace list, creation, and lifecycle. */
export async function workspaceRoutes(
	server: FastifyInstance,
	{ workspaces }: { workspaces: WorkspaceStore },
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	const detail = async (
		workspace: WorkspaceAccess,
	): Promise<WorkspaceDetails> => ({
		...workspace,
		actions:
			workspace.role === "admin" ? await workspaces.actions(workspace.id) : [],
	});
	const access = (
		workspace: Awaited<ReturnType<WorkspaceStore["get"]>>,
		request: Parameters<typeof requestWorkspace>[0],
	): WorkspaceAccess => {
		const resolved = requestWorkspace(request);
		if (!workspace) throw new AccountError("Workspace not found.", 404);
		return { ...workspace, role: resolved.role, implicit: resolved.implicit };
	};

	server.get("/v1/workspaces", async (request): Promise<WorkspaceList> => {
		const member = signedInMember(request);
		return {
			workspaces: await accessibleWorkspaces(member, workspaces),
			canCreate: AccountStore.canManage(member),
			persistence: workspaces.persistence,
		};
	});

	server.post<{ Body: CreateWorkspaceRequest }>(
		"/v1/workspaces",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name"],
					properties: { name, description },
				},
			},
		},
		async (request, reply) => {
			const member = signedInMember(request);
			if (!AccountStore.canManage(member))
				throw new AccountError(
					"Only owners and admins can create workspaces.",
					403,
				);
			const created = await workspaces.create(request.body, actorName(member));
			return reply
				.code(201)
				.send(await detail({ ...created, role: "admin", implicit: true }));
		},
	);

	server.get("/v1/workspaces/:workspace", async (request) => {
		const { id } = requestWorkspace(request);
		return detail(access(await workspaces.get(id), request));
	});

	server.patch<{ Body: UpdateWorkspaceRequest }>(
		"/v1/workspaces/:workspace",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name", "description"],
					properties: { name, description },
				},
			},
		},
		async (request) => {
			const updated = await workspaces.update(
				requestWorkspace(request).id,
				request.body,
				actorName(signedInMember(request)),
			);
			return detail(access(updated, request));
		},
	);

	for (const [path, archived] of [
		["archive", true],
		["unarchive", false],
	] as const)
		server.post(`/v1/workspaces/:workspace/${path}`, async (request) => {
			const updated = await workspaces.setArchived(
				requestWorkspace(request).id,
				archived,
				actorName(signedInMember(request)),
			);
			return detail(access(updated, request));
		});
}

/** Registered under `/v1/:workspace`: who can open the workspace, and with which role. */
export async function memberRoutes(
	server: FastifyInstance,
	{ accounts }: { accounts: AccountStore },
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	const params = {
		type: "object",
		required: ["workspace", "userId"],
		properties: {
			workspace: { type: "string" },
			userId: { type: "string", format: "uuid" },
		},
	};
	server.get("/members", (request) =>
		accounts.workspaceMembers(requestWorkspace(request)),
	);
	server.put<{
		Params: { userId: string };
		Body: SetWorkspaceMemberRequest;
	}>(
		"/members/:userId",
		{
			schema: {
				params,
				body: {
					type: "object",
					additionalProperties: false,
					required: ["role"],
					properties: { role: { enum: Object.keys(WORKSPACE_ROLES) } },
				},
			},
		},
		(request) =>
			accounts.setWorkspaceMember(
				requestWorkspace(request).id,
				request.params.userId,
				request.body.role,
				signedInMember(request),
			),
	);
	server.delete<{ Params: { userId: string } }>(
		"/members/:userId",
		{ schema: { params } },
		(request) =>
			accounts.setWorkspaceMember(
				requestWorkspace(request).id,
				request.params.userId,
				null,
				signedInMember(request),
			),
	);
}

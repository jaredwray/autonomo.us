import type { TeamRole } from "./team.js";

export const WORKSPACE_ROLES = { admin: "Admin", member: "Member" } as const;
export type WorkspaceRole = keyof typeof WORKSPACE_ROLES;

/** An isolation unit: its own connections, routing, tokens, and telemetry. */
export type Workspace = {
	/** Server-generated UUID, including for the default workspace. The `:workspace` path segment. */
	id: string;
	/** True for exactly one workspace: the one that holds everything from before workspaces. */
	isDefault: boolean;
	name: string;
	description: string;
	createdAt: string;
	createdBy: string | null;
	updatedAt: string;
	archivedAt: string | null;
};

export type WorkspaceMembership = { workspaceId: string; role: WorkspaceRole };

/** A workspace as one caller sees it. */
export type WorkspaceAccess = Workspace & {
	role: WorkspaceRole;
	/** True for org owners and admins, who are admins of every workspace. */
	implicit: boolean;
};

export type WorkspaceAction = {
	id: string;
	action: "created" | "updated" | "archived" | "unarchived";
	timestamp: string;
	actorName: string | null;
	detail: string;
};

export type WorkspaceList = {
	workspaces: WorkspaceAccess[];
	/** Whether the caller may create, archive, and unarchive workspaces. */
	canCreate: boolean;
	persistence: "mongodb" | "memory";
};

export type WorkspaceDetails = WorkspaceAccess & {
	/** Latest 100 lifecycle changes; empty for workspace members. */
	actions: WorkspaceAction[];
};

export type CreateWorkspaceRequest = { name: string; description?: string };
export type UpdateWorkspaceRequest = { name: string; description: string };

export type MembershipAction = {
	id: string;
	workspaceId: string;
	userId: string;
	userEmail: string;
	action: "granted" | "changed" | "removed";
	before: WorkspaceRole | null;
	after: WorkspaceRole | null;
	actorName: string;
	timestamp: string;
};

export type WorkspaceMember = {
	id: string;
	email: string;
	name: string;
	orgRole: TeamRole;
	role: WorkspaceRole;
	/** Org owners and admins: access comes from the org role, not a membership. */
	implicit: boolean;
};

export type WorkspaceMembers = {
	members: WorkspaceMember[];
	/** Latest 100 membership changes in this workspace, newest first. */
	actions: MembershipAction[];
};

export type SetWorkspaceMemberRequest = { role: WorkspaceRole };

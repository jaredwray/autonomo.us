import type { WorkspaceAccess, WorkspaceMembership } from "./workspaces.js";

export const TEAM_ROLES = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
} as const;
export type TeamRole = keyof typeof TEAM_ROLES;

/** Passwords are 12–128 characters. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const TEAM_INVITE_TTLS = [1, 7, 30] as const;
export type TeamInviteTtl = (typeof TEAM_INVITE_TTLS)[number];

/** Public projection of a dashboard account. Password hashes and sessions are never included. */
export type TeamMember = {
	id: string;
	/** Sign-in identifier. No email is ever sent to it. */
	email: string;
	name: string;
	role: TeamRole;
	createdAt: string;
	updatedAt: string;
	joinedVia: "setup" | "invite" | "added";
	/** Who invited or added this member; null for the first owner. */
	addedBy: string | null;
	lastSignInAt: string | null;
	/**
	 * Workspace memberships. Org owners and admins are admins of every
	 * workspace; their stored memberships stay dormant until a demotion.
	 */
	workspaces: WorkspaceMembership[];
};

/** Invite links carry a one-time secret; only its digest is stored. */
export type TeamInvite = {
	id: string;
	role: TeamRole;
	/** Masked secret, safe to display. */
	prefix: string;
	createdAt: string;
	createdBy: string;
	expiresAt: string;
	status: "pending" | "accepted" | "revoked" | "expired";
	acceptedAt: string | null;
	/** Email of the account created from this invite. */
	acceptedBy: string | null;
	revokedAt: string | null;
	/** Workspace access granted when the invite is redeemed. */
	workspace: WorkspaceMembership | null;
};

export type TeamSettings = {
	members: TeamMember[];
	/** Newest first, limited to the latest 50. */
	invites: TeamInvite[];
	persistence: "mongodb" | "memory";
	/** The signed-in member. */
	currentUserId: string;
	/** Whether the caller may add, edit, invite, or remove members. */
	canManage: boolean;
};

export type AddTeamMemberRequest = {
	email: string;
	name: string;
	role: TeamRole;
	/** Initial password the admin shares with the new member. */
	password: string;
	/** Members only: workspace access to grant. Owners and admins see every workspace. */
	workspace?: WorkspaceMembership;
};
export type UpdateTeamMemberRequest = { name: string; role: TeamRole };
export type ResetPasswordRequest = { password: string };
export type ChangePasswordRequest = {
	currentPassword: string;
	newPassword: string;
};

export type CreateTeamInviteRequest = {
	role: TeamRole;
	ttlDays: TeamInviteTtl;
	/** Members only: workspace access granted on redemption. */
	workspace?: WorkspaceMembership;
};
export type TeamInviteSecret = {
	invite: TeamInvite;
	/** Shown once. The dashboard turns it into an invite link. */
	token: string;
};
export type InvitePreview = {
	role: TeamRole;
	invitedBy: string;
	expiresAt: string;
};
export type AcceptInviteRequest = {
	token: string;
	email: string;
	name: string;
	password: string;
};

/** Public, unauthenticated status the dashboard reads before choosing a screen. */
export type AuthStatus = {
	setupComplete: boolean;
	/** Setup is pending and SETUP_TOKEN is configured, so setup requires it. */
	setupTokenRequired: boolean;
	persistence: "mongodb" | "memory";
};

export type SetupRequest = { email: string; name: string; password: string };
export type SignInRequest = { email: string; password: string };

export type AuthSession = {
	/** Bearer credential for /v1 requests. Returned once at sign-in. */
	token: string;
	expiresAt: string;
	user: TeamMember;
};

export type CurrentSession = {
	user: TeamMember;
	expiresAt: string;
	/** Workspaces this member can open, with their role in each. */
	workspaces: WorkspaceAccess[];
};

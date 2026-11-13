export const API_TOKEN_TTLS = [1, 7, 30, 180, "never"] as const;
export type ApiTokenTtl = (typeof API_TOKEN_TTLS)[number];

export const API_TOKEN_PERMISSIONS = {
	"models:read": "Models: Read",
	"models:edit": "Models: Edit",
	"routing:read": "Routing: Read",
	"routing:edit": "Routing: Edit",
	"inference:run": "Inference: Run",
	"telemetry:read": "Telemetry: Read",
	"synapse:read": "Synapse: Read",
	"synapse:edit": "Synapse: Edit",
	"channels:read": "Channels: Read",
	"channels:edit": "Channels: Post",
} as const;
export type ApiTokenPermission = keyof typeof API_TOKEN_PERMISSIONS;
export const DEFAULT_API_TOKEN_PERMISSIONS: readonly ApiTokenPermission[] = [
	"models:read",
	"inference:run",
];

export type ApiToken<Permission extends string = ApiTokenPermission> = {
	id: string;
	/** The workspace this token belongs to; it can call only `/v1/<workspaceId>/…`. */
	workspaceId: string;
	name: string;
	description: string;
	permissions: Permission[];
	ttlDays: ApiTokenTtl;
	prefix: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
	status: "active" | "expired" | "revoked";
	/**
	 * How the holder proves who it is: a copied token, or, for agents only,
	 * an app that signs in with OAuth and holds no token of this kind.
	 */
	auth: "token" | "oauth";
	previousTokens: Array<{ prefix: string; expiresAt: string }>;
};

export type CreateApiTokenRequest<
	Permission extends string = ApiTokenPermission,
> = {
	name: string;
	description: string;
	ttlDays: ApiTokenTtl;
	/** Omitted API grants default to model discovery/inference; agent grants default to none. */
	permissions?: Permission[];
};
export type UpdateApiTokenRequest<
	Permission extends string = ApiTokenPermission,
> = Pick<
	CreateApiTokenRequest<Permission>,
	"name" | "description" | "permissions"
>;
export type RollApiTokenRequest = {
	ttlDays: ApiTokenTtl;
	previousTokenTtlSeconds: number;
};
export type ApiTokenSecret<Permission extends string = ApiTokenPermission> = {
	token: ApiToken<Permission>;
	secret: string;
};
export type ApiTokenAction = {
	id: string;
	tokenId: string;
	tokenName: string;
	/** `connected` and `disconnected`: an app signing in to an OAuth agent, or leaving. */
	action:
		| "created"
		| "updated"
		| "rolled"
		| "revoked"
		| "connected"
		| "disconnected";
	timestamp: string;
	/** `owner` and `local-admin` appear only in history from before team accounts. */
	actor: "owner" | "local-admin" | "user";
	/** Team member's display name when `actor` is `user`. */
	actorName?: string;
	detail: string;
};
export type ApiTokenSettings<Permission extends string = ApiTokenPermission> = {
	tokens: ApiToken<Permission>[];
	actions: ApiTokenAction[];
	persistence: "mongodb" | "memory";
	authenticationRequired: boolean;
};

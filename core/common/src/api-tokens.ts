export const API_TOKEN_TTLS = [1, 7, 30, 180, "never"] as const;
export type ApiTokenTtl = (typeof API_TOKEN_TTLS)[number];

export const API_TOKEN_PERMISSIONS = {
	"models:read": "Models: Read",
	"models:edit": "Models: Edit",
	"routing:read": "Routing: Read",
	"routing:edit": "Routing: Edit",
	"inference:run": "Inference: Run",
	"telemetry:read": "Telemetry: Read",
} as const;
export type ApiTokenPermission = keyof typeof API_TOKEN_PERMISSIONS;
export const DEFAULT_API_TOKEN_PERMISSIONS: readonly ApiTokenPermission[] = [
	"models:read",
	"inference:run",
];

export type ApiToken<Permission extends string = ApiTokenPermission> = {
	id: string;
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
	action: "created" | "updated" | "rolled" | "revoked";
	timestamp: string;
	actor: "owner" | "local-admin";
	detail: string;
};
export type ApiTokenSettings<Permission extends string = ApiTokenPermission> = {
	tokens: ApiToken<Permission>[];
	actions: ApiTokenAction[];
	persistence: "mongodb" | "memory";
	authenticationRequired: boolean;
};

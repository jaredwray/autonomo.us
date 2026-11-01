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

export type ApiToken = {
	id: string;
	name: string;
	description: string;
	permissions: ApiTokenPermission[];
	ttlDays: ApiTokenTtl;
	prefix: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
	status: "active" | "expired" | "revoked";
	previousTokens: Array<{ prefix: string; expiresAt: string }>;
};

export type CreateApiTokenRequest = {
	name: string;
	description: string;
	ttlDays: ApiTokenTtl;
	/** Omitted by older clients: defaults to model discovery and inference. */
	permissions?: ApiTokenPermission[];
};
export type UpdateApiTokenRequest = Pick<
	CreateApiTokenRequest,
	"name" | "description" | "permissions"
>;
export type RollApiTokenRequest = {
	ttlDays: ApiTokenTtl;
	previousTokenTtlSeconds: number;
};
export type ApiTokenSecret = { token: ApiToken; secret: string };
export type ApiTokenAction = {
	id: string;
	tokenId: string;
	tokenName: string;
	action: "created" | "updated" | "rolled" | "revoked";
	timestamp: string;
	actor: "owner" | "local-admin";
	detail: string;
};
export type ApiTokenSettings = {
	tokens: ApiToken[];
	actions: ApiTokenAction[];
	persistence: "mongodb" | "memory";
	authenticationRequired: boolean;
};

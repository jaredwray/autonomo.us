import type {
	ApiToken,
	ApiTokenAction,
	ApiTokenSecret,
	ApiTokenSettings,
	ApiTokenTtl,
	CreateApiTokenRequest,
	RollApiTokenRequest,
	UpdateApiTokenRequest,
} from "./api-tokens.js";

export { API_TOKEN_TTLS as AGENT_TOKEN_TTLS } from "./api-tokens.js";
/** Reserved for the MCP gateway; these grants never authorize REST API access. */
export const AGENT_TOKEN_PERMISSIONS = {
	"mcp:read": "MCP: Read",
	"mcp:call": "MCP: Call",
} as const;
export type AgentTokenPermission = keyof typeof AGENT_TOKEN_PERMISSIONS;
export const DEFAULT_AGENT_TOKEN_PERMISSIONS: readonly AgentTokenPermission[] =
	[];
export type AgentToken = ApiToken<AgentTokenPermission>;
export type AgentTokenTtl = ApiTokenTtl;
export type AgentTokenAction = ApiTokenAction;
export type AgentTokenSecret = ApiTokenSecret<AgentTokenPermission>;
export type AgentTokenSettings = ApiTokenSettings<AgentTokenPermission>;
export type CreateAgentTokenRequest =
	CreateApiTokenRequest<AgentTokenPermission>;
export type UpdateAgentTokenRequest =
	UpdateApiTokenRequest<AgentTokenPermission>;
export type RollAgentTokenRequest = RollApiTokenRequest;

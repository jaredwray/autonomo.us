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
/**
 * Reserved for the MCP gateway; these grants never authorize REST API access.
 * `channels:manage` lets an agent create, rename, and archive channels and
 * change which agents are in them, so it opens every channel in its workspace.
 * `web:fetch` lets an agent read web pages through the gateway, including
 * through the workspace's paid proxies, within the workspace's limits.
 * `models:chat` lets an agent call the workspace's models with
 * `models_chat`, on the workspace's connections, routing, and failover.
 * It is not the API token grant `inference:run`, which agents cannot hold.
 * `video:generate` lets an agent start videos on the workspace's video
 * providers, and read and cancel its own, within the workspace's limits.
 * `synapse:curate` makes an agent a curator of its workspace's shared
 * Synapse: it reads every flag filed there, not only its own, answers them
 * with proposals, and resolves or dismisses them. It still changes the
 * shared notes only through proposals a person approves.
 */
export const AGENT_TOKEN_PERMISSIONS = {
	"mcp:read": "MCP: Read",
	"mcp:call": "MCP: Call",
	"channels:manage": "Channels: Manage",
	"web:fetch": "Web: Fetch",
	"models:chat": "Models: Chat",
	"video:generate": "Video: Generate",
	"loops:read": "Loops: Read",
	"loops:report": "Loops: Report observations",
	"loops:act": "Loops: Perform assigned steps",
	"organization:decide": "Organization: Decide assigned cases",
	"synapse:curate": "Synapse: Curate flags",
} as const;
export const LOOP_AGENT_PERMISSIONS = [
	"loops:read",
	"loops:report",
	"loops:act",
] as const satisfies readonly (keyof typeof AGENT_TOKEN_PERMISSIONS)[];
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

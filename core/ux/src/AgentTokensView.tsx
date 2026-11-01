import {
	AGENT_TOKEN_PERMISSIONS,
	type AgentTokenPermission,
} from "@autonomo.us/common";
import {
	createAgentToken,
	fetchAgentTokens,
	revokeAgentToken,
	rollAgentToken,
	updateAgentToken,
} from "./api.js";
import { TokensView, type TokenViewConfig } from "./TokensView.js";

const config: TokenViewConfig<AgentTokenPermission> = {
	title: "Agent Tokens",
	tokenLabel: "agent",
	description: "Manage credentials for agents connecting through MCP.",
	namePlaceholder: "Research agent",
	emptyMessage:
		"No agent tokens yet. Create a token for an agent’s MCP connection.",
	connectionNote:
		"Prepare credentials for the upcoming MCP connection. The MCP server is not available yet.",
	permissionHint:
		"MCP Read is for discovering tools and reading resources and prompts. MCP Call is for running tools. Select both when an agent needs both. These grants are reserved for the upcoming MCP server and do not grant API access. Managing tokens requires the owner credential.",
	permissions: AGENT_TOKEN_PERMISSIONS,
	permissionGroups: [
		{ resource: "mcp", label: "MCP", choices: ["mcp:read", "mcp:call"] },
	],
	api: {
		list: fetchAgentTokens,
		create: createAgentToken,
		update: updateAgentToken,
		roll: rollAgentToken,
		revoke: revokeAgentToken,
	},
};
export function AgentTokensView() {
	return <TokensView config={config} />;
}

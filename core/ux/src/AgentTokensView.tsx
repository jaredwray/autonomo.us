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
		"Agents connect to the MCP endpoint at /mcp (Streamable HTTP) with an agent token as the bearer credential. It serves the Brain tools: the agent's private vault, the shared vault, and proposals.",
	permissionHint:
		"MCP Read lists the available tools. MCP Call runs them, which is how an agent reads and writes its Brain. Select both for a working agent. Agent tokens grant no REST API access. Only owners and admins can manage agent tokens.",
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

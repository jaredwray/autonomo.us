import { AGENT_TOKEN_PERMISSIONS } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import type { OAuthService } from "../oauth/oauth.js";
import { tokenManagementRoutes } from "./token-management.js";

/**
 * Agents that use MCP: those holding an agent token and those that sign in
 * with OAuth. Workspace admins manage them.
 */
export async function agentTokenRoutes(
	server: FastifyInstance,
	options: {
		tokens: AgentTokenStore;
		oauth: Pick<OAuthService, "disconnectAll">;
	},
) {
	await tokenManagementRoutes(server, {
		tokens: options.tokens,
		path: "/agent-tokens",
		permissions: AGENT_TOKEN_PERMISSIONS,
		// A revoked agent's apps are signed out at once.
		revoked: (workspace, id) => options.oauth.disconnectAll(workspace.id, id),
	});
}

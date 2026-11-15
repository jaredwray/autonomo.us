import { AGENT_TOKEN_PERMISSIONS } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import type { AgentWebhooks } from "../agent-webhooks/webhooks.js";
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
		webhooks?: Pick<AgentWebhooks, "remove">;
	},
) {
	await tokenManagementRoutes(server, {
		tokens: options.tokens,
		path: "/agent-tokens",
		permissions: AGENT_TOKEN_PERMISSIONS,
		// A revoked agent's apps are signed out at once, and its webhook, with
		// the receiver's credentials, is deleted: nothing can wake it now.
		revoked: (workspace, id) =>
			Promise.all([
				options.oauth.disconnectAll(workspace.id, id),
				options.webhooks?.remove(workspace.id, id),
			]),
	});
}

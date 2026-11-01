import { AGENT_TOKEN_PERMISSIONS } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import { tokenManagementRoutes } from "./token-management.js";

export async function agentTokenRoutes(
	server: FastifyInstance,
	options: { tokens: AgentTokenStore; authenticationRequired: boolean },
) {
	await tokenManagementRoutes(server, {
		...options,
		path: "/v1/agent-tokens",
		permissions: AGENT_TOKEN_PERMISSIONS,
	});
}

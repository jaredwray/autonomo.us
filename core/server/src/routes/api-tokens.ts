import { API_TOKEN_PERMISSIONS } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import type { ApiTokenStore } from "../auth/tokens.js";
import { tokenManagementRoutes } from "./token-management.js";

export async function apiTokenRoutes(
	server: FastifyInstance,
	options: { tokens: ApiTokenStore },
) {
	await tokenManagementRoutes(server, {
		...options,
		path: "/api-tokens",
		orgOnly: true,
		permissions: API_TOKEN_PERMISSIONS,
	});
}

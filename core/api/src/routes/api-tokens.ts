import { API_TOKEN_PERMISSIONS } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import type { ApiTokenStore } from "../auth/tokens.js";
import { tokenManagementRoutes } from "./token-management.js";

export async function apiTokenRoutes(
	server: FastifyInstance,
	options: { tokens: ApiTokenStore; authenticationRequired: boolean },
) {
	// Owner verification remains available even if MongoDB is unavailable.
	server.get("/v1/auth/owner", (_request, reply) =>
		reply.header("cache-control", "no-store").code(204).send(),
	);
	await tokenManagementRoutes(server, {
		...options,
		path: "/v1/api-tokens",
		permissions: API_TOKEN_PERMISSIONS,
	});
}

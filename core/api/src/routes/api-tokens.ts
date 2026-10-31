import {
	API_TOKEN_PERMISSIONS,
	API_TOKEN_TTLS,
	type CreateApiTokenRequest,
	type RollApiTokenRequest,
	type UpdateApiTokenRequest,
} from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { ApiTokenError, type ApiTokenStore } from "../auth/tokens.js";

const metadata = {
	name: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
	description: { type: "string", maxLength: 1000 },
};
const ttl = { enum: [...API_TOKEN_TTLS] };
const permissions = {
	type: "array",
	maxItems: Object.keys(API_TOKEN_PERMISSIONS).length,
	uniqueItems: true,
	items: { type: "string", enum: Object.keys(API_TOKEN_PERMISSIONS) },
};
const params = {
	type: "object",
	required: ["id"],
	properties: { id: { type: "string", format: "uuid" } },
};

export async function apiTokenRoutes(
	server: FastifyInstance,
	options: { tokens: ApiTokenStore; authenticationRequired: boolean },
) {
	const actor = options.authenticationRequired ? "owner" : "local-admin";
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	// Fastify can coerce a scalar to an array during schema validation. Grants
	// must be an explicit array; reject malformed input before that coercion.
	server.addHook("preValidation", async (request) => {
		if (
			request.body &&
			typeof request.body === "object" &&
			"permissions" in request.body &&
			!Array.isArray(request.body.permissions)
		) {
			throw new ApiTokenError(
				"Permissions must be an array of permission IDs.",
			);
		}
	});
	server.get("/v1/api-tokens", () =>
		options.tokens.settings(options.authenticationRequired),
	);
	// The owner check must work even when the token store is unavailable.
	// Managed tokens have no grant for this route.
	server.get("/v1/auth/owner", (_request, reply) => reply.code(204).send());
	server.post<{ Body: CreateApiTokenRequest }>(
		"/v1/api-tokens",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name", "description", "ttlDays"],
					properties: { ...metadata, ttlDays: ttl, permissions },
				},
			},
		},
		async (request, reply) => {
			const result = await options.tokens.create(request.body, actor);
			return reply.code(201).send(result);
		},
	);
	server.patch<{
		Params: { id: string };
		Body: UpdateApiTokenRequest;
	}>(
		"/v1/api-tokens/:id",
		{
			schema: {
				params,
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name", "description"],
					properties: { ...metadata, permissions },
				},
			},
		},
		(request) => options.tokens.update(request.params.id, request.body, actor),
	);
	server.post<{ Params: { id: string }; Body: RollApiTokenRequest }>(
		"/v1/api-tokens/:id/roll",
		{
			schema: {
				params,
				body: {
					type: "object",
					additionalProperties: false,
					required: ["ttlDays", "previousTokenTtlSeconds"],
					properties: {
						ttlDays: ttl,
						previousTokenTtlSeconds: {
							type: "integer",
							minimum: 0,
							maximum: 30 * 24 * 60 * 60,
						},
					},
				},
			},
		},
		(request) => options.tokens.roll(request.params.id, request.body, actor),
	);
	server.delete<{ Params: { id: string } }>(
		"/v1/api-tokens/:id",
		{ schema: { params } },
		(request) => options.tokens.revoke(request.params.id, actor),
	);
}

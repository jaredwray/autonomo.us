import {
	API_TOKEN_TTLS,
	type CreateApiTokenRequest,
	type RollApiTokenRequest,
} from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import type { ApiTokenStore } from "../auth/tokens.js";

const metadata = {
	name: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
	description: { type: "string", maxLength: 1000 },
};
const ttl = { enum: [...API_TOKEN_TTLS] };
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
	server.get("/v1/api-tokens", () =>
		options.tokens.settings(options.authenticationRequired),
	);
	server.post<{ Body: CreateApiTokenRequest }>(
		"/v1/api-tokens",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name", "description", "ttlDays"],
					properties: { ...metadata, ttlDays: ttl },
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
		Body: Pick<CreateApiTokenRequest, "name" | "description">;
	}>(
		"/v1/api-tokens/:id",
		{
			schema: {
				params,
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name", "description"],
					properties: metadata,
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

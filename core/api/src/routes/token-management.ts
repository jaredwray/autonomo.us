import {
	API_TOKEN_TTLS,
	type CreateApiTokenRequest,
	type RollApiTokenRequest,
	type UpdateApiTokenRequest,
} from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { ApiTokenError, type TokenStore } from "../auth/token-store.js";

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

export async function tokenManagementRoutes<Permission extends string>(
	server: FastifyInstance,
	options: {
		tokens: TokenStore<Permission>;
		authenticationRequired: boolean;
		path: string;
		permissions: Record<Permission, string>;
	},
) {
	const permissions = {
		type: "array",
		maxItems: Object.keys(options.permissions).length,
		uniqueItems: true,
		items: { type: "string", enum: Object.keys(options.permissions) },
	};
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
	server.get(options.path, () =>
		options.tokens.settings(options.authenticationRequired),
	);
	server.post<{ Body: CreateApiTokenRequest<Permission> }>(
		options.path,
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
		Body: UpdateApiTokenRequest<Permission>;
	}>(
		`${options.path}/:id`,
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
		`${options.path}/:id/roll`,
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
		`${options.path}/:id`,
		{ schema: { params } },
		(request) => options.tokens.revoke(request.params.id, actor),
	);
}

import { type AddModelRequest, PROVIDER_NAMES } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { requestWorkspace } from "../auth/access.js";
import type { ModelCatalogService } from "../model-catalog-service.js";
import {
	ProviderSettingsError,
	type ProviderSettingsStore,
} from "../providers/settings.js";

/**
 * The full multi-provider catalog (bundled models.json until the service's
 * first successful refresh), as opposed to /v1/:workspace/models which lists
 * only that workspace's routable models. Served from cache, never fetched on
 * the request path. Public metadata, so it is instance-level.
 */
export async function catalogRoutes(
	server: FastifyInstance,
	options: { catalog: ModelCatalogService },
) {
	server.get("/v1/models/catalog", async () => options.catalog.getCatalog());
}

export type ModelsRouteOptions = { providers: ProviderSettingsStore };

/** Registered under `/v1/:workspace`. */
export async function modelsRoutes(
	server: FastifyInstance,
	options: ModelsRouteOptions,
) {
	server.get("/models", async (request) => {
		const registry = await options.providers.registry(
			requestWorkspace(request),
		);
		return {
			models: registry.listModels(),
			providers: registry.listProviders(),
		};
	});

	server.get("/providers", async (request, reply) => {
		reply.header("cache-control", "no-store");
		try {
			return await options.providers.settings(requestWorkspace(request));
		} catch (error) {
			if (error instanceof ProviderSettingsError)
				return reply
					.status(error.statusCode)
					.send({ error: { message: error.message } });
			throw error;
		}
	});

	server.post<{ Body: AddModelRequest }>(
		"/models",
		{
			schema: {
				body: {
					type: "object",
					required: ["provider", "model"],
					additionalProperties: false,
					properties: {
						provider: { enum: Object.keys(PROVIDER_NAMES) },
						connectionId: {
							type: "string",
							pattern: "^[a-z][a-z0-9_-]{0,63}$",
						},
						createConnection: { type: "boolean" },
						model: {
							type: "string",
							minLength: 1,
							maxLength: 200,
							pattern: "^[@a-zA-Z0-9][@a-zA-Z0-9._:/-]*$",
						},
						apiKey: { type: "string", maxLength: 4096 },
						accountId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" },
					},
				},
			},
		},
		async (request, reply) => {
			reply.header("cache-control", "no-store");
			try {
				return await options.providers.add(
					requestWorkspace(request),
					request.body,
				);
			} catch (error) {
				if (error instanceof ProviderSettingsError)
					return reply
						.status(error.statusCode)
						.send({ error: { message: error.message } });
				throw error;
			}
		},
	);
}

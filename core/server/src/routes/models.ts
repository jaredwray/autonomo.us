import { type AddModelRequest, PROVIDER_NAMES } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import type { ModelCatalogService } from "../model-catalog-service.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
	ProviderSettingsError,
	type ProviderSettingsStore,
} from "../providers/settings.js";

export type ModelsRouteOptions = {
	registry: ProviderRegistry;
	catalog: ModelCatalogService;
	settings: ProviderSettingsStore;
};

export async function modelsRoutes(
	server: FastifyInstance,
	options: ModelsRouteOptions,
) {
	server.get("/v1/models", async () => {
		return {
			models: options.registry.listModels(),
			providers: options.registry.listProviders(),
		};
	});

	// The full multi-provider catalog (bundled models.json until the service's
	// first successful refresh), as opposed to /v1/models which lists only
	// routable models. Served from cache — never fetches on the request path.
	server.get("/v1/models/catalog", async () => options.catalog.getCatalog());

	server.get("/v1/providers", async (_request, reply) => {
		reply.header("cache-control", "no-store");
		try {
			return await options.settings.settings();
		} catch (error) {
			if (error instanceof ProviderSettingsError)
				return reply
					.status(error.statusCode)
					.send({ error: { message: error.message } });
			throw error;
		}
	});

	server.post<{ Body: AddModelRequest }>(
		"/v1/models",
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
				return await options.settings.add(request.body);
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

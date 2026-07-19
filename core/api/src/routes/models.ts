import type { FastifyInstance } from "fastify";
import { type ModelCatalog, modelCatalog } from "../model-catalog.js";
import type { ProviderRegistry } from "../providers/registry.js";

export type ModelsRouteOptions = {
	registry: ProviderRegistry;
	/** Overrides the bundled `models.json` catalog (used by tests). */
	catalog?: ModelCatalog;
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

	// The full multi-provider catalog (refreshed daily by the update-models
	// workflow), as opposed to /v1/models which lists only routable models.
	server.get("/v1/models/catalog", async () => options.catalog ?? modelCatalog);
}

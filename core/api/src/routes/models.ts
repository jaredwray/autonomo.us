import type { FastifyInstance } from "fastify";
import type { ModelCatalogService } from "../model-catalog-service.js";
import type { ProviderRegistry } from "../providers/registry.js";

export type ModelsRouteOptions = {
	registry: ProviderRegistry;
	catalog: ModelCatalogService;
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
}

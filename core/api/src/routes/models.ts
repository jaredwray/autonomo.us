import type { FastifyInstance } from "fastify";
import type { ProviderRegistry } from "../providers/registry.js";

export type ModelsRouteOptions = {
	registry: ProviderRegistry;
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
}

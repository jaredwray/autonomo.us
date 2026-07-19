import { ModelCatalogService } from "./model-catalog-service.js";
import { createServer } from "./server.js";

const modelCatalog = new ModelCatalogService();
const server = createServer({ modelCatalog });

const start = async () => {
	const port = Number(process.env.PORT) || 3000;
	const host = process.env.HOST || "0.0.0.0";

	await server.listen({ port, host });

	// Query the model sources now and re-check daily; a failed refresh keeps
	// the current catalog (the bundled models.json until the first success).
	modelCatalog.start();
};

start().catch((error) => {
	server.log.error(error);
	process.exit(1);
});

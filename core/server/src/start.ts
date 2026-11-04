import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelCatalogService } from "./model-catalog-service.js";
import { createServer } from "./server.js";

/**
 * The dashboard build served by this process, so one container runs the whole
 * product. `DASHBOARD_DIR` overrides the default, which is the workspace's
 * `core/ux/dist` relative to this file (the same layout the Docker image keeps).
 */
export function dashboardDirectory(): string | undefined {
	const directory =
		process.env.DASHBOARD_DIR ||
		fileURLToPath(new URL("../../ux/dist", import.meta.url));
	return existsSync(join(directory, "index.html")) ? directory : undefined;
}

const modelCatalog = new ModelCatalogService();
const dashboardDir = dashboardDirectory();
const server = createServer({ modelCatalog, dashboardDir });

const start = async () => {
	const port = Number(process.env.PORT) || 3000;
	const host = process.env.HOST || "0.0.0.0";

	await server.listen({ port, host });
	if (dashboardDir) server.log.info({ dashboardDir }, "serving the dashboard");
	else
		server.log.warn(
			"Dashboard build not found; serving the API only. Run `pnpm --filter @autonomo.us/ux build` or set DASHBOARD_DIR.",
		);

	// Query the model sources now and re-check daily; a failed refresh keeps
	// the current catalog (the bundled models.json until the first success).
	modelCatalog.start();
};

start().catch((error) => {
	server.log.error(error);
	process.exit(1);
});

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContainerControl } from "./container-control.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import {
	createServer,
	initializePersistence,
	sweepBackgroundWork,
} from "./server.js";

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
const containerMode = process.env.CONTAINER_MODE === "true";
if (
	containerMode &&
	(!process.env.MONGODB_URI ||
		!process.env.PUBLIC_URL ||
		(process.env.CONTAINER_CONTROL_TOKEN?.length ?? 0) < 32)
) {
	throw new Error(
		"Container requires durable storage, public origin and a control token",
	);
}
const server = createServer({
	modelCatalog,
	dashboardDir,
	assumeHttps: containerMode,
	backgroundTimers: !containerMode,
});
let closing = false;
const control = containerMode
	? createContainerControl({
			token: process.env.CONTAINER_CONTROL_TOKEN ?? "",
			ready: async () => !closing && (await initializePersistence(server)),
			sweep: () => sweepBackgroundWork(server, 1),
		})
	: undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.once(signal, () => {
		if (closing) return;
		closing = true;
		const deadline = setTimeout(() => process.exit(1), 15_000);
		deadline.unref();
		const controlClosed = control
			? new Promise<void>((resolve) => control.close(() => resolve()))
			: Promise.resolve();
		void Promise.all([server.close(), controlClosed]).then(
			() => process.exit(0),
			() => process.exit(1),
		);
	});

const start = async () => {
	const port = Number(process.env.PORT) || 3000;
	const host = process.env.HOST || "0.0.0.0";

	await server.listen({ port, host });
	if (control)
		await new Promise<void>((resolve, reject) => {
			control.once("error", reject);
			control.listen(3001, "0.0.0.0", resolve);
		});
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
	server.log.error({ name: error?.name }, "Gateway startup failed");
	process.exit(1);
});

import { fileURLToPath } from "node:url";
import { createServer, sweepBackgroundWork } from "../src/server.js";
import { seedRustboy } from "./fixtures/rustboy.js";
import { ShotConsumer } from "./fixtures/shot-consumer.js";

let nowOffset = 0;
const server = createServer({
	organizationNow: () => Date.now() + nowOffset,
	config: { providers: [], corsOrigins: [] },
	logger: false,
	dashboardDir: fileURLToPath(new URL("../../ux/dist/", import.meta.url)),
});
const studio = await seedRustboy(server);
const shots = new ShotConsumer(":memory:");
try {
	for (const check of ["lighting-reference", "wardrobe-reference"]) {
		if (shots.check(check)) await studio.open();
	}
	const record = await studio.open();
	if (process.argv.includes("--expired")) {
		nowOffset = 31 * 60_000;
		await sweepBackgroundWork(server);
	}
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	console.info(
		`Rustboy development workspace\nReporting map: ${url}/#/w/${studio.workspaceId}/organization/positions/${studio.splice.id}\nDecision: ${url}/#/w/${studio.workspaceId}/decision-inbox/cases/${record.id}\nSign in as ${studio.email} with this temporary password: ${studio.password}\nCtrl+C closes the demo.`,
	);
} finally {
	shots.close();
}

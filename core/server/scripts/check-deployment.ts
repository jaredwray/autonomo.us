import { setTimeout as delay } from "node:timers/promises";

const url = new URL("/healthz", process.argv[2] ?? "https://dev.autonomo.us");
let failure = "No response";
for (let attempt = 0; attempt < 12; attempt++) {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(15_000),
			cache: "no-store",
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const health = (await response.json()) as {
			status?: string;
			mongodb?: {
				configured?: boolean;
				connected?: boolean;
				initialized?: boolean;
			};
		};
		if (health.status !== "ok") throw new Error("Invalid health response");
		if (!health.mongodb?.configured)
			throw new Error("MONGODB_URI is missing from the API Worker secrets");
		if (!health.mongodb.connected)
			throw new Error(
				"MongoDB is unreachable; check Worker logs, credentials, and network access",
			);
		if (!health.mongodb.initialized)
			throw new Error(
				"MongoDB configuration did not initialize; check Worker logs and database write permissions",
			);
		console.log("API health and MongoDB initialization verified.");
		process.exit(0);
	} catch (error) {
		failure = error instanceof Error ? error.message : "Health check failed";
		console.warn(`Deployment check ${attempt + 1}/12: ${failure}`);
	}
	if (attempt < 11) await delay(5000);
}
throw new Error(`Deployment is not healthy: ${failure}`);

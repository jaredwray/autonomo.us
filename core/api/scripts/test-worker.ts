import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

// Run the production entry in workerd. Node tests and Wrangler dry-runs do not
// enforce Workers' restrictions on code generation or request-owned sockets.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const config = JSON.parse(
	(await readFile(join(root, "core/api/wrangler.jsonc"), "utf8")).replace(
		/^\s*\/\/.*$/gm,
		"",
	),
);

async function unusedPort() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address === "object");
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

async function withWorker(
	mongodbUrl: string,
	test: (request: RequestWorker, logs: () => string) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "autonomous-worker-"));
	const port = await unusedPort();
	const inspectorPort = await unusedPort();
	// A temporary config isolates tests from developers' .dev.vars and .env.
	await writeFile(
		join(directory, "wrangler.json"),
		JSON.stringify({
			...config,
			main: join(root, "core/api/src/worker.ts"),
			routes: [],
			vars: {
				...config.vars,
				MONGODB_URI: mongodbUrl,
				OWNER_TOKEN: "",
			},
		}),
	);
	const child = spawn(
		process.execPath,
		[
			join(root, "node_modules/wrangler/bin/wrangler.js"),
			"dev",
			"--local",
			"--port",
			String(port),
			"--inspector-port",
			String(inspectorPort),
			"--ip",
			"127.0.0.1",
			"--config",
			join(directory, "wrangler.json"),
		],
		{
			cwd: directory,
			env: {
				...process.env,
				WRANGLER_SEND_METRICS: "false",
				CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
			},
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		},
	);
	let output = "";
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (data) => {
			output = (output + data).slice(-100_000);
		});
	const exited = once(child, "exit");
	const request: RequestWorker = async (path, expected = 200, init) => {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			...init,
			signal: AbortSignal.timeout(20_000),
		});
		assert.equal(response.status, expected, `${path}: HTTP ${response.status}`);
		return response.json();
	};
	try {
		const deadline = Date.now() + 45_000;
		while (!output.includes("Ready on")) {
			assert(
				child.exitCode === null && child.signalCode === null,
				"Worker exited before startup",
			);
			assert(Date.now() < deadline, "Worker startup timed out");
			await delay(100);
		}
		await test(request, () => output);
	} catch (error) {
		// Never print Wrangler's binding dump (it can include the MongoDB URI).
		console.error(
			"Worker smoke test failed:",
			error instanceof Error ? error.message : "unknown error",
		);
		throw error;
	} finally {
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			if (process.platform === "win32") child.kill();
			else process.kill(-child.pid, "SIGTERM");
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	}
}

type Health = {
	status: string;
	mongodb: { configured: boolean; connected: boolean; initialized: boolean };
};
type RequestWorker = (
	path: string,
	expected?: number,
	init?: RequestInit,
) => Promise<unknown>;

async function expectLog(logs: () => string, event: string) {
	const deadline = Date.now() + 5000;
	while (!logs().includes(event)) {
		assert(Date.now() < deadline, `Missing Worker log: ${event}`);
		await delay(50);
	}
}

await withWorker("", async (request, logs) => {
	for (const path of ["/health", "/healthz"]) {
		const health = (await request(path)) as Health;
		assert.equal(health.status, "ok");
		assert.deepEqual(health.mongodb, {
			configured: false,
			connected: false,
			initialized: false,
		});
	}
	await request("/v1/models");
	await request("/v1/routing", 400, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	await expectLog(logs, "gateway.request");
	await expectLog(logs, "gateway.mongodb_unconfigured");
});
console.log(
	"Worker: cold start, health aliases, schema validation, and logs passed",
);

const url = new URL(
	process.env.MONGODB_TEST_URL ??
		"mongodb://autonomous:autonomous@127.0.0.1:27017/autonomous?authSource=admin",
);
url.pathname = `/autonomous_worker_${randomUUID().replaceAll("-", "")}`;
const client = new MongoClient(url.toString(), {
	serverSelectionTimeoutMS: 1500,
});
try {
	await client.connect(); // Required: this regression check must not silently skip MongoDB.
	assert.deepEqual(await client.db().listCollections().toArray(), []);
	await withWorker(url.toString(), async (request, logs) => {
		// Concurrent cold requests must also complete the same initialization.
		await Promise.all(
			Array.from({ length: 4 }, async () => {
				const health = (await request("/healthz")) as Health;
				assert.deepEqual(health.mongodb, {
					configured: true,
					connected: true,
					initialized: true,
				});
			}),
		);
		assert(
			await client
				.db()
				.collection<{ _id: string }>("gateway_routing")
				.findOne({ _id: "default" }),
		);
		await Promise.all(
			Array.from({ length: 6 }, () => request("/v1/api-tokens")),
		);
		const created = (await request("/v1/api-tokens", 201, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Worker smoke",
				description: "",
				ttlDays: "never",
			}),
		})) as { token: { id: string }; secret: string };
		await request(`/v1/api-tokens/${created.token.id}`, 200, {
			method: "DELETE",
		});
		assert.equal(
			await client.db().collection("gateway_routing").countDocuments(),
			1,
		);
		await expectLog(logs, "gateway.persistence_ready");
		assert(!logs().includes(created.secret));
	});
	console.log(
		"Worker: fresh database, concurrent requests, durable writes, and parameter routes passed",
	);

	await client.db().dropDatabase();
	await client.db().createCollection("gateway_routing", {
		validator: { rejectTestWrites: { $exists: true } },
	});
	await withWorker(url.toString(), async (request, logs) => {
		const health = (await request("/healthz")) as Health;
		assert.deepEqual(health.mongodb, {
			configured: true,
			connected: true,
			initialized: false,
		});
		await request("/v1/routing", 503);
		await expectLog(logs, "gateway.persistence_failed");
		await expectLog(logs, "code: 121");
		await client.db().command({ collMod: "gateway_routing", validator: {} });
		assert.equal(
			((await request("/healthz")) as Health).mongodb.initialized,
			true,
		);
	});
	console.log(
		"Worker: initialization failures are logged and recover on retry",
	);
} finally {
	try {
		await client.db().dropDatabase();
	} finally {
		await client.close();
	}
}

await withWorker(
	`mongodb://127.0.0.1:${await unusedPort()}/unreachable`,
	async (request, logs) => {
		const health = (await request("/healthz")) as Health;
		assert.deepEqual(health.mongodb, {
			configured: true,
			connected: false,
			initialized: false,
		});
		await expectLog(logs, "gateway.persistence_failed");
	},
);
console.log("Worker: health remains available during a MongoDB outage");

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	(await readFile(join(root, "core/server/wrangler.jsonc"), "utf8")).replace(
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
	test: (
		request: RequestWorker,
		logs: () => string,
		base: string,
	) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "autonomous-worker-"));
	const port = await unusedPort();
	const inspectorPort = await unusedPort();
	// A stub stands in for the dashboard build so this test needs no Vite
	// build and still proves that run_worker_first sends the API paths to the
	// Worker while everything else is a static asset.
	const assets = join(directory, "assets");
	await mkdir(assets);
	await writeFile(
		join(assets, "index.html"),
		"<!doctype html><title>dashboard stub</title>",
	);
	// A temporary config isolates tests from developers' .dev.vars and .env.
	await writeFile(
		join(directory, "wrangler.json"),
		JSON.stringify({
			...config,
			main: join(root, "core/server/src/worker.ts"),
			assets: { ...config.assets, directory: assets },
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
		await test(request, () => output, `http://127.0.0.1:${port}`);
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

const json = { "content-type": "application/json" };
const password = "worker smoke passphrase";

/** First-run setup through the Worker; returns the owner's auth header. */
async function setUp(request: RequestWorker, headers: HeadersInit = {}) {
	const owner = (await request("/v1/setup", 201, {
		method: "POST",
		headers: { ...json, ...headers },
		body: JSON.stringify({
			email: "owner@example.com",
			name: "Owner",
			password,
		}),
	})) as { token: string };
	return { authorization: `Bearer ${owner.token}` };
}

async function expectLog(logs: () => string, event: string) {
	const deadline = Date.now() + 5000;
	while (!logs().includes(event)) {
		assert(Date.now() < deadline, `Missing Worker log: ${event}`);
		await delay(50);
	}
}

await withWorker("", async (request, logs, base) => {
	// The dashboard: static assets answer the root and client-side routes.
	for (const path of ["/", "/models"]) {
		const page = await fetch(`${base}${path}`, {
			signal: AbortSignal.timeout(20_000),
		});
		assert.equal(page.status, 200, `${path}: HTTP ${page.status}`);
		assert.match(page.headers.get("content-type") ?? "", /text\/html/);
		assert.match(await page.text(), /dashboard stub/);
	}
	for (const path of ["/health", "/healthz"]) {
		const health = (await request(path)) as Health;
		assert.equal(health.status, "ok");
		assert.deepEqual(health.mongodb, {
			configured: false,
			connected: false,
			initialized: false,
		});
	}
	// No unauthenticated mode, even before setup.
	await request("/v1/models", 401);
	// The bare namespace reaches the API (a JSON 404), not the dashboard.
	await request("/v1", 404);
	// /mcp is a Worker path too: agent-token auth answers, not the asset stub.
	await request("/mcp", 401, { method: "POST", headers: json, body: "{}" });
	await request("/mcp", 405);
	const auth = await setUp(request);
	await request("/v1/models", 200, { headers: auth });
	await request("/v1/routing", 400, {
		method: "PUT",
		headers: { ...json, ...auth },
		body: "{}",
	});
	await expectLog(logs, "gateway.request");
	await expectLog(logs, "gateway.mongodb_unconfigured");
});
console.log(
	"Worker: cold start, dashboard assets, health aliases, schema validation, and logs passed",
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
		// First-run setup, scrypt passwords, sessions, and invite links in workerd.
		await request("/v1/api-tokens", 401);
		const ownerAuth = await setUp(request);
		await Promise.all(
			Array.from({ length: 6 }, () =>
				request("/v1/api-tokens", 200, { headers: ownerAuth }),
			),
		);
		const created = (await request("/v1/api-tokens", 201, {
			method: "POST",
			headers: { ...json, ...ownerAuth },
			body: JSON.stringify({
				name: "Worker smoke",
				description: "",
				ttlDays: "never",
			}),
		})) as { token: { id: string }; secret: string };
		await request(`/v1/api-tokens/${created.token.id}`, 200, {
			method: "DELETE",
			headers: ownerAuth,
		});
		assert.equal(
			await client.db().collection("gateway_routing").countDocuments(),
			1,
		);
		await expectLog(logs, "gateway.persistence_ready");
		assert(!logs().includes(created.secret));

		await request("/v1/models", 401);
		const signedIn = (await request("/v1/auth/session", 201, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ email: "owner@example.com", password }),
		})) as { token: string };
		const auth = { authorization: `Bearer ${signedIn.token}` };
		await request("/v1/models", 200, { headers: auth });
		const invite = (await request("/v1/team/invites", 201, {
			method: "POST",
			headers: { ...json, ...auth },
			body: JSON.stringify({ role: "member", ttlDays: 1 }),
		})) as { token: string };
		await request("/v1/invites/accept", 201, {
			method: "POST",
			headers: json,
			body: JSON.stringify({
				token: invite.token,
				email: "member@example.com",
				name: "",
				password,
			}),
		});
		const team = (await request("/v1/team", 200, { headers: auth })) as {
			members: unknown[];
		};
		assert.equal(team.members.length, 2);
		for (const secret of [
			ownerAuth.authorization.slice(7),
			signedIn.token,
			invite.token,
			password,
		])
			assert(!logs().includes(secret));
	});
	console.log(
		"Worker: fresh database, concurrent requests, durable writes, parameter routes, and team sign-in passed",
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
		await request("/v1/routing", 503, { headers: await setUp(request) });
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

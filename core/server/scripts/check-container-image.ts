// Run inside the built CI image. All credentials and database contents are synthetic.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(
	process.versions.node,
	"26.13.1",
	"Unexpected container Node runtime",
);

const headers = {
	authorization: `Bearer ${process.env.CONTAINER_CONTROL_TOKEN}`,
};
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
	try {
		const response = await fetch(
			"http://127.0.0.1:3000/_internal/maintenance/ready",
			{
				headers,
				signal: AbortSignal.timeout(3000),
			},
		);
		if (response.status === 204) {
			ready = true;
			break;
		}
	} catch {
		/* Wait for startup and the disposable MongoDB. */
	}
	await delay(1000);
}
assert(ready, "Container did not become ready");
await assert.rejects(
	fetch("http://127.0.0.1:3001/ready", { signal: AbortSignal.timeout(1000) }),
);
assert.equal(
	(
		await fetch("http://127.0.0.1:3000/_internal/maintenance/sweep", {
			method: "POST",
		})
	).status,
	404,
);
assert.equal(
	(
		await fetch("http://127.0.0.1:3000/_internal/maintenance/sweep", {
			method: "POST",
			headers,
		})
	).status,
	204,
);
assert.equal(
	(
		await fetch("http://127.0.0.1:3000/_internal/maintenance/drain", {
			method: "POST",
			headers: { ...headers, "x-autonomo-public-ingress": "0" },
		})
	).status,
	404,
);
await Promise.all(
	["sweep", "sweep", "drain", "drain"].map(async (operation) => {
		assert.equal(
			(
				await fetch(
					`http://127.0.0.1:3000/_internal/maintenance/${operation}`,
					{ method: "POST", headers },
				)
			).status,
			204,
		);
	}),
);
const health = await (await fetch("http://127.0.0.1:3000/healthz")).json();
assert.equal(health.mongodb.initialized, true);
assert.equal(health.mongodb.connected, true);
assert.deepEqual(health.synapse, { configured: true, ready: true });
const oauth = await (
	await fetch("http://127.0.0.1:3000/.well-known/oauth-authorization-server")
).json();
assert.equal(oauth.issuer, "https://gateway.example.invalid");
assert.equal(
	(
		await fetch("http://127.0.0.1:3000/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		})
	).status,
	401,
);
console.log(
	"Built image: single listener, Mongo and Synapse readiness, protected/parallel maintenance, OAuth HTTPS origin and MCP auth verified.",
);

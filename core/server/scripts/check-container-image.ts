// Run inside the built CI image. All credentials and database contents are synthetic.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const headers = {
	authorization: `Bearer ${process.env.CONTAINER_CONTROL_TOKEN}`,
};
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
	try {
		const response = await fetch("http://127.0.0.1:3001/ready", {
			headers,
			signal: AbortSignal.timeout(3000),
		});
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
assert.equal(
	(await fetch("http://127.0.0.1:3001/sweep", { method: "POST" })).status,
	404,
);
assert.equal(
	(await fetch("http://127.0.0.1:3001/sweep", { method: "POST", headers }))
		.status,
	204,
);
const health = await (await fetch("http://127.0.0.1:3000/healthz")).json();
assert.equal(health.mongodb.initialized, true);
assert.equal(health.mongodb.connected, true);
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
	"Built image: Mongo readiness, protected sweep, OAuth HTTPS origin and MCP auth verified.",
);

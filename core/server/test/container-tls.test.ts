import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("the actual Node runtime pins its TCP destination and verifies the original TLS hostname", async () => {
	const certPath = fileURLToPath(
		new URL("./fixtures/mcp-events/cert.pem", import.meta.url),
	);
	const server = createServer(
		{
			cert: readFileSync(certPath),
			key: readFileSync(
				new URL("./fixtures/mcp-events/key.pem", import.meta.url),
			),
		},
		(request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ hostname: request.headers.host }));
		},
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("missing port");
		// Only this synthetic transport test supplies loopback directly. Callback's
		// public-address validation is tested separately and remains unchanged.
		const code = `
   import { nodeWebhookTransport } from ${JSON.stringify(new URL("../src/agent-webhooks/delivery.ts", import.meta.url).href)};
   const send = nodeWebhookTransport();
   const base = { address: { address: "127.0.0.1", family: 4 }, headers: {}, body: "{}", responseLimit: 4096, signal: AbortSignal.timeout(5000) };
   const success = await send({ ...base, url: new URL("https://receiver.example.com:${address.port}/") });
   let invalidHostnameRejected = false;
   try { await send({ ...base, url: new URL("https://wrong-host.example.com:${address.port}/") }); }
   catch { invalidHostnameRejected = true; }
   console.log(JSON.stringify({ status: success.status, body: success.body, invalidHostnameRejected }));
  `;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--import",
				fileURLToPath(
					new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
				),
				"--input-type=module",
				"-e",
				code,
			],
			{
				env: { NODE_EXTRA_CA_CERTS: certPath },
				timeout: 15_000,
			},
		);
		const result = JSON.parse(stdout.trim());
		expect(result.status).toBe(200);
		expect(JSON.parse(result.body).hostname).toBe(
			`receiver.example.com:${address.port}`,
		);
		expect(result.invalidHostnameRejected).toBe(true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}, 20_000);

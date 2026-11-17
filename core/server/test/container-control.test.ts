import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createContainerControl } from "../src/container-control.js";

const servers: ReturnType<typeof createContainerControl>[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});
it("protects readiness and sweeps and coalesces concurrent ticks without exposing errors", async () => {
	let finish!: () => void;
	const sweep = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const ready = vi.fn(async () => true);
	const token = "synthetic-control-".repeat(4);
	const server = createContainerControl({ token, ready, sweep });
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing port");
	const base = `http://127.0.0.1:${address.port}`;
	expect((await fetch(`${base}/sweep`, { method: "POST" })).status).toBe(404);
	expect(sweep).not.toHaveBeenCalled();
	const headers = { authorization: `Bearer ${token}` };
	expect((await fetch(`${base}/ready`, { headers })).status).toBe(204);
	const a = fetch(`${base}/sweep`, { method: "POST", headers });
	const b = fetch(`${base}/sweep`, { method: "POST", headers });
	await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
	expect(ready).toHaveBeenCalledTimes(1);
	expect(sweep).toHaveBeenCalledTimes(1);
	finish();
	expect((await a).status).toBe(204);
	expect((await b).status).toBe(204);
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
	ready.mockResolvedValue(false);
	expect(
		(await fetch(`${base}/sweep`, { method: "POST", headers })).status,
	).toBe(503);
	ready.mockRejectedValue(new Error("synthetic-secret"));
	const failed = await fetch(`${base}/ready`, { headers });
	expect(failed.status).toBe(503);
	expect(await failed.text()).not.toContain("secret");
});

it("retains successful slow initialization across an aborted readiness probe", async () => {
	const token = "synthetic-slow-readiness-".repeat(3);
	let complete!: (value: boolean) => void;
	const ready = vi.fn(
		() =>
			new Promise<boolean>((resolve) => {
				complete = resolve;
			}),
	);
	const server = createContainerControl({
		token,
		ready,
		sweep: async () => {},
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing port");
	const url = `http://127.0.0.1:${address.port}/ready`;
	const headers = { authorization: `Bearer ${token}` };
	const controller = new AbortController();
	const first = fetch(url, { headers, signal: controller.signal }).catch(
		() => null,
	);
	await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
	controller.abort();
	await first;
	const next = fetch(url, { headers });
	complete(true);
	expect((await next).status).toBe(204);
	expect((await fetch(url, { headers })).status).toBe(204);
	expect(ready).toHaveBeenCalledTimes(1);
});

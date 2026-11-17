import {
	createServer as createHttpServer,
	request as httpRequest,
} from "node:http";
import type { BotDetails } from "@autonomo.us/common";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerMaintenanceRoutes } from "../src/maintenance-control.js";
import {
	PUBLIC_INGRESS_HEADER,
	MAINTENANCE_PATHS as paths,
} from "../src/maintenance-protocol.js";
import { createServer } from "../src/server.js";
import { startChannels } from "./channel-helpers.js";

const token = "synthetic-control-".repeat(4);
const headers = { authorization: `Bearer ${token}` };
const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.splice(0).map((server) => server.close()));
});
function fixture(
	overrides: Partial<Parameters<typeof registerMaintenanceRoutes>[1]> = {},
) {
	const ready = vi.fn(async () => true);
	const sweep = vi.fn(async () => {});
	const drain = vi.fn(async () => {});
	const server = Fastify();
	const options = { token, ready, sweep, drain, ...overrides };
	const control = registerMaintenanceRoutes(server, options);
	server.register(cors);
	server.addHook("onClose", () => control.close());
	servers.push(server);
	return { server, ...options };
}
it("authenticates before CORS/body parsing and rejects public markers even with the right secret", async () => {
	const f = fixture();
	for (const operation of ["ready", "sweep", "drain"] as const) {
		for (const badHeaders of [
			{},
			{ authorization: "Bearer wrong" },
			{ authorization: `Bearer ${token}x` },
			{ ...headers, [PUBLIC_INGRESS_HEADER]: "0" },
			{ ...headers, [PUBLIC_INGRESS_HEADER]: "" },
		]) {
			const result = await f.server.inject({
				method: operation === "ready" ? "GET" : "POST",
				url: paths[operation],
				headers: badHeaders,
			});
			expect(result.statusCode).toBe(404);
			expect(result.headers["cache-control"]).toBe("no-store");
		}
	}
	expect(
		(
			await f.server.inject({
				method: "OPTIONS",
				url: paths.sweep,
				headers: {
					origin: "https://public.invalid",
					"access-control-request-method": "POST",
				},
			})
		).statusCode,
	).toBe(404);
	expect(
		(
			await f.server.inject({
				method: "POST",
				url: paths.sweep,
				headers: { "content-type": "application/json" },
				payload: "{invalid",
			})
		).statusCode,
	).toBe(404);
	expect(f.ready).not.toHaveBeenCalled();
	expect(f.sweep).not.toHaveBeenCalled();
	expect(f.drain).not.toHaveBeenCalled();
});
it("accepts only exact maintenance URLs and verbs, including for authenticated callers", async () => {
	const f = fixture();
	const base = await f.server.listen({ port: 0, host: "127.0.0.1" });
	for (const url of [
		"/%5finternal/maintenance/sweep",
		"/_internal/%6daintenance/sweep",
		"/_internal/maintenance/%73weep",
		"/_internal/maintenance/sweep/",
		"/_internal/maintenance/sweep?x=1",
		"/_internal//maintenance/sweep",
		"/_internal/maintenance/sweep%3f",
		"/_internal/maintenance/sweep;foo",
		"/_internal/maintenance/../maintenance/sweep",
		"/%255finternal/maintenance/sweep",
		"/_INTERNAL/maintenance/sweep",
		"/_internal%2fmaintenance%2fsweep",
	])
		expect(
			await new Promise<number>((resolve, reject) => {
				const request = httpRequest(
					base,
					{ method: "POST", path: url, headers },
					(response) => {
						response.resume();
						resolve(response.statusCode ?? 0);
					},
				);
				request.on("error", reject);
				request.end();
			}),
		).not.toBe(204);
	for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"] as const)
		expect(
			(await f.server.inject({ method, url: paths.sweep, headers })).statusCode,
		).toBe(404);
	expect(f.sweep).not.toHaveBeenCalled();
});
it("coalesces sweeps and drains independently, caches readiness, and sanitizes failures", async () => {
	let finishSweep!: () => void;
	let finishDrain!: () => void;
	const sweep = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finishSweep = resolve;
			}),
	);
	const drain = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finishDrain = resolve;
			}),
	);
	const f = fixture({ sweep, drain });
	const a = f.server.inject({ method: "POST", url: paths.drain, headers });
	const b = f.server.inject({ method: "POST", url: paths.drain, headers });
	await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
	expect(f.ready).not.toHaveBeenCalled();
	expect(sweep).not.toHaveBeenCalled();
	const c = f.server.inject({ method: "POST", url: paths.sweep, headers });
	const d = f.server.inject({ method: "POST", url: paths.sweep, headers });
	await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
	expect(f.ready).toHaveBeenCalledTimes(1);
	finishDrain();
	finishSweep();
	for (const response of await Promise.all([a, b, c, d]))
		expect(response.statusCode).toBe(204);
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
	f.ready.mockResolvedValue(false);
	expect(
		(await f.server.inject({ method: "POST", url: paths.sweep, headers }))
			.statusCode,
	).toBe(503);
	f.ready.mockRejectedValue(new Error("synthetic-secret"));
	const failed = await f.server.inject({ url: paths.ready, headers });
	expect(failed.statusCode).toBe(503);
	expect(failed.body).not.toContain("secret");
});
it("retains slow initialization after a caller aborts on the shared API listener", async () => {
	let complete!: (value: boolean) => void;
	const ready = vi.fn(
		() =>
			new Promise<boolean>((resolve) => {
				complete = resolve;
			}),
	);
	const f = fixture({ ready });
	const base = await f.server.listen({ port: 0, host: "127.0.0.1" });
	const controller = new AbortController();
	const first = fetch(base + paths.ready, {
		headers,
		signal: controller.signal,
	}).catch(() => null);
	await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
	controller.abort();
	await first;
	const next = fetch(base + paths.ready, { headers });
	complete(true);
	expect((await next).status).toBe(204);
	expect((await fetch(base + paths.ready, { headers })).status).toBe(204);
	expect(ready).toHaveBeenCalledTimes(1);
});
it("drains abandoned maintenance work before closing resources", async () => {
	let finish!: () => void;
	const sweep = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const f = fixture({ sweep });
	const base = await f.server.listen({ port: 0, host: "127.0.0.1" });
	const controller = new AbortController();
	const request = fetch(base + paths.sweep, {
		method: "POST",
		headers,
		signal: controller.signal,
	}).catch(() => null);
	await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
	controller.abort();
	await request;
	let closed = false;
	const close = f.server.close().then(() => {
		closed = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 25));
	expect(closed).toBe(false);
	finish();
	await close;
	expect(closed).toBe(true);
});
it("registers on the actual API server without relying on /v1 auth or changing public health", async () => {
	const server = createServer({
		logger: false,
		maintenanceToken: token,
		backgroundTimers: false,
	});
	servers.push(server);
	expect((await server.inject({ url: "/healthz" })).statusCode).toBe(200);
	expect((await server.inject({ url: paths.ready })).statusCode).toBe(404);
	expect((await server.inject({ url: paths.ready, headers })).statusCode).toBe(
		204,
	);
	expect((await server.inject({ url: "/v1/models", headers })).statusCode).toBe(
		401,
	);
	expect(
		(await server.inject({ method: "POST", url: paths.drain, headers }))
			.statusCode,
	).toBe(204);
	const disabled = createServer({ logger: false });
	servers.push(disabled);
	expect(
		(await disabled.inject({ url: paths.ready, headers })).statusCode,
	).toBe(404);
	expect(() =>
		registerMaintenanceRoutes(Fastify(), {
			token: "short",
			ready: async () => true,
			sweep: async () => {},
			drain: async () => {},
		}),
	).toThrow();
});

it.each([
	false,
	true,
])("cancels an indefinitely waiting model before maintenance shutdown (disconnected=%s)", async (disconnected) => {
	let modelStarted = false;
	let modelAborted = false;
	const provider = createHttpServer((request, response) => {
		request.resume();
		modelStarted = true;
		response.on("close", () => {
			modelAborted = true;
		});
	});
	await new Promise<void>((resolve) =>
		provider.listen(0, "127.0.0.1", resolve),
	);
	const address = provider.address();
	if (!address || typeof address === "string")
		throw new Error("No provider port");
	const api = await startChannels(
		[],
		{
			providers: [
				{
					name: "stub",
					kind: "openai-compatible",
					baseURL: `http://127.0.0.1:${address.port}/v1`,
					models: ["blocked"],
				},
			],
		},
		{ maintenanceToken: token, backgroundTimers: false },
	);
	servers.push(api.server);
	try {
		const channel = await api.createChannel("general");
		const bot = await api.ok<BotDetails>(
			"POST",
			"/v1/bots",
			{ body: { name: "Blocked", instructions: "", model: "stub/blocked" } },
			201,
		);
		await api.addAgent(channel.id, bot.id);
		await api.post(channel.id, `<@agent:${bot.id}> wait`);
		await vi.waitFor(() => expect(modelStarted).toBe(true));
		const controller = new AbortController();
		const seen = new Promise<void>((resolve) =>
			api.server.server.once("request", () => resolve()),
		);
		const draining = fetch(api.origin + paths.drain, {
			method: "POST",
			headers,
			signal: controller.signal,
		}).catch(() => null);
		await seen;
		await new Promise((resolve) => setImmediate(resolve));
		if (disconnected) {
			controller.abort();
			await draining;
		}
		const closing = api.server.close();
		await vi.waitFor(() => expect(modelAborted).toBe(true), { timeout: 2000 });
		await closing;
		await draining;
	} finally {
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
	}
}, 15000);

import {
	API_TOKEN_PERMISSIONS,
	type ApiTokenPermission,
	type ApiTokenSecret,
} from "@autonomo.us/common";
import { afterEach, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { startOpenAIStub } from "./openai-stub.js";

const ownerHeaders = { authorization: "Bearer owner-permissions-test" };
const input = { name: "Client", description: "Permissions test", ttlDays: 30 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function start() {
	let calls = 0;
	const stub = await startOpenAIStub({
		onRequest: () => {
			calls++;
		},
	});
	const server = createServer({
		config: {
			ownerToken: "owner-permissions-test",
			corsOrigins: [],
			providers: [
				{
					name: "stub",
					kind: "openai-compatible",
					baseURL: stub.url,
					models: ["chat-model"],
				},
			],
		},
		logger: false,
	});
	server.get("/v1/unlisted", () => ({ secret: "must not be exposed" }));
	cleanups.push(() => server.close(), stub.close);
	return { server, calls: () => calls };
}

// Each permission is tested against every current resource, including legacy endpoints.
it.each(
	Object.keys(API_TOKEN_PERMISSIONS) as ApiTokenPermission[],
)("enforces %s without granting access to unrelated actions", async (permission) => {
	const { server, calls } = await start();
	const created = await server.inject({
		method: "POST",
		url: "/v1/api-tokens",
		headers: ownerHeaders,
		payload: { ...input, permissions: [permission] },
	});
	expect(created.statusCode).toBe(201);
	const issued = created.json<ApiTokenSecret>();
	const headers = { authorization: `Bearer ${issued.secret}` };
	const routing = (
		await server.inject({ url: "/v1/routing", headers: ownerHeaders })
	).json().config;
	const cases = [
		{
			method: "GET",
			url: "/v1/telemetry/analytics?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z",
			required: "telemetry:read",
			status: 200,
		},
		{ method: "GET", url: "/v1/models", required: "models:read", status: 200 },
		{ method: "HEAD", url: "/v1/models", required: "models:read", status: 200 },
		{
			method: "GET",
			url: "/v1/models/catalog",
			required: "models:read",
			status: 200,
		},
		{
			method: "GET",
			url: "/v1/providers",
			required: "models:read",
			status: 200,
		},
		{
			method: "POST",
			url: "/v1/models",
			required: "models:edit",
			status: 200,
			payload: {
				provider: "openai",
				model: "test-model",
				apiKey: "test-provider-secret",
			},
		},
		{
			method: "GET",
			url: "/v1/routing",
			required: "routing:read",
			status: 200,
		},
		{
			method: "GET",
			url: "/v1/failover",
			required: "routing:read",
			status: 200,
		},
		{
			method: "PUT",
			url: "/v1/routing",
			required: "routing:edit",
			status: 200,
			payload: routing,
		},
		{
			method: "PUT",
			url: "/v1/failover",
			required: "routing:edit",
			status: 200,
			payload: { enabled: false, targets: [], timeoutMs: 30000 },
		},
		{
			method: "GET",
			url: "/v1/telemetry/summary?source=memory",
			required: "telemetry:read",
			status: 200,
		},
		{
			method: "GET",
			url: "/v1/telemetry/events",
			required: "telemetry:read",
			status: 200,
		},
		{
			method: "POST",
			url: "/v1/chat",
			required: "inference:run",
			status: 200,
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "Hello" }],
			},
		},
		// A valid Run grant reaches decisions schema validation; other grants stop before it.
		{
			method: "POST",
			url: "/v1/decisions",
			required: "inference:run",
			status: 400,
			payload: {},
		},
	] as const;
	for (const test of cases) {
		const allowed =
			permission === test.required ||
			(test.required.endsWith(":read") &&
				permission === test.required.replace(":read", ":edit"));
		const response = await server.inject({
			method: test.method,
			url: test.url,
			payload: "payload" in test ? test.payload : undefined,
			headers,
		});
		expect(
			response.statusCode,
			`${permission}: ${test.method} ${test.url}`,
		).toBe(allowed ? test.status : 403);
		expect(response.body).not.toContain("test-provider-secret");
	}
	// Unauthorized inference never reaches a provider, even with Models/Routing Edit.
	expect(calls()).toBe(permission === "inference:run" ? 1 : 0);
	for (const [method, url, payload] of [
		["GET", "/v1/api-tokens", undefined],
		["GET", "/v1/auth/owner", undefined],
		["POST", "/v1/api-tokens", { ...input, permissions: ["models:edit"] }],
		[
			"PATCH",
			`/v1/api-tokens/${issued.token.id}`,
			{ name: "Escalation", description: "", permissions: ["models:edit"] },
		],
		[
			"POST",
			`/v1/api-tokens/${issued.token.id}/roll`,
			{ ttlDays: 7, previousTokenTtlSeconds: 0 },
		],
		["DELETE", `/v1/api-tokens/${issued.token.id}`, undefined],
		["GET", "/v1/unlisted", undefined],
	] as const) {
		expect(
			(await server.inject({ method, url, payload, headers })).statusCode,
		).toBe(403);
	}
});

it("applies permission reductions to every rolled value and preserves an explicit empty selection", async () => {
	const { server } = await start();
	const first = (
		await server.inject({
			method: "POST",
			url: "/v1/api-tokens",
			headers: ownerHeaders,
			payload: {
				...input,
				permissions: ["routing:edit", "routing:read", "inference:run"],
			},
		})
	).json<ApiTokenSecret>();
	expect(first.token.permissions).toEqual(["routing:edit", "inference:run"]);
	const second = (
		await server.inject({
			method: "POST",
			url: `/v1/api-tokens/${first.token.id}/roll`,
			headers: ownerHeaders,
			payload: { ttlDays: 7, previousTokenTtlSeconds: 3600 },
		})
	).json<ApiTokenSecret>();
	expect(second.token.permissions).toEqual(first.token.permissions);
	for (const issued of [first, second])
		expect(
			(
				await server.inject({
					url: "/v1/routing",
					headers: { authorization: `Bearer ${issued.secret}` },
				})
			).statusCode,
		).toBe(200);
	const updated = await server.inject({
		method: "PATCH",
		url: `/v1/api-tokens/${first.token.id}`,
		headers: ownerHeaders,
		payload: {
			name: "Restricted",
			description: "",
			permissions: ["models:read"],
		},
	});
	expect(updated.statusCode).toBe(200);
	for (const issued of [first, second]) {
		const headers = { authorization: `Bearer ${issued.secret}` };
		expect(
			(await server.inject({ url: "/v1/models", headers })).statusCode,
		).toBe(200);
		expect(
			(await server.inject({ url: "/v1/routing", headers })).statusCode,
		).toBe(403);
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/chat",
					headers,
					payload: {},
				})
			).statusCode,
		).toBe(403);
	}
	await server.inject({
		method: "PATCH",
		url: `/v1/api-tokens/${first.token.id}`,
		headers: ownerHeaders,
		payload: { name: "Disabled", description: "", permissions: [] },
	});
	const renamed = await server.inject({
		method: "PATCH",
		url: `/v1/api-tokens/${first.token.id}`,
		headers: ownerHeaders,
		payload: {
			name: "Still disabled",
			description: "Older client omits permissions",
		},
	});
	expect(renamed.json().permissions).toEqual([]);
	const third = (
		await server.inject({
			method: "POST",
			url: `/v1/api-tokens/${first.token.id}/roll`,
			headers: ownerHeaders,
			payload: { ttlDays: 7, previousTokenTtlSeconds: 3600 },
		})
	).json<ApiTokenSecret>();
	expect(third.token.permissions).toEqual([]);
	for (const issued of [first, second, third])
		expect(
			(
				await server.inject({
					url: "/v1/models",
					headers: { authorization: `Bearer ${issued.secret}` },
				})
			).statusCode,
		).toBe(403);
	const actions = (
		await server.inject({ url: "/v1/api-tokens", headers: ownerHeaders })
	).json().actions;
	expect(
		actions.some((action: { detail: string }) =>
			action.detail.includes(
				"from Routing: Edit, Inference: Run to Models: Read",
			),
		),
	).toBe(true);
	expect(
		actions.some((action: { detail: string }) =>
			action.detail.includes("from Models: Read to None"),
		),
	).toBe(true);
});

it("rejects unknown, duplicate and malformed permissions without saving changes", async () => {
	const { server } = await start();
	const issued = (
		await server.inject({
			method: "POST",
			url: "/v1/api-tokens",
			headers: ownerHeaders,
			payload: { ...input, permissions: [] },
		})
	).json<ApiTokenSecret>();
	for (const permissions of [
		["admin"],
		["api_tokens:edit"],
		["models:run"],
		["models:read", "models:read"],
		"models:read",
		null,
		[1],
	]) {
		for (const [method, url] of [
			["POST", "/v1/api-tokens"],
			["PATCH", `/v1/api-tokens/${issued.token.id}`],
		] as const) {
			const result = await server.inject({
				method,
				url,
				headers: ownerHeaders,
				payload: { ...input, permissions },
			});
			expect(result.statusCode).toBe(400);
		}
	}
	const settings = (
		await server.inject({ url: "/v1/api-tokens", headers: ownerHeaders })
	).json();
	expect(settings.tokens).toHaveLength(1);
	expect(settings.tokens[0].permissions).toEqual([]);
	expect(settings.actions).toHaveLength(1);
});

it("uses normalized routes to protect encoded API URLs", async () => {
	const { server } = await start();
	const issued = (
		await server.inject({
			method: "POST",
			url: "/v1/api-tokens",
			headers: ownerHeaders,
			payload: { ...input, permissions: ["models:read"] },
		})
	).json<ApiTokenSecret>();
	const headers = { authorization: `Bearer ${issued.secret}` };
	for (const prefix of ["/v1", "/v%31", "/%761", "/%76%31"]) {
		expect((await server.inject(`${prefix}/api-tokens`)).statusCode).toBe(401);
		expect(
			(await server.inject({ url: `${prefix}/api-tokens`, headers }))
				.statusCode,
		).toBe(403);
		expect(
			(
				await server.inject({
					method: "POST",
					url: `${prefix}/api-tokens`,
					payload: input,
				})
			).statusCode,
		).toBe(401);
		expect(
			(
				await server.inject({
					method: "PATCH",
					url: `${prefix}/api-tokens/${issued.token.id}`,
					headers,
					payload: { ...input, permissions: ["models:edit"] },
				})
			).statusCode,
		).toBe(403);
		expect(
			(await server.inject({ url: `${prefix}/models`, headers })).statusCode,
		).toBe(200);
		expect(
			(
				await server.inject({
					method: "POST",
					url: `${prefix}/models`,
					headers,
					payload: {},
				})
			).statusCode,
		).toBe(403);
		expect(
			(
				await server.inject({
					url: `${prefix}/auth/owner`,
					headers: ownerHeaders,
				})
			).statusCode,
		).toBe(204);
	}
});

it("verifies the owner without requiring the token database", async () => {
	const server = createServer({
		config: {
			providers: [],
			corsOrigins: [],
			ownerToken: "owner-permissions-test",
			mongodbUrl: "mongodb://127.0.0.1:1/unavailable",
		},
		logger: false,
	});
	cleanups.push(() => server.close());
	expect(
		(await server.inject({ url: "/v1/auth/owner", headers: ownerHeaders }))
			.statusCode,
	).toBe(204);
	expect(
		(await server.inject({ url: "/v1/api-tokens", headers: ownerHeaders }))
			.statusCode,
	).toBe(503);
	expect(
		(await server.inject({ url: "/v1/models", headers: ownerHeaders }))
			.statusCode,
	).toBe(200);
	expect((await server.inject("/v1/auth/owner")).statusCode).toBe(401);
}, 15000);

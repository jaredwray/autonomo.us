import { API_TOKEN_TTLS, type ApiTokenSecret } from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { ApiTokenStore, tokenHash } from "../src/auth/tokens.js";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";
import { startStubProvider } from "./helpers.js";

const input = {
	name: "Production",
	description: "Gateway client",
	ttlDays: 30 as const,
};
const actor = "owner";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

describe("token lifecycle", () => {
	it.each(
		API_TOKEN_TTLS,
	)("enforces TTL %s at the exact expiry boundary", async (ttlDays) => {
		let now = Date.parse("2026-10-31T12:00:00Z");
		const store = new ApiTokenStore(undefined, () => now);
		const issued = await store.create({ ...input, ttlDays }, actor);
		expect(await store.authenticate(issued.secret)).toMatchObject({
			name: input.name,
			status: "active",
		});
		if (ttlDays === "never") {
			now += 1000 * 86_400_000;
			expect(issued.token.expiresAt).toBeNull();
			expect(await store.authenticate(issued.secret)).not.toBeNull();
		} else {
			now += ttlDays * 86_400_000 - 1;
			expect(await store.authenticate(issued.secret)).not.toBeNull();
			now++;
			expect(await store.authenticate(issued.secret)).toBeNull();
			expect((await store.settings(true)).tokens[0].status).toBe("expired");
		}
	});
	it("preserves earlier roll deadlines and caps overlap at original expiry", async () => {
		let now = Date.parse("2026-10-31T12:00:00Z");
		const store = new ApiTokenStore(undefined, () => now);
		const first = await store.create({ ...input, ttlDays: 1 }, actor);
		now += 86_400_000 - 5000;
		const second = await store.roll(
			first.token.id,
			{ ttlDays: 7, previousTokenTtlSeconds: 3600 },
			actor,
		);
		expect(second.token.previousTokens[0].expiresAt).toBe(
			first.token.expiresAt,
		);
		now += 1000;
		const third = await store.roll(
			first.token.id,
			{ ttlDays: "never", previousTokenTtlSeconds: 2 },
			actor,
		);
		expect(third.token.previousTokens).toHaveLength(2);
		for (const { secret } of [first, second, third])
			expect(await store.authenticate(secret)).not.toBeNull();
		now += 2000;
		expect(await store.authenticate(second.secret)).toBeNull();
		expect(await store.authenticate(first.secret)).not.toBeNull();
		now += 2000;
		expect(await store.authenticate(first.secret)).toBeNull();
		expect(await store.authenticate(third.secret)).not.toBeNull();
		expect((await store.settings(true)).tokens[0].previousTokens).toEqual([]);
	});
	it("supports immediate rolling, renews expired tokens, and revokes all values", async () => {
		let now = Date.now();
		const store = new ApiTokenStore(undefined, () => now);
		const first = await store.create({ ...input, ttlDays: 1 }, actor);
		const second = await store.roll(
			first.token.id,
			{ ttlDays: 1, previousTokenTtlSeconds: 0 },
			actor,
		);
		expect(await store.authenticate(first.secret)).toBeNull();
		now += 86_400_000;
		const third = await store.roll(
			first.token.id,
			{ ttlDays: 7, previousTokenTtlSeconds: 3600 },
			actor,
		);
		expect(await store.authenticate(second.secret)).toBeNull();
		expect(third.token.previousTokens).toEqual([]);
		const fourth = await store.roll(
			first.token.id,
			{ ttlDays: 7, previousTokenTtlSeconds: 3600 },
			actor,
		);
		await store.revoke(first.token.id, actor);
		for (const { secret } of [first, second, third, fourth])
			expect(await store.authenticate(secret)).toBeNull();
		expect((await store.settings(true)).tokens[0]).toMatchObject({
			status: "revoked",
			previousTokens: [],
		});
		await expect(
			store.roll(
				first.token.id,
				{ ttlDays: 7, previousTokenTtlSeconds: 0 },
				actor,
			),
		).rejects.toMatchObject({ statusCode: 409 });
		await expect(
			store.update(first.token.id, input, actor),
		).rejects.toMatchObject({ statusCode: 409 });
		await store.revoke(first.token.id, actor);
		expect(
			(await store.settings(true)).actions.filter(
				(item) => item.action === "revoked",
			),
		).toHaveLength(1);
	});
	it("retains redacted bounded history and serializes concurrent edits", async () => {
		let now = Date.now();
		const store = new ApiTokenStore(undefined, () => now++);
		const token = await store.create(input, actor);
		await Promise.all([
			store.update(
				token.token.id,
				{ name: "Renamed", description: "Updated" },
				actor,
			),
			store.roll(
				token.token.id,
				{ ttlDays: 180, previousTokenTtlSeconds: 10 },
				actor,
			),
		]);
		const settings = await store.settings(true);
		expect(settings.tokens[0]).toMatchObject({ name: "Renamed", ttlDays: 180 });
		expect(settings.actions.map((item) => item.action)).toEqual([
			"rolled",
			"updated",
			"created",
		]);
		expect(JSON.stringify(settings)).not.toContain(token.secret);
		expect(JSON.stringify(settings)).not.toContain(tokenHash(token.secret));
		for (let i = 0; i < 101; i++)
			await store.update(token.token.id, input, actor);
		expect((await store.settings(true)).actions).toHaveLength(100);
		expect(await store.authenticate("invalid")).toBeNull();
		expect(
			await store.authenticate(`${token.secret.slice(0, -1)}!`),
		).toBeNull();
		await expect(store.revoke("missing", actor)).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	it("bounds overlapping values without invalidating a live version", async () => {
		const store = new ApiTokenStore();
		const first = await store.create(input, actor);
		for (let i = 0; i < 19; i++)
			await store.roll(
				first.token.id,
				{ ttlDays: 30, previousTokenTtlSeconds: 3600 },
				actor,
			);
		await expect(
			store.roll(
				first.token.id,
				{ ttlDays: 30, previousTokenTtlSeconds: 3600 },
				actor,
			),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(await store.authenticate(first.secret)).not.toBeNull();
		expect((await store.settings(true)).actions).toHaveLength(20);
	});
});

describe("token API access", () => {
	const owner = "test-owner-credential";
	const headers = { authorization: `Bearer ${owner}` };
	const start = () => {
		const server = createServer({
			config: {
				providers: [],
				corsOrigins: ["http://localhost:5173"],
				ownerToken: owner,
			},
			logger: false,
		});
		cleanup.push(() => server.close());
		return server;
	};
	it("requires the owner for management, issues once, and rejects invalid/revoked tokens", async () => {
		const server = start();
		expect((await server.inject("/health")).statusCode).toBe(200);
		const unauthorized = await server.inject({
			url: "/v1/api-tokens",
			headers: { origin: "http://localhost:5173" },
		});
		expect(unauthorized.statusCode).toBe(401);
		expect(unauthorized.headers["access-control-allow-origin"]).toBe(
			"http://localhost:5173",
		);
		for (const path of [
			"/v1/api-tokens",
			"/v1/models",
			"/v1/routing",
			"/v1/telemetry/events",
		])
			expect((await server.inject(path)).statusCode).toBe(401);
		const created = await server.inject({
			method: "POST",
			url: "/v1/api-tokens",
			headers,
			payload: input,
		});
		expect(created.statusCode).toBe(201);
		expect(created.headers["cache-control"]).toBe("no-store");
		const { secret, token } = created.json<ApiTokenSecret>();
		const clientHeaders = { authorization: `Bearer ${secret}` };
		expect(
			(await server.inject({ url: "/v1/models", headers: clientHeaders }))
				.statusCode,
		).toBe(200);
		for (const path of [
			"/v1/api-tokens",
			"/v1/routing",
			"/v1/telemetry/summary",
		])
			expect(
				(await server.inject({ url: path, headers: clientHeaders })).statusCode,
			).toBe(403);
		for (const [method, url, payload] of [
			["POST", "/v1/api-tokens", input],
			[
				"POST",
				`/v1/api-tokens/${token.id}/roll`,
				{ ttlDays: 7, previousTokenTtlSeconds: 0 },
			],
			["DELETE", `/v1/api-tokens/${token.id}`, {}],
			["POST", "/v1/models", {}],
			["PUT", "/v1/failover", {}],
		] as const) {
			expect(
				(await server.inject({ method, url, payload, headers: clientHeaders }))
					.statusCode,
			).toBe(403);
		}
		expect(
			(
				await server.inject({
					method: "PATCH",
					url: `/v1/api-tokens/${token.id}`,
					headers,
					payload: { name: "Updated", description: "New description" },
				})
			).statusCode,
		).toBe(200);
		const listed = await server.inject({ url: "/v1/api-tokens", headers });
		expect(listed.body).not.toContain(secret);
		expect(listed.body).not.toContain(tokenHash(secret));
		expect(
			listed.json().actions.map((item: { action: string }) => item.action),
		).toEqual(["updated", "created"]);
		await server.inject({
			method: "DELETE",
			url: `/v1/api-tokens/${token.id}`,
			headers,
		});
		expect(
			(await server.inject({ url: "/v1/models", headers: clientHeaders }))
				.statusCode,
		).toBe(401);
		expect(
			(
				await server.inject({
					url: "/v1/models",
					headers: { authorization: "Basic invalid" },
				})
			).statusCode,
		).toBe(401);
		for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
			const preflight = await server.inject({
				method: "OPTIONS",
				url: "/v1/api-tokens",
				headers: {
					origin: "http://localhost:5173",
					"access-control-request-method": method,
					"access-control-request-headers": "authorization,content-type",
				},
			});
			expect(preflight.statusCode).toBe(204);
			expect(preflight.headers["access-control-allow-methods"]).toContain(
				method,
			);
		}
	});
	it("uses tokens through the real inference path and blocks revoked values", async () => {
		const provider = await startStubProvider();
		cleanup.push(provider.close);
		const server = createServer({
			config: { providers: [], corsOrigins: [], ownerToken: owner },
			registry: provider.registry,
			logger: false,
		});
		cleanup.push(() => server.close());
		const { secret, token } = (
			await server.inject({
				method: "POST",
				url: "/v1/api-tokens",
				headers,
				payload: input,
			})
		).json<ApiTokenSecret>();
		const request = {
			method: "POST" as const,
			url: "/v1/chat",
			headers: { authorization: `Bearer ${secret}` },
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "Hello" }],
			},
		};
		expect((await server.inject(request)).statusCode).toBe(200);
		await server.inject({
			method: "DELETE",
			url: `/v1/api-tokens/${token.id}`,
			headers,
		});
		expect((await server.inject(request)).statusCode).toBe(401);
	});
	it("validates metadata, TTL and overlap without logging failed writes", async () => {
		const server = start();
		for (const patch of [
			{ name: "  " },
			{ name: "a".repeat(101) },
			{ description: "x".repeat(1001) },
			{ ttlDays: 2 },
			{ ttlDays: null },
			{ ttlDays: "Never" },
		])
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/api-tokens",
						headers,
						payload: { ...input, ...patch },
					})
				).statusCode,
			).toBe(400);
		const { token } = (
			await server.inject({
				method: "POST",
				url: "/v1/api-tokens",
				headers,
				payload: input,
			})
		).json<ApiTokenSecret>();
		for (const previousTokenTtlSeconds of [-1, 0.5, 2592001, "NaN"])
			expect(
				(
					await server.inject({
						method: "POST",
						url: `/v1/api-tokens/${token.id}/roll`,
						headers,
						payload: { ttlDays: 7, previousTokenTtlSeconds },
					})
				).statusCode,
			).toBe(400);
		expect(
			(await server.inject({ url: "/v1/api-tokens", headers })).json().actions,
		).toHaveLength(1);
		expect(
			(
				await server.inject({
					method: "POST",
					url: `/v1/api-tokens/${token.id}/roll`,
					headers,
					payload: { ttlDays: "never", previousTokenTtlSeconds: 2592000 },
				})
			).statusCode,
		).toBe(200);
	});
	it("retains explicit local mode and reads the owner environment setting", async () => {
		expect(configFromEnv({ OWNER_TOKEN: owner }).ownerToken).toBe(owner);
		const server = createServer({
			config: { providers: [], corsOrigins: [] },
			logger: false,
		});
		cleanup.push(() => server.close());
		expect((await server.inject("/v1/api-tokens")).json()).toMatchObject({
			persistence: "memory",
			authenticationRequired: false,
		});
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/api-tokens",
					payload: input,
				})
			).statusCode,
		).toBe(201);
		expect(
			(await server.inject("/v1/api-tokens")).json().actions[0].actor,
		).toBe("local-admin");
	});
});

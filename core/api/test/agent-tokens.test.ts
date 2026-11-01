import { randomUUID } from "node:crypto";
import type { AgentTokenSecret } from "@autonomo.us/common";
import { afterEach, expect, it } from "vitest";
import { AgentTokenStore } from "../src/auth/agent-tokens.js";
import { ApiTokenStore, tokenHash } from "../src/auth/tokens.js";
import { createServer } from "../src/server.js";

const headers = { authorization: "Bearer agent-test-owner" };
const input = {
	name: "Research agent",
	description: "MCP connection",
	ttlDays: 30 as const,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});
function start(ownerToken: string | undefined = "agent-test-owner") {
	const server = createServer({
		config: { providers: [], corsOrigins: [], ownerToken },
		logger: false,
	});
	cleanups.push(() => server.close());
	return server;
}

it("keeps agent authentication separate, defaults to no grants, and applies permission edits to all values", async () => {
	const agents = new AgentTokenStore();
	const api = new ApiTokenStore();
	const agent = await agents.create(input, "owner");
	const application = await api.create(input, "owner");
	expect(agent.secret).toMatch(/^agt_/);
	expect(agent.token.permissions).toEqual([]);
	expect(await api.authenticate(agent.secret)).toBeNull();
	expect(await agents.authenticate(application.secret)).toBeNull();
	expect(
		await api.authenticate(agent.secret.replace(/^agt_/, "aut_")),
	).toBeNull();
	const rolled = await agents.roll(
		agent.token.id,
		{ ttlDays: 7, previousTokenTtlSeconds: 3600 },
		"owner",
	);
	await agents.update(
		agent.token.id,
		{ ...input, permissions: ["mcp:read", "mcp:call"] },
		"owner",
	);
	for (const secret of [agent.secret, rolled.secret])
		expect((await agents.authenticate(secret))?.permissions).toEqual([
			"mcp:read",
			"mcp:call",
		]);
	await agents.update(agent.token.id, { ...input, permissions: [] }, "owner");
	await agents.update(agent.token.id, input, "owner");
	for (const secret of [agent.secret, rolled.secret])
		expect((await agents.authenticate(secret))?.permissions).toEqual([]);
	expect(
		(await agents.settings(true)).actions.some((action) =>
			action.detail.includes("from MCP: Read, MCP: Call to None"),
		),
	).toBe(true);
});

it("provides an isolated owner-managed lifecycle and never lists secrets or hashes", async () => {
	const server = start();
	const created = await server.inject({
		method: "POST",
		url: "/v1/agent-tokens",
		headers,
		payload: { ...input, permissions: ["mcp:read", "mcp:call"] },
	});
	expect(created.statusCode).toBe(201);
	expect(created.headers["cache-control"]).toBe("no-store");
	const agent = created.json<AgentTokenSecret>();
	expect(
		(await server.inject({ url: "/v1/api-tokens", headers })).json().tokens,
	).toEqual([]);
	const apiToken = (
		await server.inject({
			method: "POST",
			url: "/v1/api-tokens",
			headers,
			payload: input,
		})
	).json();
	for (const [method, url, payload] of [
		["GET", "/v1/agent-tokens", undefined],
		["POST", "/v1/agent-tokens", input],
		["PATCH", `/v1/agent-tokens/${agent.token.id}`, input],
		[
			"POST",
			`/v1/agent-tokens/${agent.token.id}/roll`,
			{ ttlDays: 7, previousTokenTtlSeconds: 0 },
		],
		["DELETE", `/v1/agent-tokens/${agent.token.id}`, undefined],
	] as const) {
		expect((await server.inject({ method, url, payload })).statusCode).toBe(
			401,
		);
		expect(
			(
				await server.inject({
					method,
					url,
					payload,
					headers: { authorization: `Bearer ${apiToken.secret}` },
				})
			).statusCode,
		).toBe(403);
		expect(
			(
				await server.inject({
					method,
					url,
					payload,
					headers: { authorization: `Bearer ${agent.secret}` },
				})
			).statusCode,
		).toBe(401);
	}
	for (const url of [
		"/v1/models",
		"/v1/auth/owner",
		"/v1/api-tokens",
		"/v1/routing",
		"/v1/telemetry/events",
		"/%761/agent-tokens",
	]) {
		expect(
			(
				await server.inject({
					url,
					headers: { authorization: `Bearer ${agent.secret}` },
				})
			).statusCode,
		).toBe(401);
	}
	expect(
		(
			await server.inject({
				method: "POST",
				url: "/v1/chat",
				headers: { authorization: `Bearer ${agent.secret}` },
				payload: {},
			})
		).statusCode,
	).toBe(401);
	for (const [collection, id] of [
		["agent-tokens", apiToken.token.id],
		["api-tokens", agent.token.id],
	]) {
		expect(
			(
				await server.inject({
					method: "DELETE",
					url: `/v1/${collection}/${id}`,
					headers,
				})
			).statusCode,
		).toBe(404);
	}
	expect(
		(
			await server.inject({
				method: "PATCH",
				url: `/v1/agent-tokens/${agent.token.id}`,
				headers,
				payload: {
					name: "Renamed agent",
					description: "Updated",
					permissions: [],
				},
			})
		).json().permissions,
	).toEqual([]);
	const rolled = (
		await server.inject({
			method: "POST",
			url: `/v1/agent-tokens/${agent.token.id}/roll`,
			headers,
			payload: { ttlDays: "never", previousTokenTtlSeconds: 3600 },
		})
	).json<AgentTokenSecret>();
	expect(rolled.token.previousTokens).toHaveLength(1);
	expect(rolled.token.permissions).toEqual([]);
	const revoked = await server.inject({
		method: "DELETE",
		url: `/v1/agent-tokens/${agent.token.id}`,
		headers,
	});
	expect(revoked.json()).toMatchObject({
		status: "revoked",
		previousTokens: [],
	});
	const listed = await server.inject({ url: "/v1/agent-tokens", headers });
	expect(listed.json().tokens).toHaveLength(1);
	expect(
		listed
			.json()
			.actions.map((action: { action: string }) => action.action)
			.sort(),
	).toEqual(["created", "revoked", "rolled", "updated"]);
	for (const secret of [agent.secret, rolled.secret]) {
		expect(listed.body).not.toContain(secret);
		expect(listed.body).not.toContain(tokenHash(secret));
	}
	expect(
		(await server.inject({ url: "/v1/api-tokens", headers })).json().tokens[0]
			.status,
	).toBe("active");
});

it("rejects API grants and malformed agent grants without changing stored tokens or history", async () => {
	const server = start();
	const issued = (
		await server.inject({
			method: "POST",
			url: "/v1/agent-tokens",
			headers,
			payload: input,
		})
	).json<AgentTokenSecret>();
	expect(issued.token.permissions).toEqual([]);
	for (const permissions of [
		["models:edit"],
		["inference:run"],
		["mcp:read", "mcp:read"],
		"mcp:call",
		null,
		[1],
	]) {
		for (const [method, url] of [
			["POST", "/v1/agent-tokens"],
			["PATCH", `/v1/agent-tokens/${issued.token.id}`],
		] as const) {
			expect(
				(
					await server.inject({
						method,
						url,
						headers,
						payload: { ...input, permissions },
					})
				).statusCode,
			).toBe(400);
		}
	}
	expect(
		(
			await server.inject({
				method: "POST",
				url: "/v1/api-tokens",
				headers,
				payload: { ...input, permissions: ["mcp:read"] },
			})
		).statusCode,
	).toBe(400);
	const settings = (
		await server.inject({ url: "/v1/agent-tokens", headers })
	).json();
	expect(settings.actions).toHaveLength(1);
	expect(settings.tokens[0].permissions).toEqual([]);
});

it("retains explicit local management mode without accepting agent credentials for the API", async () => {
	const server = createServer({
		config: { providers: [], corsOrigins: [] },
		logger: false,
	});
	cleanups.push(() => server.close());
	const issued = (
		await server.inject({
			method: "POST",
			url: "/v1/agent-tokens",
			payload: input,
		})
	).json<AgentTokenSecret>();
	const settings = (await server.inject("/v1/agent-tokens")).json();
	expect(settings).toMatchObject({
		persistence: "memory",
		authenticationRequired: false,
	});
	expect(settings.actions[0].actor).toBe("local-admin");
	expect(
		(
			await server.inject({
				url: "/v1/models",
				headers: { authorization: `Bearer ${issued.secret}` },
			})
		).statusCode,
	).toBe(401);
});

it("fails closed when the agent token database is unavailable", async () => {
	const store = new AgentTokenStore("mongodb://127.0.0.1:1/unavailable");
	cleanups.push(() => store.close());
	await expect(store.settings(true)).rejects.toMatchObject({ statusCode: 503 });
	await expect(
		store.authenticate(`agt_${randomUUID()}_${"x".repeat(43)}`),
	).rejects.toMatchObject({ statusCode: 503 });
	await expect(store.create(input, "owner")).rejects.toMatchObject({
		statusCode: 503,
	});
}, 10000);

import type { AddModelRequest } from "@autonomo.us/common";
import { afterEach, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	vi.unstubAllGlobals();
});
function gateway() {
	const server = createServer({ config: configFromEnv({}), logger: false });
	servers.push(server);
	return server;
}
function add(
	server: ReturnType<typeof createServer>,
	payload: AddModelRequest,
) {
	return server.inject({ method: "POST", url: "/v1/models", payload });
}
const response = {
	id: "test",
	created: 1,
	model: "grok-test",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "Hello" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

it("routes duplicate models through independent credentials and only rotates the selected connection", async () => {
	const upstream = vi.fn<typeof fetch>(async () => Response.json(response));
	vi.stubGlobal("fetch", upstream);
	const server = gateway();
	for (const [connectionId, apiKey] of [
		["xai", "default-key"],
		["xai-work", "work-key"],
		["xai-personal", "personal-key"],
	]) {
		expect(
			(
				await add(server, {
					provider: "xai",
					connectionId,
					createConnection: true,
					model: "grok-test",
					apiKey,
				})
			).statusCode,
		).toBe(200);
	}
	expect(
		(
			await add(server, {
				provider: "xai",
				connectionId: "xai-work",
				model: "grok-test",
				apiKey: "rotated-key",
			})
		).statusCode,
	).toBe(200);
	expect(
		(
			await add(server, {
				provider: "xai",
				connectionId: "xai-work",
				model: "grok-other",
			})
		).statusCode,
	).toBe(200);
	for (const model of [
		"xai/grok-test",
		"xai-work/grok-test",
		"xai-personal/grok-test",
		"xai-work/grok-other",
	]) {
		const result = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: { model, messages: [{ role: "user", content: "Hi" }] },
		});
		expect(result.statusCode).toBe(200);
		expect(result.json().model).toBe(model);
	}
	expect(
		upstream.mock.calls.map(([, init]) =>
			new Headers(init?.headers).get("authorization"),
		),
	).toEqual([
		"Bearer default-key",
		"Bearer rotated-key",
		"Bearer personal-key",
		"Bearer rotated-key",
	]);
	const models = await server.inject("/v1/models");
	expect(models.json().models).toHaveLength(4);
	const settings = await server.inject("/v1/providers");
	expect(
		settings.json().connections.map((item: { id: string }) => item.id),
	).toEqual(["xai", "xai-work", "xai-personal"]);
	expect(settings.body + models.body).not.toMatch(
		/default-key|work-key|rotated-key|personal-key/,
	);
	// Failover can select another connection of the same provider.
	upstream.mockImplementation(async (_url, init) =>
		new Headers(init?.headers).get("authorization") === "Bearer rotated-key"
			? Response.json({ error: { message: "Unavailable" } }, { status: 503 })
			: Response.json(response),
	);
	expect(
		(
			await server.inject({
				method: "PUT",
				url: "/v1/failover",
				payload: { enabled: true, targets: ["xai-personal/grok-test"] },
			})
		).statusCode,
	).toBe(200);
	const failover = await server.inject({
		method: "POST",
		url: "/v1/chat",
		payload: {
			model: "xai-work/grok-test",
			messages: [{ role: "user", content: "Hi" }],
		},
	});
	expect(failover.statusCode).toBe(200);
	expect(failover.json().model).toBe("xai-personal/grok-test");
});

it("requires new credentials for each connection and rejects duplicate names, cross-provider collisions, and invalid IDs", async () => {
	const server = gateway();
	await add(server, { provider: "xai", model: "test", apiKey: "default-key" });
	expect(
		(
			await add(server, {
				provider: "xai",
				connectionId: "other",
				model: "test",
			})
		).statusCode,
	).toBe(400);
	for (const connectionId of ["with space", "path/name", "", "a".repeat(65)]) {
		expect(
			(
				await add(server, {
					provider: "xai",
					connectionId,
					model: "test",
					apiKey: "key",
				})
			).statusCode,
		).toBe(400);
	}
	expect(
		(
			await add(server, {
				provider: "xai",
				connectionId: "google",
				model: "test",
				apiKey: "key",
			})
		).statusCode,
	).toBe(409);
	const created = await Promise.all(
		["one", "two"].map((apiKey) =>
			add(server, {
				provider: "xai",
				connectionId: "work",
				createConnection: true,
				model: "test",
				apiKey,
			}),
		),
	);
	expect(created.map((result) => result.statusCode)).toEqual([200, 409]);
	expect(
		(
			await add(server, {
				provider: "google",
				connectionId: "work",
				model: "test",
				apiKey: "key",
			})
		).statusCode,
	).toBe(409);
	expect((await server.inject("/v1/models")).json().models).toHaveLength(2);
});

it("keeps Cloudflare account IDs and Jev capabilities scoped to their connection", async () => {
	const server = gateway();
	for (const [connectionId, accountId] of [
		["cloudflare", "a".repeat(32)],
		["cf-work", "b".repeat(32)],
	]) {
		expect(
			(
				await add(server, {
					provider: "cloudflare",
					connectionId,
					accountId,
					model: "@cf/meta/test",
					apiKey: "key",
				})
			).statusCode,
		).toBe(200);
	}
	expect(
		(
			await add(server, {
				provider: "cloudflare",
				connectionId: "cf-missing",
				model: "@cf/meta/test",
				apiKey: "key",
			})
		).statusCode,
	).toBe(400);
	expect(
		(
			await add(server, {
				provider: "cloudflare",
				connectionId: "cf-work",
				model: "@cf/meta/second",
			})
		).statusCode,
	).toBe(200);
	const connections = (await server.inject("/v1/providers")).json().connections;
	expect(
		connections.find((item: { id: string }) => item.id === "cf-work").accountId,
	).toBe("b".repeat(32));
	expect(
		connections.find((item: { id: string }) => item.id === "cloudflare")
			.accountId,
	).toBe("a".repeat(32));
	const jev = await add(server, {
		provider: "typesafe",
		connectionId: "jev-work",
		model: "jev-latest",
		apiKey: "key",
	});
	expect(jev.json()).toMatchObject({
		id: "jev-work/jev-latest",
		capability: "decisions",
	});
	expect(
		(
			await server.inject({
				method: "POST",
				url: "/v1/chat",
				payload: {
					model: "jev-work/jev-latest",
					messages: [{ role: "user", content: "Hi" }],
				},
			})
		).statusCode,
	).toBe(400);
});

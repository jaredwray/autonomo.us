import type { DecisionRequest } from "@autonomo.us/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";

const payload: DecisionRequest = {
	model: "typesafe/jev-latest",
	state: { ticket: "Charged twice" },
	questions: {
		billing: { type: "noul", instructions: "Is this billing?" },
		department: {
			type: "choice",
			criteria: { billing: "Payments", support: "Other issues" },
		},
		urgency: { type: "score", criteria: ["Low", "High"] },
	},
};
const result = {
	model: "jev-1.14.0",
	answers: {
		billing: { type: "noul", noul: 0.98 },
		department: {
			type: "choice",
			choice: "billing",
			confidence: 0.9,
			probabilities: { billing: 0.95, support: 0.05 },
		},
		urgency: {
			type: "score",
			score: 0.5,
			confidence: 0.8,
			probabilities: [0.5, 0.5],
		},
	},
	usage: { input_tokens: 120, output_tokens: 12 },
};
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	vi.unstubAllGlobals();
});
async function gateway(apiKey = "test-secret") {
	const telemetry = new TelemetryService();
	const server = createServer({
		config: configFromEnv({}),
		telemetry,
		logger: false,
	});
	servers.push(server);
	expect(
		(
			await server.inject({
				method: "POST",
				url: "/v1/models",
				payload: { provider: "typesafe", model: "jev-latest", apiKey },
			})
		).statusCode,
	).toBe(200);
	return { server, telemetry };
}

describe("Jev decision adapter", () => {
	for (const state of ["ticket", ["ticket"], { ticket: "text" }]) {
		it("preserves the native state shape without scalar/array coercion", async () => {
			const upstream = vi.fn(async () => Response.json(result));
			vi.stubGlobal("fetch", upstream);
			const { server } = await gateway();
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/decisions",
						payload: { ...payload, state },
					})
				).statusCode,
			).toBe(200);
			expect(upstream).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					body: JSON.stringify({ ...payload, state, model: "jev-latest" }),
				}),
			);
		});
	}
	it("sends native questions to TypeSafe and preserves answers, confidence, and usage", async () => {
		const upstream = vi.fn(async () => Response.json(result));
		vi.stubGlobal("fetch", upstream);
		const { server, telemetry } = await gateway();
		const response = await server.inject({
			method: "POST",
			url: "/v1/decisions",
			payload,
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(result);
		expect(upstream).toHaveBeenCalledWith(
			"https://api.typesafe.ai/v1/systemone",
			expect.objectContaining({
				method: "POST",
				headers: {
					authorization: "Bearer test-secret",
					"content-type": "application/json",
				},
				body: JSON.stringify({ ...payload, model: "jev-latest" }),
				signal: expect.any(AbortSignal),
				redirect: "error",
			}),
		);
		expect(
			(await server.inject("/v1/models")).json().models[0].capability,
		).toBe("decisions");
		expect(JSON.stringify(telemetry)).not.toContain("test-secret");
		const summary = (await server.inject("/v1/telemetry/summary")).json();
		expect(summary.totalTokens).toBe(132);
	});

	it("rejects chat, chat failover, malformed decisions, and decisions on chat models before invoking a provider", async () => {
		const upstream = vi.fn();
		vi.stubGlobal("fetch", upstream);
		const { server } = await gateway();
		const chat = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: payload.model,
				messages: [{ role: "user", content: "Hi" }],
			},
		});
		expect(chat.statusCode).toBe(400);
		expect(chat.body).toContain("/v1/decisions");
		expect(
			(
				await server.inject({
					method: "PUT",
					url: "/v1/failover",
					payload: { targets: [payload.model] },
				})
			).statusCode,
		).toBe(400);
		for (const invalid of [
			{ ...payload, questions: {} },
			{ ...payload, state: 5 },
			{ ...payload, questions: { route: { type: "choice" } } },
			{ ...payload, questions: { bad: { type: "chat" } } },
		]) {
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/decisions",
						payload: invalid,
					})
				).statusCode,
			).toBe(400);
		}
		await server.inject({
			method: "POST",
			url: "/v1/models",
			payload: { provider: "openai", model: "test", apiKey: "key" },
		});
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/decisions",
					payload: { ...payload, model: "openai/test" },
				})
			).statusCode,
		).toBe(400);
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/decisions",
					payload: { ...payload, model: "missing/test" },
				})
			).statusCode,
		).toBe(404);
		expect(upstream).not.toHaveBeenCalled();
	});

	for (const status of [401, 429, 503]) {
		it(`handles upstream HTTP ${status} without returning provider secrets`, async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json({ error: "test-secret" }, { status })),
			);
			const { server } = await gateway();
			const response = await server.inject({
				method: "POST",
				url: "/v1/decisions",
				payload,
			});
			expect(response.statusCode).toBe(status === 429 ? 429 : 502);
			expect(response.body).not.toContain("test-secret");
		});
	}
	for (const body of [
		{},
		{ ...result, answers: {} },
		{ ...result, usage: { input_tokens: -1 } },
	]) {
		it("rejects malformed upstream responses", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json(body)),
			);
			const { server } = await gateway();
			expect(
				(await server.inject({ method: "POST", url: "/v1/decisions", payload }))
					.statusCode,
			).toBe(502);
		});
	}
	it("maps upstream timeouts to 504", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("test-secret", "TimeoutError");
			}),
		);
		const { server } = await gateway();
		const response = await server.inject({
			method: "POST",
			url: "/v1/decisions",
			payload,
		});
		expect(response.statusCode).toBe(504);
		expect(response.body).not.toContain("test-secret");
	});
});

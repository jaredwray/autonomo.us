import http from "node:http";
import type { AddressInfo } from "node:net";
import type { RoutingConfig } from "@autonomo.us/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { startOpenAIStub } from "./openai-stub.js";

const messages = [
	{ role: "system", content: "Give concise, accurate answers." },
	{ role: "user", content: "Write code for a web server" },
];
const base: RoutingConfig = {
	auto: {
		enabled: false,
		decisionModel: "jev/selector",
		targets: [
			{ target: "work/chat", description: "Coding and reasoning" },
			{ target: "backup/chat", description: "General writing" },
		],
		fallbackTarget: "backup/chat",
		timeoutMs: 1000,
	},
	pools: [],
	rules: [],
	failover: { enabled: false, targets: [], timeoutMs: 1000 },
};
let server: ReturnType<typeof createServer>;
let chatServer: Awaited<ReturnType<typeof startOpenAIStub>>;
let selector: http.Server;
let telemetry: TelemetryService;
let selectorCalls: Array<{ path: string; body: Record<string, unknown> }>;
let chatCalls: Array<{ model?: string; authorization?: string }>;
let chosen: string;
let startedSlow: () => void;
let slowStarted: Promise<void>;
let selectorStarted: Promise<void>;
let markSelectorStarted: () => void;
let selectorDisconnected: boolean;

beforeEach(async () => {
	chosen = "work/chat";
	selectorCalls = [];
	chatCalls = [];
	selectorDisconnected = false;
	selectorStarted = new Promise((resolve) => {
		markSelectorStarted = resolve;
	});
	slowStarted = new Promise((resolve) => {
		startedSlow = resolve;
	});
	chatServer = await startOpenAIStub({
		onRequest(body, headers) {
			chatCalls.push({
				model: body.model,
				authorization: headers.authorization,
			});
			if (body.model === "slow-model") startedSlow();
		},
	});
	selector = http.createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		selectorCalls.push({ path: req.url ?? "", body });
		res.once("close", () => {
			if (!res.writableEnded) selectorDisconnected = true;
		});
		markSelectorStarted();
		if (body.model === "slow") return;
		if (body.model === "broken") {
			res.writeHead(503);
			res.end("unavailable");
			return;
		}
		const choice = body.model === "invalid" ? "unapproved/model" : chosen;
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify(
				req.url?.endsWith("systemone")
					? {
							model: body.model,
							answers: { route: { type: "choice", choice } },
							usage: { input_tokens: 20, output_tokens: 2 },
						}
					: {
							id: "resp-routing",
							created_at: 1,
							model: body.model,
							status: "completed",
							error: null,
							incomplete_details: null,
							output: [
								{
									type: "message",
									id: "msg-routing",
									role: "assistant",
									status: "completed",
									content: [
										{ type: "output_text", text: choice, annotations: [] },
									],
								},
							],
							usage: {
								input_tokens: 20,
								output_tokens: 2,
								total_tokens: 22,
								input_tokens_details: { cached_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 0 },
							},
						},
			),
		);
	});
	await new Promise<void>((resolve) =>
		selector.listen(0, "127.0.0.1", resolve),
	);
	const baseURL = `http://127.0.0.1:${(selector.address() as AddressInfo).port}/v1`;
	const config: ApiConfig = {
		corsOrigins: ["*"],
		providers: [
			...(["work", "backup"] as const).map((name) => ({
				kind: "openai-compatible" as const,
				name,
				baseURL: chatServer.url,
				apiKey: `${name}-secret`,
				models: ["chat", "broken-model", "slow-model", "broken-stream-model"],
			})),
			{
				kind: "typesafe",
				name: "jev",
				apiKey: "secret",
				baseURL,
				models: ["selector", "invalid", "broken", "slow"],
			},
			{
				kind: "openai",
				name: "openai",
				apiKey: "secret",
				baseURL,
				models: ["selector", "invalid", "broken", "slow"],
			},
		],
	};
	telemetry = new TelemetryService();
	server = createServer({ config, telemetry, logger: false });
});

afterEach(async () => {
	await server.close();
	selector.closeAllConnections();
	await Promise.all([
		chatServer.close(),
		new Promise<void>((resolve) => selector.close(() => resolve())),
	]);
});

async function save(config: RoutingConfig) {
	const result = await server.inject({
		method: "PUT",
		url: "/v1/routing",
		payload: config,
	});
	expect(result.statusCode, result.body).toBe(200);
	return result.json();
}
function chat(model: string, stream = false) {
	return server.inject({
		method: "POST",
		url: "/v1/chat",
		payload: { model, stream, messages },
	});
}
function pool(
	strategy: "weighted-round-robin" | "least-requests" = "weighted-round-robin",
): RoutingConfig["pools"][number] {
	return {
		id: "coding",
		strategy,
		members: [
			{ model: "work/chat", weight: 3 },
			{ model: "backup/chat", weight: 1 },
		],
		failover: true,
	};
}

describe("routing settings", () => {
	it("reserves the pool namespace for new connections", async () => {
		const response = await server.inject({
			method: "POST",
			url: "/v1/models",
			payload: {
				provider: "openai",
				connectionId: "pool",
				apiKey: "test",
				model: "chat",
			},
		});
		expect(response.statusCode).toBe(409);
		expect(response.body).toContain("reserved");
	});
	it("preserves legacy connections named pool and rejects colliding pool configuration", async () => {
		await server.close();
		server = createServer({
			config: {
				corsOrigins: [],
				providers: [
					{
						kind: "openai-compatible",
						name: "pool",
						baseURL: chatServer.url,
						models: ["chat"],
					},
				],
			},
			logger: false,
		});
		expect((await chat("pool/chat")).json().model).toBe("pool/chat");
		const settings = (await server.inject("/v1/routing")).json().config;
		await save(settings);
		const response = await server.inject({
			method: "PUT",
			url: "/v1/routing",
			payload: {
				...settings,
				pools: [{ ...pool(), members: [{ model: "pool/chat", weight: 1 }] }],
			},
		});
		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("legacy connection");
	});
	it("keeps legacy failover and routing settings synchronized", async () => {
		const policy = { enabled: true, targets: ["backup/chat"], timeoutMs: 200 };
		await save({ ...base, failover: policy });
		expect((await server.inject("/v1/failover")).json()).toEqual(policy);
		await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { timeoutMs: 300 },
		});
		const result = (await server.inject("/v1/routing")).json();
		expect(result).toMatchObject({
			persistence: "memory",
			config: { failover: { ...policy, timeoutMs: 300 } },
		});
		expect(JSON.stringify(result)).not.toContain("secret");
	});
	it("rejects invalid policies atomically, including decision-only chat targets and recursive pools", async () => {
		await save(base);
		const invalid: RoutingConfig[] = [
			{
				...base,
				auto: { ...base.auto, enabled: true, fallbackTarget: "work/other" },
			},
			{
				...base,
				auto: { ...base.auto, enabled: true, decisionModel: "", targets: [] },
			},
			{ ...base, auto: { ...base.auto, timeoutMs: 0 } },
			{ ...base, auto: { ...base.auto, decisionModel: "missing/selector" } },
			{
				...base,
				pools: [{ ...pool(), members: [{ model: "jev/selector", weight: 1 }] }],
			},
			{
				...base,
				pools: [{ ...pool(), members: [{ model: "pool/coding", weight: 1 }] }],
			},
			{
				...base,
				pools: [{ ...pool(), members: [{ model: "work/chat", weight: 0 }] }],
			},
			{ ...base, pools: [{ ...pool(), members: [] }] },
			{ ...base, pools: [pool(), pool()] },
			{
				...base,
				pools: [{ ...pool(), members: [pool().members[0], pool().members[0]] }],
			},
			{
				...base,
				rules: [
					{ model: "pool/missing", enabled: true, targets: [], timeoutMs: 100 },
				],
			},
			{ ...base, failover: { ...base.failover, targets: ["missing/chat"] } },
		];
		for (const payload of invalid) {
			const response = await server.inject({
				method: "PUT",
				url: "/v1/routing",
				payload,
			});
			expect(response.statusCode, JSON.stringify(payload)).toBe(400);
			expect((await server.inject("/v1/routing")).json().config).toEqual(base);
		}
	});
	it("rejects disabled Auto and unknown pool requests without inference", async () => {
		expect((await chat("auto")).statusCode).toBe(400);
		expect((await chat("pool/missing")).statusCode).toBe(404);
		expect(chatCalls).toHaveLength(0);
		expect(selectorCalls).toHaveLength(0);
	});
});

describe("automatic selection", () => {
	for (const provider of ["jev", "openai"])
		for (const stream of [true, false]) {
			it(`cancels ${provider} selection on disconnect without starting a target (stream=${stream})`, async () => {
				await save({
					...base,
					auto: {
						...base.auto,
						enabled: true,
						decisionModel: `${provider}/slow`,
						timeoutMs: 4000,
					},
				});
				const origin = await server.listen({ port: 0, host: "127.0.0.1" });
				const client = new AbortController();
				const request = fetch(`${origin}/v1/chat`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: "auto", messages, stream }),
					signal: client.signal,
				}).catch((error) => error);
				await selectorStarted;
				client.abort();
				await request;
				// The upstream socket must close from cancellation, before its 4s timeout.
				await expect
					.poll(() => selectorDisconnected, { timeout: 1000 })
					.toBe(true);
				await expect
					.poll(() => telemetry.recentEvents()[0]?.data.error, {
						timeout: 1000,
					})
					.toBe("Routing canceled because the client disconnected.");
				expect(chatCalls).toHaveLength(0);
			});
		}
	for (const decisionModel of ["jev/selector", "openai/selector"]) {
		it(`selects an allowed target through ${decisionModel} and records selector usage separately`, async () => {
			await save({
				...base,
				auto: { ...base.auto, enabled: true, decisionModel },
			});
			const response = await chat("auto");
			expect(response.statusCode, response.body).toBe(200);
			expect(response.json()).toMatchObject({
				model: "work/chat",
				routing: {
					mode: "auto",
					decisionModel,
					target: "work/chat",
					selectedModel: "work/chat",
				},
			});
			expect(response.json().routing.decisionFallback).toBeUndefined();
			expect(selectorCalls).toHaveLength(1);
			expect(selectorCalls[0].path).toBe(
				decisionModel.startsWith("jev") ? "/v1/systemone" : "/v1/responses",
			);
			expect(JSON.stringify(selectorCalls[0].body)).toContain(
				"Write code for a web server",
			);
			expect(JSON.stringify(selectorCalls[0].body)).toContain(
				"Coding and reasoning",
			);
			expect(telemetry.summary().totalTokens).toBe(37);
			expect(
				telemetry
					.recentEvents()
					.some((event) => event.type === "gateway.routing"),
			).toBe(true);
		});
	}
	for (const provider of ["jev", "openai"])
		for (const failure of ["broken", "invalid", "slow"]) {
			it(`uses the configured fallback when ${provider} returns ${failure}`, async () => {
				await save({
					...base,
					auto: {
						...base.auto,
						enabled: true,
						decisionModel: `${provider}/${failure}`,
						timeoutMs: 100,
					},
				});
				const response = await chat("auto");
				expect(response.statusCode, response.body).toBe(200);
				expect(response.json()).toMatchObject({
					model: "backup/chat",
					routing: { decisionFallback: true },
				});
				expect(chatCalls).toEqual([
					{ model: "chat", authorization: "Bearer backup-secret" },
				]);
			});
		}
	it("can choose a pool and emits routing metadata before streaming", async () => {
		chosen = "pool/coding";
		await save({
			...base,
			pools: [pool()],
			auto: {
				...base.auto,
				enabled: true,
				targets: [
					{ target: "pool/coding", description: "Coding" },
					base.auto.targets[1],
				],
			},
		});
		const response = await chat("auto", true);
		expect(response.statusCode).toBe(200);
		expect(response.body.indexOf('"type":"routing"')).toBeLessThan(
			response.body.indexOf('"type":"text-delta"'),
		);
		expect(response.body).toContain('"target":"pool/coding"');
		expect(response.body).toContain('"model":"work/chat"');
	});
});

describe("pool balancing and failover", () => {
	it("shares requests by weight across independent account credentials", async () => {
		await save({ ...base, pools: [pool()] });
		const served: string[] = [];
		for (let i = 0; i < 8; i++)
			served.push((await chat("pool/coding")).json().model);
		expect(served.filter((model) => model === "work/chat")).toHaveLength(6);
		expect(served.filter((model) => model === "backup/chat")).toHaveLength(2);
		expect(
			chatCalls.filter((call) => call.authorization === "Bearer backup-secret"),
		).toHaveLength(2);
		expect(selectorCalls).toHaveLength(0);
	});
	it("least requests avoids a busy member and returns to it after completion", async () => {
		await save({
			...base,
			pools: [
				{
					...pool("least-requests"),
					members: [
						{ model: "work/slow-model", weight: 1 },
						{ model: "backup/chat", weight: 1 },
					],
					failover: false,
				},
			],
		});
		const slow = chat("pool/coding").then((response) => response);
		await slowStarted;
		for (let i = 0; i < 2; i++)
			expect((await chat("pool/coding")).json().model).toBe("backup/chat");
		expect((await slow).json().model).toBe("work/slow-model");
		expect((await chat("pool/coding")).json().model).toBe("work/slow-model");
	});
	it("balances requests across different models and releases failed reservations", async () => {
		await save({
			...base,
			pools: [
				{
					...pool("least-requests"),
					members: [
						{ model: "work/broken-model", weight: 1 },
						{ model: "backup/chat", weight: 1 },
					],
				},
			],
		});
		for (let i = 0; i < 4; i++)
			expect((await chat("pool/coding")).json().model).toBe("backup/chat");
		expect(
			chatCalls.filter((call) => call.model === "broken-model"),
		).toHaveLength(2);
	});
	it("applies specific failover before the global policy and allows disabling it for a model", async () => {
		const config: RoutingConfig = {
			...base,
			failover: { enabled: true, targets: ["work/chat"], timeoutMs: 100 },
			rules: [
				{
					model: "work/broken-model",
					enabled: true,
					targets: ["backup/chat"],
					timeoutMs: 100,
				},
			],
		};
		await save(config);
		const response = await chat("work/broken-model");
		expect(response.json()).toMatchObject({
			model: "backup/chat",
			failover: {
				requestedModel: "work/broken-model",
				attempts: [{ model: "work/broken-model" }],
			},
		});
		await save({ ...config, rules: [{ ...config.rules[0], enabled: false }] });
		expect((await chat("work/broken-model")).statusCode).toBe(502);
	});
	it("pool rules override model rules and deduplicate fallback attempts", async () => {
		await save({
			...base,
			pools: [
				{
					...pool(),
					members: [{ model: "work/broken-model", weight: 1 }],
					failover: false,
				},
			],
			rules: [
				{
					model: "work/broken-model",
					enabled: true,
					targets: ["work/chat"],
					timeoutMs: 100,
				},
				{
					model: "pool/coding",
					enabled: true,
					targets: ["work/broken-model", "backup/chat"],
					timeoutMs: 100,
				},
			],
		});
		expect((await chat("pool/coding")).json().model).toBe("backup/chat");
		expect(chatCalls.map((call) => call.model)).toEqual([
			"broken-model",
			"chat",
		]);
	});
	for (const stream of [false, true]) {
		it(`times out pool members and fails over (stream=${stream})`, async () => {
			await save({
				...base,
				failover: { ...base.failover, timeoutMs: 100 },
				pools: [
					{
						...pool(),
						members: [
							{ model: "work/slow-model", weight: 1 },
							{ model: "backup/chat", weight: 1 },
						],
					},
				],
			});
			const response = await chat("pool/coding", stream);
			expect(response.statusCode).toBe(200);
			expect(response.body).toContain('"model":"backup/chat"');
			expect(response.body).toContain("timed out after 100ms");
		});
	}
	it("does not fail over after the first stream output", async () => {
		await save({
			...base,
			pools: [
				{
					...pool(),
					members: [
						{ model: "work/broken-stream-model", weight: 1 },
						{ model: "backup/chat", weight: 1 },
					],
				},
			],
		});
		const response = await chat("pool/coding", true);
		expect(response.body).toContain("partial ");
		expect(response.body).toContain('"type":"error"');
		expect(chatCalls).toHaveLength(1);
	});
});

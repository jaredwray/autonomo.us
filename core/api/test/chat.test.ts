import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { createServer } from "../src/server.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { type StubProvider, startStubProvider } from "./helpers.js";

describe("POST /v1/chat", () => {
	let provider: StubProvider;
	let telemetry: TelemetryService;
	let server: ReturnType<typeof createServer>;

	beforeAll(async () => {
		provider = await startStubProvider();
	});

	afterAll(async () => {
		await provider.close();
	});

	beforeEach(() => {
		telemetry = new TelemetryService();
		server = createServer({
			registry: provider.registry,
			telemetry,
			logger: false,
		});
	});

	afterEach(async () => {
		await server.close();
	});

	it("proxies a chat request and returns usage", async () => {
		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.model).toBe("stub/chat-model");
		expect(body.message).toEqual({
			role: "assistant",
			content: "Hello there",
		});
		expect(body.usage).toEqual({
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
		});
		expect(body.finishReason).toBe("stop");
		expect(body.id).toBeDefined();
	});

	it("records token usage telemetry for successful requests", async () => {
		await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/chat-model",
				agentId: "agent-7",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(1);
		expect(summary.totalTokens).toBe(15);
		expect(summary.byModel[0]).toMatchObject({
			model: "chat-model",
			provider: "stub",
			requests: 1,
			totalTokens: 15,
		});

		const [event] = telemetry.recentEvents();
		expect(event.type).toBe("gateway.chat");
		expect(event.agentId).toBe("agent-7");
		expect(event.data.model).toBe("stub/chat-model");
	});

	it("streams chat responses as SSE and records usage", async () => {
		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "Hi" }],
				stream: true,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("text/event-stream");
		// No Origin header on the request → no CORS header on the stream.
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();

		const events = response.body
			.split("\n\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice("data: ".length));
		expect(events.at(-1)).toBe("[DONE]");

		const parsed = events
			.filter((event) => event !== "[DONE]")
			.map((event) => JSON.parse(event));
		const text = parsed
			.filter((event) => event.type === "text-delta")
			.map((event) => event.text)
			.join("");
		expect(text).toBe("Hello world");

		const finish = parsed.find((event) => event.type === "finish");
		expect(finish.usage).toEqual({
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
		});
		expect(finish.model).toBe("stub/chat-model");

		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(1);
		expect(summary.totalTokens).toBe(15);
	});

	it("echoes allowed origins on the SSE path and omits others", async () => {
		const allowed = await server.inject({
			method: "POST",
			url: "/v1/chat",
			headers: { origin: "http://localhost:5173" },
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "Hi" }],
				stream: true,
			},
		});
		expect(allowed.headers["access-control-allow-origin"]).toBe(
			"http://localhost:5173",
		);

		const denied = await server.inject({
			method: "POST",
			url: "/v1/chat",
			headers: { origin: "https://evil.example" },
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "Hi" }],
				stream: true,
			},
		});
		expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("returns 404 for unknown providers", async () => {
		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "nope/some-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(404);
		expect(JSON.parse(response.body).error.type).toBe("unknown_model");
	});

	it("returns 400 for invalid bodies", async () => {
		const missingModel = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: { messages: [{ role: "user", content: "Hi" }] },
		});
		expect(missingModel.statusCode).toBe(400);

		const emptyMessages = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: { model: "stub/chat-model", messages: [] },
		});
		expect(emptyMessages.statusCode).toBe(400);

		const badRole = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "tool", content: "Hi" }],
			},
		});
		expect(badRole.statusCode).toBe(400);
	});

	it("returns 502 and records an error event when the provider fails", async () => {
		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/broken-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(502);
		expect(JSON.parse(response.body).error.type).toBe("provider_error");

		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(1);
		expect(summary.totalErrors).toBe(1);
		const [event] = telemetry.recentEvents();
		expect(event.type).toBe("gateway.error");
		expect(String(event.data.error)).toContain("provider exploded");
	});

	it("lists registered models and providers", async () => {
		const response = await server.inject({ method: "GET", url: "/v1/models" });

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.models).toEqual([
			{ id: "stub/chat-model", provider: "stub", model: "chat-model" },
		]);
		expect(body.providers).toEqual([
			{ name: "stub", kind: "openai-compatible" },
		]);
	});
});

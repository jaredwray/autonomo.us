import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";

// Real HTTP contract server; requests run through the production adapters.
describe("cloud adapters and model management", () => {
	let upstream: http.Server;
	let baseURL: string;
	let received: {
		url: string;
		headers: http.IncomingHttpHeaders;
		body: Record<string, unknown>;
	};
	const servers: ReturnType<typeof createServer>[] = [];
	beforeAll(async () => {
		upstream = http.createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				const body = JSON.parse(raw);
				received = { url: req.url ?? "", headers: req.headers, body };
				if (
					req.headers.authorization !== "Bearer test-provider-key" &&
					req.headers["x-goog-api-key"] !== "test-provider-key"
				) {
					res.writeHead(401, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								message: "Invalid API key",
								code: 401,
								status: "UNAUTHENTICATED",
							},
						}),
					);
					return;
				}
				if (req.url === "/v1/responses") {
					const message = {
						type: "message",
						id: "msg_test",
						role: "assistant",
						status: "completed",
						content: [
							{ type: "output_text", text: "Hello from Grok", annotations: [] },
						],
					};
					const response = {
						id: "resp_test",
						created_at: 1752768000,
						model: body.model,
						status: "completed",
						output: [message],
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					};
					res.writeHead(200, {
						"content-type": body.stream
							? "text/event-stream"
							: "application/json",
					});
					res.end(
						body.stream
							? [
									{ type: "response.created", response },
									{
										type: "response.output_item.added",
										output_index: 0,
										item: { ...message, content: [] },
									},
									{
										type: "response.output_text.delta",
										item_id: "msg_test",
										output_index: 0,
										delta: "Hello from Grok",
									},
									{
										type: "response.output_item.done",
										output_index: 0,
										item: message,
									},
									{ type: "response.completed", response },
								]
									.map((event) => `data: ${JSON.stringify(event)}\n\n`)
									.join("")
							: JSON.stringify(response),
					);
					return;
				}
				const google = req.url?.includes("/models/");
				const streaming =
					body.stream || req.url?.includes("streamGenerateContent");
				const response = google
					? {
							candidates: [
								{
									index: 0,
									content: {
										role: "model",
										parts: [{ text: "Hello from Gemini" }],
									},
									finishReason: "STOP",
								},
							],
							usageMetadata: {
								promptTokenCount: 10,
								candidatesTokenCount: 5,
								totalTokenCount: 15,
							},
							modelVersion: "gemini-test",
							responseId: "test-response",
						}
					: {
							id: "test-response",
							created: 1752768000,
							model: body.model,
							object: streaming ? "chat.completion.chunk" : "chat.completion",
							choices: [
								{
									index: 0,
									...(streaming
										? {
												delta: {
													role: "assistant",
													content: "Hello from Grok",
												},
											}
										: {
												message: {
													role: "assistant",
													content: "Hello from Grok",
												},
											}),
									finish_reason: "stop",
								},
							],
							usage: {
								prompt_tokens: 10,
								completion_tokens: 5,
								total_tokens: 15,
							},
							x_groq: {
								usage: {
									prompt_tokens: 10,
									completion_tokens: 5,
									total_tokens: 15,
								},
							},
						};
				res.writeHead(200, {
					"content-type": streaming ? "text/event-stream" : "application/json",
				});
				res.end(
					streaming
						? `data: ${JSON.stringify(response)}\n\n${google ? "" : "data: [DONE]\n\n"}`
						: JSON.stringify(response),
				);
			});
		});
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", resolve),
		);
		baseURL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
	});
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});
	afterAll(async () => {
		await new Promise<void>((resolve, reject) =>
			upstream.close((error) => (error ? reject(error) : resolve())),
		);
	});

	function gateway() {
		const server = createServer({
			config: configFromEnv({
				GOOGLE_BASE_URL: baseURL,
				XAI_BASE_URL: baseURL,
				OPENAI_BASE_URL: baseURL,
				GROQ_BASE_URL: baseURL,
				MISTRAL_BASE_URL: baseURL,
				DEEPSEEK_BASE_URL: baseURL,
				OPENROUTER_BASE_URL: baseURL,
				CLOUDFLARE_BASE_URL: baseURL,
				CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
			}),
			logger: false,
		});
		servers.push(server);
		return server;
	}

	for (const provider of [
		"google",
		"xai",
		"openai",
		"groq",
		"mistral",
		"deepseek",
		"openrouter",
		"cloudflare",
	] as const) {
		for (const stream of [false, true]) {
			it(`adds ${provider} at runtime and routes ${stream ? "streamed" : "non-streamed"} chat with authentication and usage`, async () => {
				const server = gateway();
				const model =
					provider === "cloudflare"
						? "@cf/vendor/test-model"
						: provider === "openrouter"
							? "vendor/test-model:free"
							: "test-model";
				const added = await server.inject({
					method: "POST",
					url: "/v1/models",
					payload: {
						provider,
						model,
						apiKey: "test-provider-key",
					},
				});
				expect(added.statusCode).toBe(200);
				const response = await server.inject({
					method: "POST",
					url: "/v1/chat",
					payload: {
						model: `${provider}/${model}`,
						messages: [{ role: "user", content: "Hi" }],
						stream,
					},
				});
				expect(response.statusCode).toBe(200);
				if (stream) {
					expect(response.body).toContain('"type":"text-delta"');
					expect(response.body).toContain('"totalTokens":15');
					expect(response.body).toContain("[DONE]");
				} else {
					expect(response.json().message.content).toBe(
						provider === "google" ? "Hello from Gemini" : "Hello from Grok",
					);
					expect(response.json().usage).toEqual({
						promptTokens: 10,
						completionTokens: 5,
						totalTokens: 15,
					});
				}
				if (provider === "google") {
					expect(received.url).toContain(
						`/models/test-model:${stream ? "streamGenerateContent" : "generateContent"}`,
					);
					expect(received.headers["x-goog-api-key"]).toBe("test-provider-key");
					expect(received.body.contents).toEqual([
						{ role: "user", parts: [{ text: "Hi" }] },
					]);
				} else {
					expect(received.url).toBe(
						provider === "openai" ? "/v1/responses" : "/v1/chat/completions",
					);
					expect(received.headers.authorization).toBe(
						"Bearer test-provider-key",
					);
					expect(received.body.model).toBe(model);
				}
			});
		}
	}

	it("validates provider, key and model without changing the active registry", async () => {
		const server = gateway();
		const before = (await server.inject("/v1/models")).body;
		for (const payload of [
			{ provider: "google", model: "test-model" },
			{ provider: "other", model: "test-model", apiKey: "key" },
			{ provider: "xai", model: " ", apiKey: "key" },
			{ provider: "xai", model: "test-model", apiKey: "   " },
		]) {
			expect(
				(await server.inject({ method: "POST", url: "/v1/models", payload }))
					.statusCode,
			).toBe(400);
		}
		expect((await server.inject("/v1/models")).body).toBe(before);
	});

	it("reuses saved keys, deduplicates models, and never returns credentials", async () => {
		const server = gateway();
		await server.inject({
			method: "POST",
			url: "/v1/models",
			payload: {
				provider: "xai",
				model: "test-model",
				apiKey: "test-provider-key",
			},
		});
		for (const model of ["second-model", "test-model"]) {
			const added = await server.inject({
				method: "POST",
				url: "/v1/models",
				payload: { provider: "xai", model },
			});
			expect(added.statusCode).toBe(200);
			expect(added.body).not.toContain("test-provider-key");
		}
		const listed = await server.inject("/v1/models");
		expect(
			listed
				.json()
				.models.filter(
					(model: { id: string }) => model.id === "xai/test-model",
				),
		).toHaveLength(1);
		const settings = await server.inject("/v1/providers");
		expect(settings.json().providers).toContainEqual({
			id: "xai",
			name: "xAI Grok",
			configured: true,
		});
		expect(settings.body).not.toContain("test-provider-key");
		expect(listed.body).not.toContain("test-provider-key");
		expect(settings.json().persistence).toBe("memory");
		const chat = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "xai/second-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});
		expect(chat.statusCode).toBe(200);
	});

	it("surfaces provider authentication failures", async () => {
		const server = gateway();
		await server.inject({
			method: "POST",
			url: "/v1/models",
			payload: {
				provider: "google",
				model: "test-model",
				apiKey: "invalid-key",
			},
		});
		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "google/test-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});
		expect(response.statusCode).toBe(502);
		expect(response.json().error.type).toBe("provider_error");
		expect(response.body).not.toContain("invalid-key");
	});
});

import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real OpenAI-compatible chat-completions server used as the test provider.
 * The gateway talks to it over actual HTTP through the production
 * `@ai-sdk/openai-compatible` wire path — request parsing, SSE framing, and
 * usage accounting are all exercised for real (the same protocol Ollama,
 * LM Studio, and vLLM speak). Failure modes are real too: models named
 * `broken-*` respond with a 500, `slow-model` stalls before answering (for
 * timeout/failover tests), and `broken-stream-model` drops the connection
 * mid-stream after emitting output.
 */

export const STUB_USAGE = {
	prompt_tokens: 10,
	completion_tokens: 5,
	total_tokens: 15,
};

export type OpenAIStub = {
	/** Base URL ending in /v1, ready for OPENAI_COMPAT_BASE_URL/config. */
	url: string;
	close(): Promise<void>;
};

export async function startOpenAIStub(): Promise<OpenAIStub> {
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (!req.url?.endsWith("/chat/completions")) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "not found" } }));
				return;
			}
			const parsed = JSON.parse(body || "{}") as {
				model?: string;
				stream?: boolean;
			};
			if (
				parsed.model?.startsWith("broken-") &&
				parsed.model !== "broken-stream-model"
			) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "provider exploded" } }));
				return;
			}
			const base = {
				id: "cmpl-stub-1",
				created: 1752768000,
				model: parsed.model,
			};
			if (parsed.model === "broken-stream-model") {
				// Emits output, then kills the socket: a failure after the response
				// is already committed, so the gateway must not fail over.
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				});
				res.write(
					`data: ${JSON.stringify({
						...base,
						object: "chat.completion.chunk",
						choices: [
							{ index: 0, delta: { role: "assistant" }, finish_reason: null },
						],
					})}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({
						...base,
						object: "chat.completion.chunk",
						choices: [
							{ index: 0, delta: { content: "partial " }, finish_reason: null },
						],
					})}\n\n`,
				);
				// Let the chunks flush before the reset so the client sees them.
				const killTimer = setTimeout(() => res.destroy(), 50);
				res.on("close", () => clearTimeout(killTimer));
				return;
			}
			if (parsed.model === "slow-model") {
				// Stalls long enough to trip any sub-second attempt timeout, then
				// answers normally (in case no timeout was armed).
				const slowTimer = setTimeout(() => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							...base,
							object: "chat.completion",
							choices: [
								{
									index: 0,
									message: { role: "assistant", content: "Slow reply" },
									finish_reason: "stop",
								},
							],
							usage: STUB_USAGE,
						}),
					);
				}, 1500);
				res.on("close", () => clearTimeout(slowTimer));
				return;
			}
			if (parsed.stream) {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				});
				const chunk = (delta: Record<string, unknown>) =>
					res.write(
						`data: ${JSON.stringify({
							...base,
							object: "chat.completion.chunk",
							choices: [{ index: 0, delta, finish_reason: null }],
						})}\n\n`,
					);
				chunk({ role: "assistant" });
				chunk({ content: "Hello " });
				chunk({ content: "world" });
				res.write(
					`data: ${JSON.stringify({
						...base,
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: STUB_USAGE,
					})}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
			} else {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						...base,
						object: "chat.completion",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "Hello there" },
								finish_reason: "stop",
							},
						],
						usage: STUB_USAGE,
					}),
				);
			}
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}/v1`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

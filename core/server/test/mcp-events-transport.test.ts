import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	nodeWebhookTransport,
	type WebhookRequest,
} from "../src/agent-webhooks/delivery.js";

vi.mock("node:https", () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const request: WebhookRequest = {
	url: new URL("https://receiver.example.com/callback"),
	address: { address: "8.8.8.8", family: 4 },
	headers: { "webhook-id": "verification", "content-type": "application/json" },
	body: '{"type":"verification","challenge":"abc"}',
	signal: new AbortController().signal,
	responseLimit: 4096,
};
function fakeResponse(chunks: string[], status = 200) {
	let sent = "";
	let options: RequestOptions | undefined;
	const response = Object.assign(new EventEmitter(), {
		statusCode: status,
		headers: {},
		destroy: vi.fn((error?: Error) => {
			if (error) response.emit("error", error);
		}),
	});
	const client = Object.assign(new EventEmitter(), {
		end: (body: string) => {
			sent = body;
		},
	});
	const implementation = (
		_url: URL,
		opts: RequestOptions,
		callback: (res: IncomingMessage) => void,
	) => {
		options = opts;
		client.end = (body) => {
			sent = body;
			callback(response as unknown as IncomingMessage);
			for (const chunk of chunks) response.emit("data", Buffer.from(chunk));
			response.emit("end");
		};
		return client as unknown as ClientRequest;
	};
	vi.mocked(httpsRequest).mockImplementation(
		implementation as unknown as typeof httpsRequest,
	);
	return { response, options: () => options, sent: () => sent };
}
describe("pinned Node MCP callback transport", () => {
	it("pins the checked address, retains TLS hostname verification and sends exact bytes", async () => {
		const f = fakeResponse(['{"challenge":', '"abc"}']);
		const result = await nodeWebhookTransport()(request);
		expect(result).toMatchObject({ status: 200, body: '{"challenge":"abc"}' });
		expect(f.sent()).toBe(request.body);
		const options = f.options();
		expect(options).toMatchObject({
			servername: "receiver.example.com",
			agent: false,
			method: "POST",
		});
		expect(options?.rejectUnauthorized).not.toBe(false);
		const callback = vi.fn();
		options?.lookup?.("receiver.example.com", { all: true }, callback);
		expect(callback).toHaveBeenCalledWith(null, [
			{ address: "8.8.8.8", family: 4 },
		]);
	});
	it("bounds verification response bytes and preserves existing body-discarding behavior", async () => {
		const oversized = fakeResponse(["x".repeat(4097)]);
		await expect(nodeWebhookTransport()(request)).rejects.toThrow("too large");
		expect(oversized.response.destroy).toHaveBeenCalled();
		const old = fakeResponse(["unread"]);
		expect(
			await nodeWebhookTransport()({ ...request, responseLimit: undefined }),
		).toEqual({ status: 200, retryAfter: null });
		expect(old.response.destroy).toHaveBeenCalled();
	});
	it("returns redirects without issuing another request", async () => {
		fakeResponse(["{}"], 302);
		expect((await nodeWebhookTransport()(request)).status).toBe(302);
		expect(httpsRequest).toHaveBeenCalledTimes(1);
	});
});

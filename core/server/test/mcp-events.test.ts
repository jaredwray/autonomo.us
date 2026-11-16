import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	request as httpsRequest,
	createServer as httpsServer,
} from "node:https";
import type { AddressInfo } from "node:net";
import type { Channel, ChannelMessage } from "@autonomo.us/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	newSecret,
	type WebhookRequest,
} from "../src/agent-webhooks/delivery.js";
import type { McpAgent } from "../src/mcp/server.js";
import {
	Callback,
	callbackUrl,
	validSecret,
} from "../src/mcp-events/callback.js";
import { McpEvents, subscriptionId } from "../src/mcp-events/events.js";
import { MemoryEventRepository, mutate } from "../src/mcp-events/repository.js";
import { settleBackgroundWork } from "../src/server.js";
import { startChannels } from "./channel-helpers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});
const resolver = async () => [{ address: "8.8.8.8", family: 4 as const }];
const secret = newSecret();
const url = "https://receiver.example.com/events/token-in-path";
function receiver(status = 200) {
	const requests: WebhookRequest[] = [];
	const send = vi.fn(async (request: WebhookRequest) => {
		requests.push(request);
		const body = JSON.parse(request.body);
		return {
			status: body.type === "verification" ? 200 : status,
			retryAfter: null,
			body: JSON.stringify({ challenge: body.challenge }),
		};
	});
	return { requests, transport: Object.assign(send, { pinsAddress: true }) };
}
/** Real TLS callback receiver with a fixture CA. Only the test adapter maps the
 * validated public address onto loopback; production never makes this mapping. */
async function networkReceiver() {
	const cert = readFileSync(
		new URL("./fixtures/mcp-events/cert.pem", import.meta.url),
	);
	const key = readFileSync(
		new URL("./fixtures/mcp-events/key.pem", import.meta.url),
	);
	const requests: WebhookRequest[] = [];
	const server = httpsServer({ cert, key }, (request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			const expected = `v1,${createHmac(
				"sha256",
				Buffer.from(secret.slice(6), "base64"),
			)
				.update(
					`${request.headers["webhook-id"]}.${request.headers["webhook-timestamp"]}.${raw}`,
				)
				.digest("base64")}`;
			if (request.headers["webhook-signature"] !== expected) {
				response.writeHead(401).end();
				return;
			}
			const body = JSON.parse(raw);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify(
					body.type === "verification" ? { challenge: body.challenge } : {},
				),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	);
	const port = (server.address() as AddressInfo).port;
	const transport = Object.assign(
		async (input: WebhookRequest) => {
			requests.push(input);
			return new Promise<{ status: number; retryAfter: null; body: string }>(
				(resolve, reject) => {
					const request = httpsRequest(
						{
							host: "127.0.0.1",
							port,
							servername: input.url.hostname,
							ca: cert,
							method: "POST",
							path: input.url.pathname,
							headers: input.headers,
							signal: input.signal,
							agent: false,
						},
						(response) => {
							let body = "";
							response.on("data", (chunk) => {
								body += chunk;
							});
							response.on("end", () =>
								resolve({
									status: response.statusCode ?? 0,
									retryAfter: null,
									body,
								}),
							);
							response.on("error", reject);
						},
					);
					request.on("error", reject);
					request.end(input.body);
				},
			);
		},
		{ pinsAddress: true },
	);
	return { requests, transport };
}
const params = (channel_id = "channel", extra = {}) => ({
	name: "channel.message",
	arguments: { channel_id },
	delivery: { mode: "webhook", url, secret },
	...extra,
});
const agent = {
	token: { id: "agent", name: "Agent", permissions: ["mcp:read", "mcp:call"] },
	workspace: { id: "workspace" },
} as McpAgent;
const channel = {
	id: "channel",
	workspaceId: "workspace",
	archivedAt: null,
} as Channel;
const message = (id = "message") =>
	({
		id,
		seq: 1,
		createdAt: "2026-11-16T00:00:00.000Z",
		deletedAt: null,
		threadId: null,
		author: { kind: "user", id: "user", name: "Person" },
		mentions: [],
	}) as unknown as ChannelMessage;
function fixture(status = 200) {
	const repository = new MemoryEventRepository();
	const received = receiver(status);
	const authorized = vi.fn(async () => true);
	let now = Date.parse("2026-11-16T00:00:00Z");
	const options = {
		repository,
		callback: new Callback(received.transport, resolver),
		authorized,
		threadAuthor: async () => ({ kind: "agent", id: "agent" }),
		now: () => now,
	};
	return {
		...received,
		repository,
		authorized,
		options,
		events: new McpEvents(options),
		advance: (ms: number) => {
			now += ms;
		},
	};
}
function verifySignature(request: WebhookRequest, key = secret) {
	const expected = createHmac("sha256", Buffer.from(key.slice(6), "base64"))
		.update(
			`${request.headers["webhook-id"]}.${request.headers["webhook-timestamp"]}.${request.body}`,
		)
		.digest("base64");
	expect(request.headers["webhook-signature"].split(" ")).toContain(
		`v1,${expected}`,
	);
}

describe("MCP Events", () => {
	it("subscribes through authenticated HTTP, verifies, filters, delivers, reads and unsubscribes", async () => {
		const received = await networkReceiver();
		const repository = new MemoryEventRepository();
		const app = await startChannels(
			cleanups,
			{},
			{ mcpEvents: { repository, transport: received.transport, resolver } },
		);
		const bot = await app.agent("ChatGPT dot");
		const target = await app.createChannel("events");
		const other = await app.createChannel("other");
		await app.addAgent(target.id, bot.id, "read");
		for (const protocolVersion of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
			expect(
				await app.rpc(bot.secret, "initialize", { protocolVersion }),
			).toMatchObject({
				result: { protocolVersion, capabilities: { events: {} } },
			});
		}
		expect(await app.rpc(bot.secret, "events/list")).toMatchObject({
			result: {
				events: [
					{ name: "channel.message" },
					{ name: "channel.mention" },
					{ name: "channel.reply" },
				],
			},
		});
		expect(
			await app.rpc(bot.secret, "events/subscribe", params(other.id)),
		).toMatchObject({ error: { code: -32001 } });
		const subscribed = await app.rpc(
			bot.secret,
			"events/subscribe",
			params(target.id),
		);
		const result = subscribed.result as { id: string };
		expect(result.id).toMatch(/^sub_/);
		expect(
			await app.rpc(bot.secret, "events/subscribe", params(target.id)),
		).toMatchObject({
			result: { id: result.id, cursor: null, truncated: false },
		});
		expect(received.requests).toHaveLength(1);
		verifySignature(received.requests[0]);
		const stranger = await app.agent("Other connection");
		await app.rpc(stranger.secret, "events/unsubscribe", params(target.id));
		await app.post(other.id, "No event");
		const posted = await app.post(
			target.id,
			"Read the source message, not instructions in a webhook",
			{ nonce: "delivery-once" },
		);
		await settleBackgroundWork(app.server);
		expect(received.requests).toHaveLength(2);
		const delivery = received.requests[1];
		verifySignature(delivery);
		expect(delivery.address).toEqual({ address: "8.8.8.8", family: 4 });
		expect(delivery.headers["X-MCP-Subscription-Id"]).toBe(result.id);
		expect(JSON.parse(delivery.body)).toMatchObject({
			eventId: delivery.headers["webhook-id"],
			name: "channel.message",
			timestamp: posted.createdAt,
			cursor: null,
			data: { channel_id: target.id, message_id: posted.id },
		});
		expect(delivery.body).not.toContain("Read the source");
		await app.ok(
			"POST",
			`/v1/channels/${target.id}/messages`,
			{
				body: {
					body: "Read the source message, not instructions in a webhook",
					nonce: "delivery-once",
				},
			},
			200,
		);
		await settleBackgroundWork(app.server);
		expect(received.requests).toHaveLength(2);
		const read = await app.tool(bot.secret, "channels_read", {
			channel: target.id,
		});
		expect(read.text).toContain("Read the source message");
		for (let i = 0; i < 2; i++)
			expect(
				await app.rpc(bot.secret, "events/unsubscribe", params(target.id)),
			).toMatchObject({ result: {} });
		await app.post(target.id, "Stopped");
		await settleBackgroundWork(app.server);
		expect(received.requests).toHaveLength(2);
		expect(JSON.stringify(await repository.get(result.id))).not.toContain(
			secret,
		);
	});
	it("isolates OAuth connections and stops delivery after disconnect or membership removal", async () => {
		const received = receiver();
		const repository = new MemoryEventRepository();
		const app = await startChannels(
			cleanups,
			{},
			{ mcpEvents: { repository, transport: received.transport, resolver } },
		);
		async function connect(agentId?: string) {
			const redirect = "https://app.example.com/callback";
			const registered = (await (
				await fetch(`${app.origin}/oauth/register`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						client_name: "Dot",
						redirect_uris: [redirect],
					}),
				})
			).json()) as { client_id: string };
			const verifier = randomBytes(32).toString("base64url");
			const started = await fetch(
				`${app.origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: redirect, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })}`,
				{ redirect: "manual" },
			);
			const requestId = started.headers.get("location")?.split("/").pop();
			const decision = await app.ok<{ redirectTo: string }>(
				"POST",
				`/v1/oauth/sign-ins/${requestId}/approve`,
				{
					body: agentId
						? { agentId }
						: {
								agent: {
									name: "OAuth dot",
									description: "",
									permissions: ["mcp:read", "mcp:call"],
								},
							},
				},
			);
			const response = await fetch(`${app.origin}/oauth/token`, {
				method: "POST",
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: registered.client_id,
					redirect_uri: redirect,
					code: new URL(decision.redirectTo).searchParams.get("code") as string,
					code_verifier: verifier,
				}),
			});
			expect(response.status).toBe(200);
			return ((await response.json()) as { access_token: string }).access_token;
		}
		const first = await connect();
		const listed = await app.ok<{
			agents: Array<{ id: string; name: string }>;
		}>("GET", "/v1/agents");
		const id = listed.agents.find((x) => x.name === "OAuth dot")?.id as string;
		const second = await connect(id);
		const channel = await app.createChannel("oauth-events");
		await app.addAgent(channel.id, id);
		const one = (await app.rpc(first, "events/subscribe", params(channel.id)))
			.result as { id: string };
		const two = (await app.rpc(second, "events/subscribe", params(channel.id)))
			.result as { id: string };
		expect(one.id).not.toBe(two.id);
		const stored = await repository.get(one.id);
		expect(stored?.grantId).toBeTruthy();
		await app.ok(
			"DELETE",
			`/v1/agents/${id}/connections/${stored?.grantId}`,
			{},
			204,
		);
		await app.post(channel.id, "Only the second app is connected");
		await settleBackgroundWork(app.server);
		expect(
			received.requests.filter((x) => JSON.parse(x.body).name),
		).toHaveLength(1);
		expect(received.requests.at(-1)?.headers["X-MCP-Subscription-Id"]).toBe(
			two.id,
		);
		await app.ok("DELETE", `/v1/channels/${channel.id}/agents/${id}`);
		await app.post(channel.id, "No longer a channel member");
		await settleBackgroundWork(app.server);
		expect(
			received.requests.filter((x) => JSON.parse(x.body).name),
		).toHaveLength(1);
	});

	it("does not advertise ephemeral or unpinned production support", async () => {
		const app = await startChannels(cleanups);
		const bot = await app.agent("Dot");
		expect((await app.rpc(bot.secret, "initialize")).result).not.toHaveProperty(
			"capabilities.events",
		);
		expect(await app.rpc(bot.secret, "events/list")).toMatchObject({
			error: { code: -32601 },
		});
		expect(
			() =>
				new Callback(
					Object.assign(async () => ({ status: 200, retryAfter: null }), {
						pinsAddress: false,
					}),
				),
		).toThrow(/pinning/);
	});
	it("canonicalizes arguments and isolates workspace, agent and OAuth connection identity", () => {
		const args = { channel_id: "channel", thread_id: "thread" };
		const id = subscriptionId(agent, url, "channel.message", args);
		expect(
			subscriptionId(agent, url, "channel.message", {
				thread_id: "thread",
				channel_id: "channel",
			}),
		).toBe(id);
		expect(
			subscriptionId(
				{ ...agent, grantId: "connection" },
				url,
				"channel.message",
				args,
			),
		).not.toBe(id);
		expect(
			subscriptionId(
				{ ...agent, token: { ...agent.token, id: "other" } },
				url,
				"channel.message",
				args,
			),
		).not.toBe(id);
	});
	it("renews after service restart, bounds TTL and verifies replacement signing keys", async () => {
		const f = fixture();
		const first = await f.events.handle(agent, "events/subscribe", params());
		const id = (first as { id: string }).id;
		f.advance(1000);
		const restarted = new McpEvents(f.options);
		const renewed = await restarted.handle(
			agent,
			"events/subscribe",
			params("channel", { ttlMs: 5000 }),
		);
		expect(renewed).toMatchObject({
			id,
			refreshBefore: "2026-11-16T00:00:06.000Z",
		});
		expect(f.requests).toHaveLength(1);
		const replacement = newSecret();
		await restarted.handle(
			agent,
			"events/subscribe",
			params("channel", {
				ttlMs: null,
				delivery: { mode: "webhook", url, secret: replacement },
			}),
		);
		expect(f.requests).toHaveLength(2);
		await restarted.onMessage(channel, message());
		await restarted.idle();
		verifySignature(f.requests[2], replacement);
		verifySignature(f.requests[2], secret);
		f.advance(86400001);
		await restarted.onMessage(channel, message("expired"));
		await restarted.idle();
		expect(f.requests).toHaveLength(3);
	});
	it("retries durably across restart with stable bytes and ID, fresh signatures and bounded attempts", async () => {
		const f = fixture(503);
		await f.events.handle(agent, "events/subscribe", params());
		await f.events.onMessage(channel, message());
		await f.events.idle();
		const first = f.requests[1];
		f.advance(1000);
		const restarted = new McpEvents(f.options);
		await restarted.sweep();
		expect(f.requests[2].body).toBe(first.body);
		expect(f.requests[2].headers["webhook-id"]).toBe(
			first.headers["webhook-id"],
		);
		expect(f.requests[2].headers["webhook-timestamp"]).not.toBe(
			first.headers["webhook-timestamp"],
		);
		verifySignature(f.requests[2]);
		for (let i = 0; i < 8; i++) {
			f.advance(600001);
			await restarted.sweep();
		}
		expect(f.requests).toHaveLength(7); // verification plus six attempts
	});
	it("coordinates overlapping scheduled replicas and recovers an expired crash lease", async () => {
		const f = fixture();
		const result = (await f.events.handle(
			agent,
			"events/subscribe",
			params(),
		)) as { id: string };
		// Persist without starting delivery, as if the process died after enqueue.
		vi.spyOn(f.events, "catchUp").mockImplementation(() => {});
		await f.events.onMessage(channel, message("queued-1"));
		await f.events.onMessage(channel, message("queued-2"));
		await mutate(f.repository, result.id, (row) => ({
			...row,
			leaseId: "crashed-owner",
			leaseUntil: Date.parse("2026-11-16T00:01:00Z"),
		}));
		const first = new McpEvents(f.options);
		const second = new McpEvents(f.options);
		await Promise.all([first.sweep(1), second.sweep(1)]);
		expect(f.requests).toHaveLength(1); // challenge only while lease is held
		f.advance(60_001);
		await Promise.all([first.sweep(1), second.sweep(1)]);
		expect(f.requests).toHaveLength(2);
		expect((await f.repository.get(result.id))?.queue).toHaveLength(1);
		await first.sweep(1);
		expect(f.requests).toHaveLength(3);
		expect((await f.repository.get(result.id))?.queue).toHaveLength(0);
		await first.onMessage(channel, message("queued-1"));
		await first.idle();
		expect(f.requests).toHaveLength(3); // durable producer dedup after restart
	});
	it.each([
		410, 413, 400,
	])("never retries permanent HTTP %s", async (status) => {
		const f = fixture(status);
		await f.events.handle(agent, "events/subscribe", params());
		await f.events.onMessage(channel, message());
		await f.events.idle();
		f.advance(600001);
		await f.events.sweep();
		expect(f.requests).toHaveLength(2);
	});
	it("stops queued delivery after access revocation and does not leak credentials", async () => {
		const f = fixture(500);
		const result = (await f.events.handle(
			agent,
			"events/subscribe",
			params(),
		)) as { id: string };
		await f.events.onMessage(channel, message());
		await f.events.idle();
		f.authorized.mockResolvedValue(false);
		f.advance(1000);
		await f.events.sweep();
		expect(f.requests).toHaveLength(2);
		expect(await f.repository.get(result.id)).toMatchObject({
			active: false,
			secret: "",
			queue: [],
		});
	});
	it("filters mentions and threads, ignores self messages and agent-to-agent chatter", async () => {
		const f = fixture();
		await f.events.handle(
			agent,
			"events/subscribe",
			params("channel", {
				name: "channel.mention",
				arguments: { channel_id: "channel", thread_id: "thread" },
			}),
		);
		await f.events.onMessage(channel, message());
		const mention = {
			...message("mention"),
			threadId: "thread",
			mentions: [{ kind: "agent" as const, id: "agent" }],
		};
		await f.events.onMessage(channel, {
			...mention,
			author: { kind: "agent", id: "agent", name: "Self" },
		});
		await f.events.onMessage(channel, mention);
		await f.events.idle();
		expect(f.requests).toHaveLength(2);
	});
	it("rejects malformed inputs and returns only sanitized callback errors", async () => {
		const f = fixture();
		for (const extra of [
			{ ttlMs: 0 },
			{ ttlMs: -1 },
			{ cursor: "replay" },
			{ name: "unknown" },
			{ arguments: { channel_id: "channel", extra: true } },
			{ delivery: { mode: "webhook", url, secret: "invalid" } },
		]) {
			await expect(
				f.events.handle(agent, "events/subscribe", params("channel", extra)),
			).rejects.toMatchObject({ code: -32602 });
		}
		f.transport.mockImplementation(async () => {
			throw new Error(`secret=${secret} url=${url}`);
		});
		await expect(
			f.events.handle(agent, "events/subscribe", params()),
		).rejects.toMatchObject({ code: -32015, data: { reason: "unreachable" } });
		expect(f.requests).toHaveLength(0);
	});
});

describe("callback security", () => {
	it.each([
		"http://receiver.example.com/",
		"https://user:pass@receiver.example.com/",
		"https://127.0.0.1/",
		"https://169.254.169.254/",
		"https://[::1]/",
		"https://receiver.example.com/#secret",
		"https://localhost/",
	])("blocks unsafe URL %s", (raw) => {
		expect(() => callbackUrl(raw)).toThrow();
	});
	it("requires a canonical base64 signing key of 24–64 bytes", () => {
		expect(validSecret(secret)).toBe(true);
		for (const n of [0, 23, 65])
			expect(validSecret(`whsec_${Buffer.alloc(n).toString("base64")}`)).toBe(
				false,
			);
		expect(validSecret(`${secret}!`)).toBe(false);
	});
	it("rechecks DNS for every attempt and blocks mixed public/private and rebinding answers", async () => {
		const f = receiver();
		const dns = vi.fn(resolver);
		const callback = new Callback(f.transport, dns);
		await callback.verify({ id: "sub", url, secret }, Date.now());
		dns.mockResolvedValue([
			{ address: "8.8.8.8", family: 4 },
			{ address: "127.0.0.1", family: 4 },
		]);
		await expect(
			callback.post({ id: "sub", url, secret }, "event", "{}", Date.now()),
		).rejects.toMatchObject({ code: -32015 });
		expect(f.requests).toHaveLength(1);
	});
	it("refuses redirects, bad challenges and invalid response bodies", async () => {
		for (const response of [
			{ status: 302, body: "{}" },
			{ status: 200, body: '{"challenge":"wrong"}' },
			{ status: 200, body: "invalid" },
		]) {
			const transport = Object.assign(
				async () => ({ ...response, retryAfter: null }),
				{ pinsAddress: true },
			);
			await expect(
				new Callback(transport, resolver).verify(
					{ id: "sub", url, secret },
					Date.now(),
				),
			).rejects.toMatchObject({
				code: -32015,
				data: { reason: "challenge_failed" },
			});
		}
	});
});

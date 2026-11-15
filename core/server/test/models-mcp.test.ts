import type { GatewayResponse, RoutingConfig } from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelList } from "../src/models/mcp.js";
import { startChannels } from "./channel-helpers.js";
import { startOpenAIStub } from "./openai-stub.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

type StubRequest = Parameters<
	NonNullable<Parameters<typeof startOpenAIStub>[0]>["onRequest"] & object
>[0];

const CHAT = ["mcp:read", "mcp:call", "inference:run"];

/** A gateway whose workspace has one connection: a real stub provider. */
async function start() {
	const requests: StubRequest[] = [];
	const stub = await startOpenAIStub({
		onRequest: (body) => requests.push(body),
	});
	cleanups.push(stub.close);
	const api = await startChannels(cleanups, {
		providers: [
			{
				name: "stub",
				kind: "openai-compatible",
				baseURL: stub.url,
				models: ["chat-model", "echo-model", "broken-model"],
			},
		],
	});
	/** Changes the workspace's routing, starting from what it has. */
	const route = async (change: Partial<RoutingConfig>) => {
		const { config } = await api.ok<{ config: RoutingConfig }>(
			"GET",
			"/v1/routing",
		);
		await api.ok("PUT", "/v1/routing", { body: { ...config, ...change } });
	};
	/** A models_chat call. */
	const chat = (secret: string, args: Record<string, unknown>) =>
		api.tool<GatewayResponse>(secret, "models_chat", args);
	return { ...api, requests, route, chat };
}

describe("models for agents over MCP", () => {
	it("lists the model tools and tells agents what they do", async () => {
		const { agent, rpc } = await start();
		const bot = await agent("Scout");
		const tools = (
			(await rpc(bot.secret, "tools/list")).result as {
				tools: Array<{ name: string }>;
			}
		).tools.filter((tool) => tool.name.startsWith("models_"));
		expect(tools.map((tool) => tool.name)).toEqual([
			"models_list",
			"models_chat",
		]);
		const instructions = (
			(await rpc(bot.secret, "initialize", {})).result as {
				instructions: string;
			}
		).instructions;
		expect(instructions).toContain("models_chat");
		expect(instructions).toContain("inference:run");
	});

	it("lists the workspace's chat models and pools, and says when the agent cannot call them", async () => {
		const { agent, tool, route } = await start();
		await route({
			pools: [
				{
					id: "fast",
					strategy: "weighted-round-robin",
					members: [
						{ model: "stub/chat-model", weight: 1 },
						{ model: "stub/echo-model", weight: 1 },
					],
					failover: true,
				},
			],
		});
		const watcher = await agent("Watcher");
		const listed = await tool<ModelList>(watcher.secret, "models_list");
		expect(listed.isError).toBe(false);
		expect(listed.data.models.map((model) => model.id)).toEqual([
			"stub/chat-model",
			"stub/echo-model",
			"stub/broken-model",
		]);
		expect(listed.data.pools).toEqual([
			{
				id: "pool/fast",
				strategy: "weighted-round-robin",
				members: ["stub/chat-model", "stub/echo-model"],
			},
		]);
		expect(listed.data.auto).toBeNull();
		expect(listed.data.canChat).toBe(false);
		expect(listed.text).toContain("- stub/echo-model");
		expect(listed.text).toContain(
			"- pool/fast: stub/chat-model, stub/echo-model",
		);
		expect(listed.text).toContain("inference:run");

		const caller = await agent("Caller", CHAT);
		const granted = await tool<ModelList>(caller.secret, "models_list");
		expect(granted.data.canChat).toBe(true);
		expect(granted.text).not.toContain("inference:run");
	});

	it("needs the inference:run grant to call a model", async () => {
		const { agent, rpc, requests } = await start();
		const bot = await agent("Scout");
		const refused = await rpc(bot.secret, "tools/call", {
			name: "models_chat",
			arguments: { model: "stub/echo-model", prompt: "hi" },
		});
		expect(refused.error?.code).toBe(-32001);
		expect(refused.error?.message).toContain("inference:run");
		expect(requests).toHaveLength(0);
	});

	it("calls a model with the agent's prompt and records the usage under the agent", async () => {
		const { agent, chat, ok, requests } = await start();
		const caller = await agent("Caller", CHAT);
		const reply = await chat(caller.secret, {
			model: "stub/echo-model",
			system: "Answer briefly.",
			prompt: "When is the launch?",
			temperature: 0.2,
			maxTokens: 50,
		});
		expect(reply.isError).toBe(false);
		expect(reply.data).toMatchObject({
			model: "stub/echo-model",
			message: { role: "assistant", content: "Echo: When is the launch?" },
			usage: { totalTokens: 15 },
		});
		expect(reply.text).toMatch(/^Answered by stub\/echo-model\. 15 tokens/);
		expect(reply.text).toContain("Echo: When is the launch?");
		expect(requests.at(-1)).toMatchObject({
			model: "echo-model",
			temperature: 0.2,
			max_tokens: 50,
			messages: [
				{ role: "system", content: "Answer briefly." },
				{ role: "user", content: "When is the launch?" },
			],
		});

		const usage = await ok<{
			events: Array<{ data: Record<string, unknown> }>;
		}>("GET", "/v1/telemetry/events");
		expect(usage.events[0].data).toMatchObject({
			model: "stub/echo-model",
			callerId: `agent:${caller.id}`,
			callerName: "Caller",
			callerKind: "agent",
		});
	});

	it("fails over the way the workspace's routing says", async () => {
		const { agent, chat, route } = await start();
		await route({
			failover: {
				enabled: true,
				targets: ["stub/echo-model"],
				timeoutMs: 5_000,
			},
		});
		const caller = await agent("Caller", CHAT);
		const reply = await chat(caller.secret, {
			model: "stub/broken-model",
			prompt: "still there?",
		});
		expect(reply.isError).toBe(false);
		expect(reply.data.model).toBe("stub/echo-model");
		expect(reply.data.failover?.requestedModel).toBe("stub/broken-model");
		expect(reply.text).toMatch(
			/^Answered by stub\/echo-model, after stub\/broken-model failed/,
		);
	});

	it("returns failures as tool errors the agent can act on", async () => {
		const { agent, chat, rpc } = await start();
		const caller = await agent("Caller", CHAT);
		const unknown = await chat(caller.secret, {
			model: "nowhere/model",
			prompt: "hi",
		});
		expect(unknown.isError).toBe(true);
		expect(unknown.text).toContain("models_list");
		const broken = await chat(caller.secret, {
			model: "stub/broken-model",
			prompt: "hi",
		});
		expect(broken.isError).toBe(true);
		expect(broken.text).toContain("The model call failed");
		const auto = await chat(caller.secret, {
			model: "auto",
			prompt: "hi",
		});
		expect(auto.isError).toBe(true);
		expect(auto.text).toContain("Auto routing is disabled");

		for (const [args, problem] of [
			[{ model: "stub/echo-model" }, "prompt is required"],
			[{ model: "stub/echo-model", prompt: "" }, "prompt must not be empty"],
			[
				{ model: "stub/echo-model", prompt: "hi", temperature: 3 },
				"temperature must be at most 2",
			],
			[
				{ model: "stub/echo-model", prompt: "hi", temperature: "warm" },
				"temperature must be a number",
			],
			[
				{ model: "stub/echo-model", prompt: "hi", maxTokens: 0 },
				"maxTokens must be at least 1",
			],
		] as const) {
			const response = await rpc(caller.secret, "tools/call", {
				name: "models_chat",
				arguments: args,
			});
			expect(response.error?.message).toContain(problem);
		}
	});
});

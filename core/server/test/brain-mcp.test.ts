import type { ApiTokenSecret, BrainNoteView } from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import type { MCP_TOOLS } from "../src/brain/mcp.js";
import { createServer } from "../src/server.js";
import { completeSetup, joinWithInvite } from "./auth-helpers.js";

const ALLOWED_ORIGIN = "http://localhost:5173";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

type Rpc = {
	status: number;
	body: Record<string, unknown> | null;
	headers: Headers;
};
type ToolResult = {
	content: Array<{ type: string; text: string }>;
	structuredContent?: unknown;
	isError?: boolean;
};

async function start() {
	const server = createServer({
		config: {
			providers: [],
			corsOrigins: [ALLOWED_ORIGIN],
			brainTimeZone: "UTC",
		},
		logger: false,
	});
	cleanups.push(() => server.close());
	const origin = await server.listen({ port: 0, host: "127.0.0.1" });
	const owner = await completeSetup(server);
	const rest = async (
		method: string,
		path: string,
		body?: unknown,
		token = owner.token,
	) => {
		const response = await fetch(`${origin}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return {
			status: response.status,
			json: await response.json().catch(() => null),
		};
	};
	const agentToken = async (name: string, permissions: string[]) => {
		const created = await rest("POST", "/v1/agent-tokens", {
			name,
			description: "",
			ttlDays: 7,
			permissions,
		});
		expect(created.status).toBe(201);
		return created.json as ApiTokenSecret;
	};
	const post = async (
		payload: string,
		headers: Record<string, string> = {},
		method = "POST",
	): Promise<Rpc> => {
		const response = await fetch(`${origin}/mcp`, {
			method,
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...headers,
			},
			body: method === "POST" ? payload : undefined,
		});
		const text = await response.text();
		return {
			status: response.status,
			body: text ? JSON.parse(text) : null,
			headers: response.headers,
		};
	};
	const rpc = (
		secret: string,
		method: string,
		params?: unknown,
		id: unknown = 1,
	) =>
		post(JSON.stringify({ jsonrpc: "2.0", id, method, params }), {
			authorization: `Bearer ${secret}`,
		});
	const callTool = async (secret: string, name: string, args: unknown = {}) => {
		const response = await rpc(secret, "tools/call", { name, arguments: args });
		expect(response.status).toBe(200);
		const body = response.body as { result?: ToolResult; error?: unknown };
		if (body.error) throw new Error(JSON.stringify(body.error));
		return body.result as ToolResult;
	};
	return { server, origin, owner, rest, agentToken, post, rpc, callTool };
}

describe("MCP endpoint", () => {
	it("accepts only agent tokens, POST, and allowed origins", async () => {
		const { owner, rest, agentToken, post, rpc } = await start();
		const agent = await agentToken("Agent", ["mcp:read", "mcp:call"]);
		const initialize = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "ping",
		});
		const missing = await post(initialize);
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toBe("Bearer");
		expect(missing.body).toEqual({ error: { message: expect.any(String) } });
		expect(
			(await post(initialize, { authorization: `Bearer ${owner.token}` }))
				.status,
		).toBe(401);
		const api = await rest("POST", "/v1/api-tokens", {
			name: "API",
			description: "",
			ttlDays: 7,
			permissions: ["brain:edit"],
		});
		expect(
			(
				await post(initialize, {
					authorization: `Bearer ${(api.json as ApiTokenSecret).secret}`,
				})
			).status,
		).toBe(401);
		expect(
			(await post(initialize, { authorization: "Bearer agt_bogus" })).status,
		).toBe(401);
		expect(
			(await post(initialize, { authorization: `Basic ${agent.secret}` }))
				.status,
		).toBe(401);
		expect((await rpc(agent.secret, "ping")).status).toBe(200);
		for (const method of ["GET", "DELETE"]) {
			const refused = await post(
				"",
				{ authorization: `Bearer ${agent.secret}` },
				method,
			);
			expect(refused.status).toBe(405);
			expect(refused.headers.get("allow")).toBe("POST");
		}
		const badOrigin = await post(initialize, {
			authorization: `Bearer ${agent.secret}`,
			origin: "https://evil.example",
		});
		expect(badOrigin.status).toBe(403);
		const goodOrigin = await post(initialize, {
			authorization: `Bearer ${agent.secret}`,
			origin: ALLOWED_ORIGIN,
		});
		expect(goodOrigin.status).toBe(200);
		await rest("DELETE", `/v1/agent-tokens/${agent.token.id}`);
		expect((await rpc(agent.secret, "ping")).status).toBe(401);
	});

	it("speaks stateless JSON-RPC: initialize, ping, notifications, and protocol errors", async () => {
		const { agentToken, post, rpc } = await start();
		const agent = await agentToken("Agent", ["mcp:read", "mcp:call"]);
		const headers = { authorization: `Bearer ${agent.secret}` };
		const initialized = await rpc(agent.secret, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});
		expect(initialized.status).toBe(200);
		expect(initialized.headers.get("content-type")).toMatch(
			/application\/json/,
		);
		expect(initialized.body).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "autonomo.us", version: expect.any(String) },
				instructions: expect.stringContaining("brain_log"),
			},
		});
		const instructions = (initialized.body?.result as { instructions: string })
			.instructions;
		for (const rule of [
			"[[Title]]",
			"YYYY-MM-DD",
			"brain_propose",
			"Search before you write",
			"private",
		])
			expect(instructions).toContain(rule);
		const newer = await rpc(
			agent.secret,
			"initialize",
			{ protocolVersion: "2027-01-01" },
			"abc",
		);
		expect(newer.body).toMatchObject({
			id: "abc",
			result: { protocolVersion: "2025-11-25" },
		});
		expect((await rpc(agent.secret, "ping", undefined, 7)).body).toEqual({
			jsonrpc: "2.0",
			id: 7,
			result: {},
		});
		const notification = await post(
			JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			headers,
		);
		expect(notification.status).toBe(202);
		expect(notification.body).toBeNull();
		// A request sent without an id is refused, not acknowledged and dropped.
		const idless = await post(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "brain_create",
					arguments: { title: "Lost without an id" },
				},
			}),
			headers,
		);
		expect(idless.status).toBe(400);
		expect(idless.body).toMatchObject({
			id: null,
			error: { code: -32600, message: expect.stringMatching(/needs an id/) },
		});
		expect(
			(
				await rpc(agent.secret, "tools/call", {
					name: "brain_search",
					arguments: { query: "Lost without an id" },
				})
			).body,
		).toMatchObject({ result: { structuredContent: { total: 0 } } });
		const parse = await post("{not json", headers);
		expect(parse.status).toBe(400);
		expect(parse.body).toMatchObject({ id: null, error: { code: -32700 } });
		const batch = await post(
			JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
			headers,
		);
		expect(batch.status).toBe(400);
		expect(batch.body).toMatchObject({ error: { code: -32600 } });
		expect((await post(JSON.stringify("ping"), headers)).body).toMatchObject({
			error: { code: -32600 },
		});
		expect(
			(await post(JSON.stringify({ id: 1, method: "ping" }), headers)).body,
		).toMatchObject({
			error: { code: -32600 },
		});
		const unknown = await rpc(agent.secret, "resources/list");
		expect(unknown.status).toBe(200);
		expect(unknown.body).toMatchObject({ id: 1, error: { code: -32601 } });
	});

	it("checks mcp:read for tools/list and mcp:call for tools/call", async () => {
		const { agentToken, rpc } = await start();
		const reader = await agentToken("Reader", ["mcp:read"]);
		const caller = await agentToken("Caller", ["mcp:call"]);
		const none = await agentToken("None", []);
		const listed = await rpc(reader.secret, "tools/list");
		expect(listed.status).toBe(200);
		const tools = (listed.body?.result as { tools: typeof MCP_TOOLS }).tools;
		expect(tools.map((tool) => tool.name)).toEqual([
			"brain_search",
			"brain_read",
			"brain_create",
			"brain_update",
			"brain_append",
			"brain_delete",
			"brain_log",
			"brain_daily",
			"brain_unresolved",
			"brain_templates",
			"brain_propose",
			"brain_proposals",
		]);
		for (const tool of tools) {
			expect(tool.description.length).toBeGreaterThan(20);
			expect(tool.inputSchema).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
		}
		expect(
			tools.find((t) => t.name === "brain_propose")?.inputSchema.required,
		).toEqual(["action", "title", "reason"]);
		const denied = await rpc(caller.secret, "tools/list");
		expect(denied.status).toBe(200);
		expect(denied.body).toMatchObject({
			error: {
				code: -32001,
				message: expect.stringMatching(/MCP: Read.*mcp:read/),
			},
		});
		expect(
			(
				await rpc(reader.secret, "tools/call", {
					name: "brain_templates",
					arguments: {},
				})
			).body,
		).toMatchObject({
			error: { code: -32001, message: expect.stringMatching(/mcp:call/) },
		});
		expect((await rpc(none.secret, "tools/list")).body).toMatchObject({
			error: { code: -32001 },
		});
		expect((await rpc(none.secret, "initialize", {})).body).toMatchObject({
			result: { protocolVersion: "2025-11-25" },
		});
		expect(
			(
				await rpc(caller.secret, "tools/call", {
					name: "brain_nope",
					arguments: {},
				})
			).body,
		).toMatchObject({
			error: { code: -32602, message: expect.stringMatching(/Unknown tool/) },
		});
		expect(
			(
				await rpc(caller.secret, "tools/call", {
					name: "brain_read",
					arguments: {},
				})
			).body,
		).toMatchObject({
			error: {
				code: -32602,
				message: expect.stringMatching(/title is required/),
			},
		});
		expect(
			(
				await rpc(caller.secret, "tools/call", {
					name: "brain_read",
					arguments: { title: 1 },
				})
			).body,
		).toMatchObject({ error: { code: -32602 } });
		expect(
			(
				await rpc(caller.secret, "tools/call", {
					name: "brain_search",
					arguments: { limit: 51 },
				})
			).body,
		).toMatchObject({ error: { code: -32602 } });
		expect(
			(
				await rpc(caller.secret, "tools/call", {
					name: "brain_create",
					arguments: { title: "x", vault: "shared" },
				})
			).body,
		).toMatchObject({
			error: {
				code: -32602,
				message: expect.stringMatching(/unknown argument/),
			},
		});
		expect((await rpc(caller.secret, "tools/call", {})).body).toMatchObject({
			error: { code: -32602 },
		});
	});

	it("keeps each agent's vault private and returns structured plus text content", async () => {
		const { agentToken, callTool, rest } = await start();
		const alice = await agentToken("Alice", ["mcp:read", "mcp:call"]);
		const bob = await agentToken("Bob", ["mcp:read", "mcp:call"]);
		const templates = await callTool(alice.secret, "brain_templates");
		expect(
			(templates.structuredContent as { templates: unknown[] }).templates,
		).toHaveLength(13);
		expect(JSON.parse(templates.content[0].text)).toEqual(
			templates.structuredContent,
		);

		const created = await callTool(alice.secret, "brain_create", {
			title: "Secret plan",
			template: "Projects",
			body: "Talk to [[Grace Hopper]] about #compilers.",
			properties: { status: ["[[Active]]"] },
		});
		expect(created.isError).toBeUndefined();
		expect(created.structuredContent).toMatchObject({
			vault: `agent-${alice.token.id}`,
			title: "Secret plan",
			categories: ["Projects"],
			createdBy: { kind: "agent", id: alice.token.id, name: "Alice" },
		});
		const read = await callTool(alice.secret, "brain_read", {
			title: "secret plan",
		});
		const view = read.structuredContent as BrainNoteView;
		expect(view.note.title).toBe("Secret plan");
		expect(view.outgoing).toEqual([
			{ title: "Projects", exists: true },
			{ title: "Active", exists: false },
			{ title: "Grace Hopper", exists: false },
		]);
		expect(read.content[0].text).toContain("status:");
		expect(read.content[0].text).toContain("## Backlinks\n(none)");
		expect(read.content[0].text).toContain(
			"## Unresolved links\n- [[Active]]\n- [[Grace Hopper]]",
		);

		const hidden = await callTool(bob.secret, "brain_read", {
			title: "Secret plan",
		});
		expect(hidden).toEqual({
			content: [
				{ type: "text", text: expect.stringMatching(/No note titled/) },
			],
			isError: true,
		});
		expect(
			(await callTool(bob.secret, "brain_search", { query: "secret" }))
				.structuredContent,
		).toEqual({
			notes: [],
			total: 0,
		});
		const found = await callTool(alice.secret, "brain_search", {
			query: "grace",
			limit: 5,
		});
		expect(found.structuredContent).toMatchObject({
			total: 1,
			notes: [
				{
					title: "Secret plan",
					snippet: expect.stringContaining("Grace Hopper"),
				},
			],
		});
		expect(
			(await callTool(alice.secret, "brain_search", { tag: "compilers" }))
				.structuredContent,
		).toMatchObject({ total: 1 });

		const conflict = await callTool(alice.secret, "brain_update", {
			title: "Secret plan",
			body: "changed",
			revision: 9,
		});
		expect(conflict.isError).toBe(true);
		const updated = await callTool(alice.secret, "brain_update", {
			title: "Secret plan",
			newTitle: "Compiler plan",
			revision: 1,
		});
		expect(updated.structuredContent).toMatchObject({
			title: "Compiler plan",
			revision: 2,
		});
		const appended = await callTool(alice.secret, "brain_append", {
			title: "Grace Hopper",
			text: "COBOL pioneer.",
			template: "People",
		});
		expect(appended.structuredContent).toMatchObject({
			title: "Grace Hopper",
			body: "COBOL pioneer.",
			categories: ["People"],
		});
		const logged = await callTool(alice.secret, "brain_log", {
			text: "Drafted [[Compiler plan]]",
		});
		const today = new Date().toISOString().slice(0, 10);
		expect(logged.structuredContent).toMatchObject({
			title: today,
			tags: ["daily"],
			body: expect.stringMatching(
				/^## Log\n- \d\d:\d\d Drafted \[\[Compiler plan\]\]$/,
			),
		});
		const daily = await callTool(alice.secret, "brain_daily", {});
		expect(daily.structuredContent).toMatchObject({
			date: today,
			note: { title: today },
			entries: expect.arrayContaining([
				expect.objectContaining({ title: "Compiler plan" }),
				expect.objectContaining({ title: "Grace Hopper" }),
			]),
		});
		expect(
			(await callTool(alice.secret, "brain_daily", { date: "2026-13-40" }))
				.isError,
		).toBe(true);
		expect(
			(await callTool(alice.secret, "brain_unresolved", {})).structuredContent,
		).toEqual({
			links: [{ title: "Active", count: 1, sources: ["Compiler plan"] }],
		});
		expect(
			(await callTool(alice.secret, "brain_delete", { title: "Grace Hopper" }))
				.structuredContent,
		).toEqual({
			deleted: "Grace Hopper",
		});
		expect(
			(await callTool(bob.secret, "brain_delete", { title: "Compiler plan" }))
				.isError,
		).toBe(true);
		const vaults = await rest("GET", "/v1/brain/vaults");
		expect((vaults.json as { vaults: unknown[] }).vaults).toEqual([
			expect.objectContaining({ id: "shared" }),
			expect.objectContaining({
				id: `agent-${alice.token.id}`,
				name: "Alice",
				agentTokenId: alice.token.id,
				noteCount: 4,
			}),
		]);
	});

	it("reads shared, writes it only through proposals, and feeds rejections back", async () => {
		const { server, owner, agentToken, callTool, rest } = await start();
		const alice = await agentToken("Alice", ["mcp:read", "mcp:call"]);
		const bob = await agentToken("Bob", ["mcp:read", "mcp:call"]);
		const admin = await joinWithInvite(
			server,
			owner.token,
			"admin@example.com",
			"admin",
		);
		const member = await joinWithInvite(
			server,
			owner.token,
			"member@example.com",
		);
		await rest("POST", "/v1/brain/vaults/shared/notes", {
			title: "Brand voice",
			body: "Warm and direct.",
			template: "Decisions",
		});
		const shared = await callTool(alice.secret, "brain_read", {
			title: "Brand voice",
			vault: "shared",
		});
		expect((shared.structuredContent as BrainNoteView).note.vault).toBe(
			"shared",
		);
		expect(
			(await callTool(alice.secret, "brain_read", { title: "Brand voice" }))
				.isError,
		).toBe(true);
		expect(
			(
				await callTool(alice.secret, "brain_search", {
					vault: "shared",
					category: "Decisions",
				})
			).structuredContent,
		).toMatchObject({ total: 1 });

		const create = await callTool(alice.secret, "brain_propose", {
			action: "create",
			title: "Tone checklist",
			body: "Short sentences. Link [[Brand voice]].",
			properties: { categories: ["[[Decisions]]"] },
			reason: "Agents keep asking.",
		});
		expect(create.structuredContent).toMatchObject({
			status: "pending",
			baseRevision: null,
			author: { kind: "agent", name: "Alice" },
		});
		const append = await callTool(alice.secret, "brain_propose", {
			action: "append",
			title: "Brand voice",
			text: "Avoid exclamation marks.",
			reason: "Observed in reviews.",
		});
		expect(append.structuredContent).toMatchObject({ baseRevision: 1 });
		expect(
			(
				await callTool(alice.secret, "brain_propose", {
					action: "delete",
					title: "Nope",
					reason: "r",
				})
			).isError,
		).toBe(true);
		const createId = (create.structuredContent as { id: string }).id;
		const appendId = (append.structuredContent as { id: string }).id;
		expect(
			(
				(await callTool(alice.secret, "brain_proposals", {}))
					.structuredContent as { proposals: Array<{ id: string }> }
			).proposals.map((p) => p.id),
		).toEqual([appendId, createId]);
		expect(
			(await callTool(bob.secret, "brain_proposals", {})).structuredContent,
		).toEqual({ proposals: [] });
		expect(
			(
				(await rest("GET", "/v1/brain/proposals?status=pending")).json as {
					proposals: unknown[];
				}
			).proposals,
		).toHaveLength(2);

		expect(
			(
				await rest(
					"POST",
					`/v1/brain/proposals/${createId}/decide`,
					{ decision: "approve" },
					member.token,
				)
			).status,
		).toBe(403);
		const approved = await rest(
			"POST",
			`/v1/brain/proposals/${createId}/decide`,
			{ decision: "approve" },
			admin.token,
		);
		expect(approved.status).toBe(200);
		expect(approved.json).toMatchObject({
			status: "approved",
			decidedBy: { kind: "user", name: "admin" },
		});
		const visible = await callTool(bob.secret, "brain_read", {
			title: "Tone checklist",
			vault: "shared",
		});
		expect((visible.structuredContent as BrainNoteView).note).toMatchObject({
			body: "Short sentences. Link [[Brand voice]].",
			categories: ["Decisions"],
			createdBy: { kind: "user", name: "admin" },
		});
		expect(
			(
				await rest("POST", `/v1/brain/proposals/${createId}/decide`, {
					decision: "approve",
				})
			).status,
		).toBe(409);
		expect(
			(
				await rest("POST", `/v1/brain/proposals/${appendId}/decide`, {
					decision: "reject",
				})
			).status,
		).toBe(400);
		const rejected = await rest(
			"POST",
			`/v1/brain/proposals/${appendId}/decide`,
			{
				decision: "reject",
				reason: "We do use them sparingly.",
			},
		);
		expect(rejected.status).toBe(200);
		expect(rejected.json).toMatchObject({
			status: "rejected",
			decisionReason: "We do use them sparingly.",
		});
		const today = new Date().toISOString().slice(0, 10);
		const daily = await callTool(alice.secret, "brain_daily", { date: today });
		expect(
			(daily.structuredContent as { note: { body: string } }).note.body,
		).toMatch(
			/^## Log\n- \d\d:\d\d Proposal to append \[\[Brand voice\]\] in the shared brain was rejected by Founder: We do use them sparingly\.$/,
		);
		expect(
			(
				(
					await callTool(alice.secret, "brain_proposals", {
						status: "rejected",
					})
				).structuredContent as { proposals: unknown[] }
			).proposals,
		).toHaveLength(1);
		// Bob's log stays empty: the breadcrumb lands only in the author's vault.
		expect(
			(await callTool(bob.secret, "brain_daily", {})).structuredContent,
		).toMatchObject({ note: null });
	});
});

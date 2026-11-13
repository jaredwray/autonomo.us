import type {
	ApiTokenSecret,
	ChannelDetails,
	ChannelEntryList,
	ChannelMessage,
} from "@autonomo.us/common";
import { expect } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import {
	completeSetup,
	defaultWorkspaceId,
	inWorkspace,
	joinWithInvite,
	signIn,
} from "./auth-helpers.js";

export type ToolResult = {
	content: Array<{ type: string; text: string }>;
	structuredContent?: unknown;
	isError?: boolean;
};
type CallOptions = { token?: string; body?: unknown };

/**
 * A listening gateway with an owner, a workspace admin, and a member, plus
 * helpers that talk to it the way the dashboard, a script, and a bot do.
 */
export async function startChannels(
	cleanups: Array<() => Promise<unknown>>,
	config: Partial<ApiConfig> = {},
) {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"], ...config },
		logger: false,
	});
	cleanups.push(() => server.close());
	const origin = await server.listen({ port: 0, host: "127.0.0.1" });
	// Servers sharing a database reuse the owner account the first one created.
	const setupComplete = (await server.inject("/v1/auth/status")).json()
		.setupComplete as boolean;
	const owner = setupComplete
		? await signIn(server, "founder@example.com")
		: await completeSetup(server);
	const workspaceId = await defaultWorkspaceId(server, owner.token);

	const call = (
		method: string,
		path: string,
		{ token = owner.token, body }: CallOptions = {},
	) =>
		fetch(`${origin}${inWorkspace(path, workspaceId)}`, {
			method,
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	/** Calls and returns the parsed body, asserting the status. */
	const ok = async <T>(
		method: string,
		path: string,
		options: CallOptions = {},
		status = 200,
	): Promise<T> => {
		const response = await call(method, path, options);
		const text = await response.text();
		expect(`${response.status} ${text}`).toMatch(new RegExp(`^${status} `));
		return (text ? JSON.parse(text) : null) as T;
	};
	/** The status and error message of a refused call. */
	const refused = async (
		method: string,
		path: string,
		options: CallOptions = {},
	) => {
		const response = await call(method, path, options);
		const json = (await response.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		return { status: response.status, message: json?.error?.message ?? "" };
	};
	const createChannel = (name: string, options: CallOptions = {}) =>
		ok<ChannelDetails>(
			"POST",
			"/v1/channels",
			{ ...options, body: { name } },
			201,
		);
	const post = (
		channel: string,
		body: string,
		options: { token?: string; threadId?: string; nonce?: string } = {},
	) =>
		ok<ChannelMessage>(
			"POST",
			`/v1/channels/${channel}/messages`,
			{
				token: options.token,
				body: { body, threadId: options.threadId, nonce: options.nonce },
			},
			201,
		);
	const read = (channel: string, query = "", token?: string) =>
		ok<ChannelEntryList>("GET", `/v1/channels/${channel}/messages${query}`, {
			token,
		});
	const token = async (
		kind: "api-tokens" | "agent-tokens",
		name: string,
		permissions: string[],
	) =>
		ok<ApiTokenSecret>(
			"POST",
			`/v1/${kind}`,
			{ body: { name, description: "", ttlDays: 7, permissions } },
			201,
		);
	const apiToken = async (permissions: string[]) =>
		(await token("api-tokens", permissions.join(" ") || "none", permissions))
			.secret;
	/** An agent token; `secret` signs in to /mcp, `id` is the agent's identity. */
	const agent = async (
		name: string,
		permissions: string[] = ["mcp:read", "mcp:call"],
	) => {
		const created = await token("agent-tokens", name, permissions);
		return { id: created.token.id, name, secret: created.secret };
	};
	const addAgent = (
		channel: string,
		agentId: string,
		access: "read" | "post" = "post",
		options: CallOptions = {},
	) =>
		ok<ChannelDetails>("PUT", `/v1/channels/${channel}/agents/${agentId}`, {
			...options,
			body: { access },
		});
	const rpc = async (secret: string, method: string, params?: unknown) => {
		const response = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		return (await response.json()) as {
			result?: unknown;
			error?: { code: number; message: string };
		};
	};
	/** A tool call's result; `data` is its structured content. */
	const tool = async <T = unknown>(
		secret: string,
		name: string,
		args: unknown = {},
	) => {
		const response = await rpc(secret, "tools/call", { name, arguments: args });
		if (response.error) throw new Error(JSON.stringify(response.error));
		const result = response.result as ToolResult;
		return {
			isError: result.isError === true,
			text: result.content[0]?.text ?? "",
			data: result.structuredContent as T,
		};
	};
	const join = (email: string, role = "member") =>
		joinWithInvite(server, owner.token, email, role);
	return {
		server,
		origin,
		owner,
		workspaceId,
		call,
		ok,
		refused,
		createChannel,
		post,
		read,
		apiToken,
		agent,
		addAgent,
		rpc,
		tool,
		join,
	};
}

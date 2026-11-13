import {
	AGENT_TOKEN_PERMISSIONS,
	type AgentTokenPermission,
	type Workspace,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import { ApiTokenError, type AuthenticatedToken } from "../auth/token-store.js";
import type { OAuthService } from "../oauth/oauth.js";
import { resolveCorsOrigin } from "../routes/chat.js";
import { resourceMetadataUrl } from "../routes/oauth.js";
import { ServiceError } from "../service-error.js";
import type { WorkspaceStore } from "../workspaces/store.js";

export const MCP_PROTOCOL_VERSIONS = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
] as const;
const LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 error codes, plus MCP's -32001 for missing grants. */
export const RPC = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	forbidden: -32001,
} as const;

export type JsonSchema = {
	type: "object";
	properties: Record<string, PropertySchema>;
	required?: string[];
	additionalProperties: false;
};
export type PropertySchema = {
	type: "string" | "integer" | "object" | "boolean";
	description: string;
	enum?: readonly string[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};

export const schema = (
	props: Record<string, PropertySchema>,
	required: string[] = [],
): JsonSchema => ({
	type: "object",
	properties: props,
	...(required.length ? { required } : {}),
	additionalProperties: false,
});

export type McpToolDefinition = {
	name: string;
	description: string;
	inputSchema: JsonSchema;
};
export type McpArgs = Record<string, unknown>;
/** The agent a request authenticated as, in its workspace. */
export type McpAgent = {
	/** An agent that uses MCP, or the identity of one the gateway runs. */
	token: Pick<
		AuthenticatedToken<AgentTokenPermission>,
		"id" | "name" | "permissions"
	>;
	actor: { kind: "agent"; id: string; name: string };
	workspace: Workspace;
};
/**
 * Tools one part of the gateway offers to agents. `text` may give a tool's
 * result a readable text form; without it the text is the JSON result.
 */
export type McpToolSet = {
	instructions: string;
	tools: McpToolDefinition[];
	handlers: Record<
		string,
		(agent: McpAgent, args: McpArgs) => Promise<unknown>
	>;
	text?: (name: string, result: unknown) => string | undefined;
};

/** Why `args` do not satisfy `schema`, or null when they do. */
export function argumentProblem(
	schema: JsonSchema,
	args: unknown,
): string | null {
	if (args === undefined) args = {};
	if (args === null || typeof args !== "object" || Array.isArray(args))
		return "arguments must be an object";
	const input = args as Record<string, unknown>;
	for (const key of schema.required ?? [])
		if (input[key] === undefined) return `${key} is required`;
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		// Own keys only: "constructor" or "__proto__" must not pass as known.
		const rule = Object.hasOwn(schema.properties, key)
			? schema.properties[key]
			: undefined;
		if (!rule) return `unknown argument "${key}"`;
		if (rule.type === "string") {
			if (typeof value !== "string") return `${key} must be a string`;
			if (rule.enum && !rule.enum.includes(value))
				return `${key} must be one of ${rule.enum.join(", ")}`;
			if (rule.minLength !== undefined && value.length < rule.minLength)
				return `${key} must not be empty`;
			if (rule.maxLength !== undefined && value.length > rule.maxLength)
				return `${key} is at most ${rule.maxLength} characters`;
			if (rule.pattern && !new RegExp(rule.pattern).test(value))
				return `${key} must match ${rule.pattern}`;
		} else if (rule.type === "integer") {
			if (typeof value !== "number" || !Number.isInteger(value))
				return `${key} must be an integer`;
			if (rule.minimum !== undefined && value < rule.minimum)
				return `${key} must be at least ${rule.minimum}`;
			if (rule.maximum !== undefined && value > rule.maximum)
				return `${key} must be at most ${rule.maximum}`;
		} else if (rule.type === "boolean") {
			if (typeof value !== "boolean") return `${key} must be true or false`;
		} else if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value)
		)
			return `${key} must be an object`;
	}
	return null;
}

export class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

/** Refuses a tool call when the agent's token lacks `permission`. */
export function requireGrant(
	agent: McpAgent,
	permission: AgentTokenPermission,
) {
	if (!agent.token.permissions.includes(permission))
		throw new RpcError(
			RPC.forbidden,
			`This agent token lacks the ${AGENT_TOKEN_PERMISSIONS[permission]} grant (${permission}).`,
		);
}

export type McpRouteOptions = {
	toolSets: McpToolSet[];
	agentTokens: AgentTokenStore;
	/** Access tokens of apps that signed in to an agent with OAuth. */
	oauth: Pick<OAuthService, "authenticate">;
	/** The address the request reached the gateway at, without a path. */
	origin(request: FastifyRequest): string;
	/** An agent works only while its workspace exists and is not archived. */
	workspaces: Pick<WorkspaceStore, "get" | "defaultWorkspaceId">;
	/** Browser origins allowed by CORS_ORIGIN; `["*"]` allows any. */
	corsOrigins: string[];
	version: string;
};

/**
 * Streamable HTTP MCP in stateless mode on POST /mcp: one JSON-RPC message
 * per request, one JSON response. See docs/SYNAPSE.md §9. Each part of the
 * gateway that agents can use contributes a tool set.
 */
export async function mcpRoutes(
	server: FastifyInstance,
	options: McpRouteOptions,
) {
	const definitions = options.toolSets.flatMap((set) => set.tools);
	const instructions = options.toolSets
		.map((set) => set.instructions)
		.join("\n");
	const owners = new Map<string, McpToolSet>();
	for (const set of options.toolSets)
		for (const tool of set.tools) {
			if (owners.has(tool.name) || !set.handlers[tool.name])
				throw new Error(`MCP tool ${tool.name} is duplicated or unhandled.`);
			owners.set(tool.name, set);
		}

	// Malformed JSON must become a JSON-RPC parse error, not Fastify's 400.
	server.addContentTypeParser(
		"application/json",
		{ parseAs: "string" },
		(_request, payload, done) => done(null, payload),
	);
	server.addContentTypeParser(
		"*",
		{ parseAs: "string" },
		(_request, payload, done) => done(null, payload),
	);

	const callTool = async (agent: McpAgent, params: unknown) => {
		const { name, arguments: args } = (params ?? {}) as {
			name?: unknown;
			arguments?: unknown;
		};
		const set = typeof name === "string" ? owners.get(name) : undefined;
		const definition = definitions.find((tool) => tool.name === name);
		if (!set || !definition)
			throw new RpcError(RPC.invalidParams, `Unknown tool: ${String(name)}`);
		const problem = argumentProblem(definition.inputSchema, args);
		if (problem)
			throw new RpcError(
				RPC.invalidParams,
				`Invalid arguments for ${definition.name}: ${problem}`,
			);
		try {
			const result = await set.handlers[definition.name](
				agent,
				(args ?? {}) as McpArgs,
			);
			return {
				content: [
					{
						type: "text",
						text: set.text?.(definition.name, result) ?? JSON.stringify(result),
					},
				],
				structuredContent: result,
			};
		} catch (error) {
			if (error instanceof ServiceError)
				return {
					content: [{ type: "text", text: error.message }],
					isError: true,
				};
			throw error;
		}
	};

	const dispatch = async (agent: McpAgent, method: string, params: unknown) => {
		switch (method) {
			case "initialize": {
				const requested = (params as { protocolVersion?: unknown } | undefined)
					?.protocolVersion;
				return {
					protocolVersion: (
						MCP_PROTOCOL_VERSIONS as readonly unknown[]
					).includes(requested)
						? requested
						: LATEST_PROTOCOL,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "autonomo.us", version: options.version },
					instructions,
				};
			}
			case "ping":
				return {};
			case "tools/list":
				requireGrant(agent, "mcp:read");
				return { tools: definitions };
			case "tools/call":
				requireGrant(agent, "mcp:call");
				return callTool(agent, params);
			default:
				throw new RpcError(RPC.methodNotFound, `Method not found: ${method}`);
		}
	};

	/**
	 * Tells an MCP app where to sign in (RFC 9728): the metadata names this
	 * gateway as the authorization server for the endpoint.
	 */
	const unauthorized = (
		request: FastifyRequest,
		reply: FastifyReply,
		presented: boolean,
	) =>
		reply
			.code(401)
			.header(
				"www-authenticate",
				`Bearer ${presented ? 'error="invalid_token", ' : ""}resource_metadata="${resourceMetadataUrl(options.origin(request))}", scope="mcp:read mcp:call"`,
			)
			.send({
				error: {
					message: "Provide a valid agent token, or sign in with OAuth.",
				},
			});

	/** The agent an OAuth access token was issued for, while both still stand. */
	const signedIn = async (secret: string) => {
		const identity = await options.oauth.authenticate(secret);
		const agent = identity
			? await options.agentTokens.find(identity.agentId)
			: null;
		if (!identity || !agent || agent.auth !== "oauth") return null;
		const workspaceId =
			agent.workspaceId ?? (await options.workspaces.defaultWorkspaceId());
		return workspaceId === identity.workspaceId ? agent : null;
	};

	/**
	 * Agents speak MCP with an agent token or an OAuth access token; sessions,
	 * API tokens, and SETUP_TOKEN are refused.
	 */
	const authenticate = async (
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<McpAgent | undefined> => {
		const match = /^Bearer ((agt|oat)_\S+)$/i.exec(
			request.headers.authorization ?? "",
		);
		if (!match) {
			unauthorized(request, reply, false);
			return undefined;
		}
		let token: AuthenticatedToken<AgentTokenPermission> | null;
		try {
			token =
				match[2].toLowerCase() === "oat"
					? await signedIn(match[1])
					: await options.agentTokens.authenticate(match[1]);
		} catch (error) {
			if (!(error instanceof ApiTokenError || error instanceof ServiceError))
				throw error;
			reply.code(error.statusCode).send({ error: { message: error.message } });
			return undefined;
		}
		if (!token) {
			unauthorized(request, reply, true);
			return undefined;
		}
		// The same rule as REST: archiving a workspace refuses its tokens. A
		// token without a workspace predates workspaces and belongs to the default.
		const workspace = await options.workspaces.get(
			token.workspaceId ?? (await options.workspaces.defaultWorkspaceId()),
		);
		if (!workspace) {
			unauthorized(request, reply, true);
			return undefined;
		}
		if (workspace.archivedAt) {
			reply
				.code(409)
				.send({ error: { message: "This workspace is archived." } });
			return undefined;
		}
		return {
			token,
			actor: { kind: "agent", id: token.id, name: token.name },
			workspace,
		};
	};

	const rpcError = (
		reply: FastifyReply,
		status: number,
		id: unknown,
		code: number,
		message: string,
	) =>
		reply
			.code(status)
			.send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

	server.route({
		method: ["GET", "DELETE"],
		url: "/mcp",
		handler: (_request, reply) =>
			reply
				.code(405)
				.header("allow", "POST")
				.send({ error: { message: "The MCP endpoint accepts POST only." } }),
	});

	server.post<{ Body: string }>("/mcp", async (request, reply) => {
		reply.header("cache-control", "no-store");
		const origin = request.headers.origin;
		if (origin && !resolveCorsOrigin(origin, options.corsOrigins))
			return reply.code(403).send({
				error: { message: "This origin may not use the MCP endpoint." },
			});
		const agent = await authenticate(request, reply);
		if (!agent) return;
		let message: unknown;
		try {
			message = JSON.parse(
				typeof request.body === "string" ? request.body : "",
			);
		} catch {
			return rpcError(
				reply,
				400,
				null,
				RPC.parse,
				"Parse error: invalid JSON.",
			);
		}
		if (Array.isArray(message))
			return rpcError(
				reply,
				400,
				null,
				RPC.invalidRequest,
				"Batches are not supported; send one JSON-RPC message per request.",
			);
		if (message === null || typeof message !== "object")
			return rpcError(reply, 400, null, RPC.invalidRequest, "Invalid Request.");
		const { jsonrpc, id, method, params } = message as Record<string, unknown>;
		if (jsonrpc !== "2.0" || typeof method !== "string")
			return rpcError(
				reply,
				400,
				id,
				RPC.invalidRequest,
				'Invalid Request: expected jsonrpc "2.0" and a method.',
			);
		// Only notifications may omit the id. A request without one, such as a
		// tools/call, is refused so the client learns its write did not happen.
		if (id === undefined) {
			if (method.startsWith("notifications/")) return reply.code(202).send();
			return rpcError(
				reply,
				400,
				null,
				RPC.invalidRequest,
				`Invalid Request: ${method} needs an id; only notifications may omit it.`,
			);
		}
		if (typeof id !== "string" && typeof id !== "number" && id !== null)
			return rpcError(
				reply,
				400,
				null,
				RPC.invalidRequest,
				"Invalid Request: bad id.",
			);
		try {
			const result = await dispatch(agent, method, params);
			return reply.send({ jsonrpc: "2.0", id, result });
		} catch (error) {
			if (error instanceof RpcError)
				return rpcError(reply, 200, id, error.code, error.message);
			if (error instanceof ServiceError)
				return rpcError(reply, 200, id, RPC.internal, error.message);
			request.log.error(error);
			return rpcError(reply, 200, id, RPC.internal, "Internal error.");
		}
	});
}

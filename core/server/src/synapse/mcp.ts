import {
	AGENT_TOKEN_PERMISSIONS,
	type AgentTokenPermission,
	type CreateSynapseProposalRequest,
	type SynapseActor,
	type SynapseNoteView,
	type SynapseProperties,
	type SynapseProposalStatus,
	type SynapseSpaceId,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import { ApiTokenError, type AuthenticatedToken } from "../auth/token-store.js";
import { resolveCorsOrigin } from "../routes/chat.js";
import type { WorkspaceStore } from "../workspaces/store.js";
import { SynapseError } from "./errors.js";
import { agentSpaceId, type SynapseService, sharedSpaceId } from "./synapse.js";

export const MCP_PROTOCOL_VERSIONS = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
] as const;
const LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];
const SEARCH_LIMIT = 50;

/** JSON-RPC 2.0 error codes, plus MCP's -32001 for missing grants. */
export const RPC = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	forbidden: -32001,
} as const;

export const MCP_INSTRUCTIONS = [
	"Synapse is your long-term memory: a space of linked Markdown notes that outlives this session.",
	"Search before you write (synapse_search); update or append to an existing note instead of creating a duplicate.",
	"Keep one note per thing: a person, company, project, or idea, titled with its name. Write evergreen ideas as one note per idea, titled as a statement.",
	"Always link the first mention of a person, project, company, or idea with [[Title]], even when no note exists yet; unresolved links are breadcrumbs for future notes (synapse_unresolved).",
	"Classify notes with the categories property by creating them from a template (synapse_templates); category and template names are plural, like People or Projects.",
	"Write dates as YYYY-MM-DD. Record what you did and decided with synapse_log; it goes into today's daily note, so link the notes involved.",
	'Your space is private to you. The shared space is your workspace\'s team canon, including notes inherited from the global Synapse: read it with space "shared", and change it only through synapse_propose, which a person reviews. Inherited notes can be overridden by proposing a note with the same title.',
].join("\n");

type JsonSchema = {
	type: "object";
	properties: Record<string, PropertySchema>;
	required?: string[];
	additionalProperties: false;
};
type PropertySchema = {
	type: "string" | "integer" | "object";
	description: string;
	enum?: readonly string[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};

const title = (description: string): PropertySchema => ({
	type: "string",
	description,
	minLength: 1,
	maxLength: 200,
});
const space: PropertySchema = {
	type: "string",
	description:
		'"agent" (default) is your own private space; "shared" is the team canon.',
	enum: ["agent", "shared"],
};
const body: PropertySchema = {
	type: "string",
	description:
		"Markdown body without frontmatter. Link first mentions with [[Title]].",
};
const properties: PropertySchema = {
	type: "object",
	description:
		"Flat properties: strings, numbers, booleans, null, or lists of strings. Lists over text; dates as YYYY-MM-DD.",
};
const template: PropertySchema = {
	type: "string",
	description: "Built-in template name from synapse_templates, e.g. People.",
};

const schema = (
	props: Record<string, PropertySchema>,
	required: string[] = [],
): JsonSchema => ({
	type: "object",
	properties: props,
	...(required.length ? { required } : {}),
	additionalProperties: false,
});

export const MCP_TOOLS: Array<{
	name: string;
	description: string;
	inputSchema: JsonSchema;
}> = [
	{
		name: "synapse_search",
		description:
			"Finds notes by words, category, tag, or backlinks. Every filter must match; results carry a snippet.",
		inputSchema: schema({
			query: {
				type: "string",
				description:
					"Words that must all appear in the title, body, or properties.",
				maxLength: 500,
			},
			category: title("Only notes in this category, e.g. People."),
			tag: {
				type: "string",
				description: "Only notes with this tag or a nested tag below it.",
				maxLength: 200,
			},
			linksTo: title("Only notes that link to this title (its backlinks)."),
			space,
			limit: {
				type: "integer",
				description: `Maximum results, default 10, at most ${SEARCH_LIMIT}.`,
				minimum: 1,
				maximum: SEARCH_LIMIT,
			},
		}),
	},
	{
		name: "synapse_read",
		description:
			"Reads a note with its backlinks, outgoing links, related notes, and category members.",
		inputSchema: schema({ title: title("Exact note title."), space }, [
			"title",
		]),
	},
	{
		name: "synapse_create",
		description:
			"Creates a note in your space, optionally from a template whose properties come first.",
		inputSchema: schema(
			{
				title: title("Unique title; also the file name."),
				template,
				body,
				properties,
			},
			["title"],
		),
	},
	{
		name: "synapse_update",
		description:
			"Changes a note in your space: rename (rewriting links to it), replace the body, or merge properties. Pass the revision you read to avoid overwriting a concurrent change.",
		inputSchema: schema(
			{
				title: title("Current title."),
				newTitle: title("New title; [[links]] to the old title are rewritten."),
				body,
				properties,
				revision: {
					type: "integer",
					description: "Revision you read; mismatches fail.",
					minimum: 1,
				},
			},
			["title"],
		),
	},
	{
		name: "synapse_append",
		description:
			"Adds text to the end of a note in your space, creating it (from a template if given) when it is missing.",
		inputSchema: schema(
			{
				title: title("Note title."),
				text: {
					type: "string",
					description: "Markdown to append.",
					minLength: 1,
				},
				template,
			},
			["title", "text"],
		),
	},
	{
		name: "synapse_delete",
		description:
			"Deletes a note from your space. Links to it become unresolved. Pass the revision you read to avoid deleting a newer change.",
		inputSchema: schema(
			{
				title: title("Note title."),
				revision: {
					type: "integer",
					description: "Revision you read; mismatches fail.",
					minimum: 1,
				},
			},
			["title"],
		),
	},
	{
		name: "synapse_log",
		description:
			"Records what you did or decided as a timestamped line in today's daily note. Link the notes involved.",
		inputSchema: schema(
			{ text: { type: "string", description: "One log line.", minLength: 1 } },
			["text"],
		),
	},
	{
		name: "synapse_daily",
		description:
			"Shows a day: its daily note and the notes created on, dated, or linking to that day.",
		inputSchema: schema({
			date: {
				type: "string",
				description: "YYYY-MM-DD; default today.",
				pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			},
			space,
		}),
	},
	{
		name: "synapse_unresolved",
		description:
			"Lists link targets with no note yet, most linked first: candidates for new notes.",
		inputSchema: schema({
			space,
			limit: {
				type: "integer",
				description: "Maximum results, default 50.",
				minimum: 1,
				maximum: 1000,
			},
		}),
	},
	{
		name: "synapse_templates",
		description:
			"Lists the built-in templates with their category, description, and default properties.",
		inputSchema: schema({}),
	},
	{
		name: "synapse_propose",
		description:
			"Proposes a change to the shared space for a person to approve: create, update, append, or delete a note, with a reason.",
		inputSchema: schema(
			{
				action: {
					type: "string",
					description: "What to do with the shared note.",
					enum: ["create", "update", "append", "delete"],
				},
				title: title("Shared note title."),
				newTitle: title("update: rename to this title."),
				body: { ...body, description: "create/update: the proposed body." },
				properties: {
					...properties,
					description: "create/update: properties merged into the note.",
				},
				text: {
					type: "string",
					description: "append: text to add.",
					minLength: 1,
				},
				reason: {
					type: "string",
					description: "Why the team canon should change.",
					minLength: 1,
					maxLength: 2000,
				},
			},
			["action", "title", "reason"],
		),
	},
	{
		name: "synapse_proposals",
		description: "Lists your proposals, newest first, optionally by status.",
		inputSchema: schema({
			status: {
				type: "string",
				description: "pending, approved, or rejected.",
				enum: ["pending", "approved", "rejected"],
			},
		}),
	},
];

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
		} else if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value)
		)
			return `${key} must be an object`;
	}
	return null;
}

/** The text form of synapse_read: the file plus its graph neighbourhood. */
export function noteViewText(view: SynapseNoteView): string {
	const list = (titles: string[]) =>
		titles.length ? titles.map((item) => `- [[${item}]]`).join("\n") : "(none)";
	return [
		view.markdown.trimEnd(),
		`## Backlinks\n${list(view.backlinks.map((note) => note.title))}`,
		`## Related\n${list(view.related.map((note) => note.title))}`,
		`## Unresolved links\n${list(
			view.outgoing.filter((link) => !link.exists).map((link) => link.title),
		)}`,
	].join("\n\n");
}

class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

type Args = Record<string, unknown>;
/** Shapes checked by the service's validateProperties, not here. */
const asProperties = (value: unknown) => value as SynapseProperties | undefined;
type Agent = {
	token: AuthenticatedToken<AgentTokenPermission>;
	actor: SynapseActor;
	/** The shared space of the agent's workspace, which inherits global. */
	shared: SynapseSpaceId;
};

export type McpRouteOptions = {
	synapse: SynapseService;
	agentTokens: AgentTokenStore;
	/** An agent token works only while its workspace exists and is not archived. */
	workspaces: Pick<WorkspaceStore, "get" | "defaultWorkspaceId">;
	/** Browser origins allowed by CORS_ORIGIN; `["*"]` allows any. */
	corsOrigins: string[];
	version: string;
};

/**
 * Streamable HTTP MCP in stateless mode on POST /mcp: one JSON-RPC message
 * per request, one JSON response. See docs/SYNAPSE.md §9.
 */
export async function mcpRoutes(
	server: FastifyInstance,
	options: McpRouteOptions,
) {
	const { synapse } = options;
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

	const spaceOf = (agent: Agent, args: Args): SynapseSpaceId =>
		args.space === "shared" ? agent.shared : agentSpaceId(agent.token.id);

	const tools: Record<string, (agent: Agent, args: Args) => Promise<unknown>> =
		{
			synapse_search: (agent, args) =>
				synapse.query(spaceOf(agent, args), {
					text: args.query as string | undefined,
					category: args.category as string | undefined,
					tag: args.tag as string | undefined,
					linksTo: args.linksTo as string | undefined,
					limit: Math.min(
						SEARCH_LIMIT,
						(args.limit as number | undefined) ?? 10,
					),
				}),
			synapse_read: (agent, args) =>
				synapse.viewNote(spaceOf(agent, args), args.title as string),
			synapse_create: (agent, args) =>
				synapse.createNote(
					agentSpaceId(agent.token.id),
					{
						title: args.title as string,
						template: args.template as string | undefined,
						body: args.body as string | undefined,
						properties: asProperties(args.properties),
					},
					agent.actor,
				),
			synapse_update: (agent, args) =>
				synapse.updateNote(
					agentSpaceId(agent.token.id),
					args.title as string,
					{
						title: args.newTitle as string | undefined,
						body: args.body as string | undefined,
						properties: asProperties(args.properties),
						revision: args.revision as number | undefined,
					},
					agent.actor,
				),
			synapse_append: async (agent, args) =>
				(
					await synapse.appendNote(
						agentSpaceId(agent.token.id),
						args.title as string,
						{
							text: args.text as string,
							template: args.template as string | undefined,
						},
						agent.actor,
					)
				).note,
			synapse_delete: async (agent, args) => {
				await synapse.deleteNote(
					agentSpaceId(agent.token.id),
					args.title as string,
					agent.actor,
					args.revision as number | undefined,
				);
				return { deleted: args.title };
			},
			synapse_log: (agent, args) =>
				synapse.log(
					agentSpaceId(agent.token.id),
					args.text as string,
					agent.actor,
				),
			synapse_daily: (agent, args) =>
				synapse.daily(
					spaceOf(agent, args),
					(args.date as string) ?? synapse.today(),
				),
			synapse_unresolved: async (agent, args) => ({
				links: await synapse.unresolved(
					spaceOf(agent, args),
					(args.limit as number | undefined) ?? 50,
				),
			}),
			synapse_templates: async () => ({ templates: synapse.templates() }),
			synapse_propose: (agent, args) =>
				synapse.propose(
					agent.actor,
					args as unknown as CreateSynapseProposalRequest,
					agent.shared,
				),
			synapse_proposals: async (agent, args) => ({
				proposals: await synapse.listProposals({
					authorId: agent.token.id,
					status: args.status as SynapseProposalStatus | undefined,
				}),
			}),
		};

	const require = (agent: Agent, permission: AgentTokenPermission) => {
		if (!agent.token.permissions.includes(permission))
			throw new RpcError(
				RPC.forbidden,
				`This agent token lacks the ${AGENT_TOKEN_PERMISSIONS[permission]} grant (${permission}).`,
			);
	};

	const callTool = async (agent: Agent, params: unknown) => {
		const { name, arguments: args } = (params ?? {}) as {
			name?: unknown;
			arguments?: unknown;
		};
		const definition = MCP_TOOLS.find((tool) => tool.name === name);
		const run = typeof name === "string" ? tools[name] : undefined;
		if (!definition || !run)
			throw new RpcError(RPC.invalidParams, `Unknown tool: ${String(name)}`);
		const problem = argumentProblem(definition.inputSchema, args);
		if (problem)
			throw new RpcError(
				RPC.invalidParams,
				`Invalid arguments for ${name}: ${problem}`,
			);
		try {
			const result = await run(agent, (args ?? {}) as Args);
			const text =
				name === "synapse_read"
					? noteViewText(result as SynapseNoteView)
					: JSON.stringify(result);
			return {
				content: [{ type: "text", text }],
				structuredContent: result,
			};
		} catch (error) {
			if (error instanceof SynapseError)
				return {
					content: [{ type: "text", text: error.message }],
					isError: true,
				};
			throw error;
		}
	};

	const dispatch = async (agent: Agent, method: string, params: unknown) => {
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
					instructions: MCP_INSTRUCTIONS,
				};
			}
			case "ping":
				return {};
			case "tools/list":
				require(agent, "mcp:read");
				return { tools: MCP_TOOLS };
			case "tools/call":
				require(agent, "mcp:call");
				return callTool(agent, params);
			default:
				throw new RpcError(RPC.methodNotFound, `Method not found: ${method}`);
		}
	};

	const unauthorized = (reply: FastifyReply) =>
		reply
			.code(401)
			.header("www-authenticate", "Bearer")
			.send({ error: { message: "Provide a valid agent token." } });

	/** Only agent tokens speak MCP; sessions, API tokens, and SETUP_TOKEN are refused. */
	const authenticate = async (
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<Agent | undefined> => {
		const match = /^Bearer (agt_\S+)$/i.exec(
			request.headers.authorization ?? "",
		);
		if (!match) {
			unauthorized(reply);
			return undefined;
		}
		let token: AuthenticatedToken<AgentTokenPermission> | null;
		try {
			token = await options.agentTokens.authenticate(match[1]);
		} catch (error) {
			if (!(error instanceof ApiTokenError)) throw error;
			reply.code(error.statusCode).send({ error: { message: error.message } });
			return undefined;
		}
		if (!token) {
			unauthorized(reply);
			return undefined;
		}
		// The same rule as REST: archiving a workspace refuses its tokens. A
		// token without a workspace predates workspaces and belongs to the default.
		const workspace = await options.workspaces.get(
			token.workspaceId ?? (await options.workspaces.defaultWorkspaceId()),
		);
		if (!workspace) {
			unauthorized(reply);
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
			shared: sharedSpaceId(workspace),
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
			if (error instanceof SynapseError)
				return rpcError(reply, 200, id, RPC.internal, error.message);
			request.log.error(error);
			return rpcError(reply, 200, id, RPC.internal, "Internal error.");
		}
	});
}

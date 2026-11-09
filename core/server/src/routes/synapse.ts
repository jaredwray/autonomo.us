import {
	type AppendSynapseNoteRequest,
	type CreateSynapseNoteRequest,
	type DecideSynapseProposalRequest,
	SYNAPSE_GLOBAL_SPACE,
	SYNAPSE_SHARED_SPACE,
	SYNAPSE_SPACE_ID_PATTERN,
	type SynapseActor,
	type SynapseImportRequest,
	type SynapseNoteSort,
	type SynapseProposalStatus,
	type SynapseSpaceId,
	type UpdateSynapseNoteRequest,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requestWorkspace, signedInMember } from "../auth/access.js";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import { mongoErrorDetails } from "../mongo.js";
import { SynapseError } from "../synapse/errors.js";
import {
	MAX_QUERY_LIMIT,
	MAX_REASON_LENGTH,
	type SynapseService,
	sharedSpaceId,
} from "../synapse/synapse.js";
import { zipStore } from "../synapse/zip.js";

const IMPORT_BODY_LIMIT = 5 * 1024 * 1024;
const IMPORT_MAX_FILES = 500;
const string = { type: "string" };
const space = { type: "string", pattern: SYNAPSE_SPACE_ID_PATTERN };
const titleParam = { type: "string", minLength: 1, maxLength: 200 };
const spaceParams = {
	type: "object",
	required: ["space"],
	properties: { space },
};
const noteParams = {
	type: "object",
	required: ["space", "title"],
	properties: { space, title: titleParam },
};
const dateParams = {
	type: "object",
	required: ["space", "date"],
	properties: {
		space,
		date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
	},
};
const idParams = {
	type: "object",
	required: ["id"],
	properties: { id: { type: "string", format: "uuid" } },
};
const status = { enum: ["pending", "approved", "rejected"] };
const body = (properties: Record<string, object>, required: string[] = []) => ({
	type: "object",
	additionalProperties: false,
	...(required.length ? { required } : {}),
	properties,
});
/** Values are checked by the service: a JSON schema here would let Ajv coerce them. */
const properties = { type: "object" };

type SpaceParams = { space: SynapseSpaceId };
type NoteParams = SpaceParams & { title: string };
type NotesQuery = Record<string, string | undefined> & {
	sort?: SynapseNoteSort;
	direction?: "asc" | "desc";
	limit?: number;
	offset?: number;
};

function actorOf(request: FastifyRequest): SynapseActor {
	const auth = request.auth;
	if (auth?.kind === "user")
		return {
			kind: "user",
			id: auth.member.id,
			name: auth.member.name || auth.member.email,
		};
	if (auth?.kind === "api-token")
		return { kind: "api-token", id: auth.token.id, name: auth.token.name };
	throw new SynapseError("Sign in or provide an API token.", 403);
}

/** IDs of the agents in the request's workspace, whose spaces it may open. */
async function workspaceAgents(
	request: FastifyRequest,
	agentTokens: AgentTokenStore,
): Promise<Set<string>> {
	const settings = await agentTokens.settings(requestWorkspace(request), true);
	return new Set(settings.tokens.map((token) => token.id));
}

/**
 * Synapse inside one workspace, under `/v1/:workspace/synapse`. `shared` is
 * the workspace's shared space (which inherits `global`), `global` is the
 * gateway-wide space, and `agent-<id>` is open only for this workspace's agents.
 */
export async function synapseRoutes(
	server: FastifyInstance,
	{
		synapse,
		agentTokens,
	}: { synapse: SynapseService; agentTokens: AgentTokenStore },
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	// After validation: turn the path's space into the workspace's storage key.
	server.addHook("preHandler", async (request) => {
		const params = request.params as { space?: SynapseSpaceId };
		if (params.space === undefined) return;
		const workspace = requestWorkspace(request);
		if (params.space === SYNAPSE_SHARED_SPACE) {
			params.space = sharedSpaceId(workspace);
			return;
		}
		if (params.space === SYNAPSE_GLOBAL_SPACE) {
			// The global space sits above every workspace: people who run the
			// whole gateway change it, and everyone else reads it.
			const write = request.method !== "GET" && request.method !== "HEAD";
			if (write && !(request.auth?.kind === "user" && workspace.implicit))
				throw new SynapseError(
					"Only owners and admins can change the global Synapse.",
					403,
				);
			return;
		}
		const agents = await workspaceAgents(request, agentTokens);
		if (!agents.has(params.space.slice("agent-".length)))
			throw new SynapseError("No such space in this workspace.", 404);
	});
	// Store errors carry a status; validation failures are 400s. Both answer
	// in the gateway's `{ error: { message } }` shape.
	server.setErrorHandler((error: unknown, request, reply) => {
		const failure = error as { statusCode?: unknown; message?: unknown };
		const status =
			typeof failure.statusCode === "number" && failure.statusCode >= 400
				? failure.statusCode
				: 500;
		// A SynapseError's cause may be a driver error whose message holds the URI.
		if (status >= 500)
			request.log.error(
				error instanceof SynapseError
					? { ...mongoErrorDetails(error), message: error.message }
					: error,
				"Synapse request failed",
			);
		return reply.code(status).send({
			error: {
				message:
					status < 500 || error instanceof SynapseError
						? String(failure.message)
						: "Synapse hit an unexpected error.",
			},
		});
	});

	server.get("/synapse/spaces", async (request) =>
		synapse.listSpaces({
			shared: sharedSpaceId(requestWorkspace(request)),
			agentTokenIds: await workspaceAgents(request, agentTokens),
		}),
	);
	server.get("/synapse/templates", () => ({
		templates: synapse.templates(),
	}));

	server.get<{ Params: SpaceParams; Querystring: NotesQuery }>(
		"/synapse/spaces/:space/notes",
		{
			schema: {
				params: spaceParams,
				querystring: {
					type: "object",
					properties: {
						text: { ...string, maxLength: 1000 },
						category: titleParam,
						tag: { ...string, maxLength: 200 },
						linksTo: titleParam,
						sort: { enum: ["updated", "created", "title", "relevance"] },
						direction: { enum: ["asc", "desc"] },
						limit: { type: "integer", minimum: 1, maximum: MAX_QUERY_LIMIT },
						offset: { type: "integer", minimum: 0 },
					},
				},
			},
		},
		(request) => {
			const { text, category, tag, linksTo, sort, direction, limit, offset } =
				request.query;
			const where: Record<string, string> = {};
			for (const [key, value] of Object.entries(request.query))
				if (
					key.startsWith("where.") &&
					key.length > 6 &&
					typeof value === "string"
				)
					where[key.slice(6)] = value;
			return synapse.query(request.params.space, {
				text,
				category,
				tag,
				linksTo,
				sort,
				direction,
				limit,
				offset,
				...(Object.keys(where).length ? { where } : {}),
			});
		},
	);
	server.post<{ Params: SpaceParams; Body: CreateSynapseNoteRequest }>(
		"/synapse/spaces/:space/notes",
		{
			schema: {
				params: spaceParams,
				body: body(
					{
						title: string,
						template: string,
						body: string,
						properties,
						markdown: string,
					},
					["title"],
				),
			},
		},
		async (request, reply) =>
			reply
				.code(201)
				.send(
					await synapse.createNote(
						request.params.space,
						request.body,
						actorOf(request),
					),
				),
	);
	server.get<{ Params: NoteParams }>(
		"/synapse/spaces/:space/notes/:title",
		{ schema: { params: noteParams } },
		(request) => synapse.viewNote(request.params.space, request.params.title),
	);
	server.patch<{ Params: NoteParams; Body: UpdateSynapseNoteRequest }>(
		"/synapse/spaces/:space/notes/:title",
		{
			schema: {
				params: noteParams,
				body: body({
					title: string,
					body: string,
					properties,
					replaceProperties: { type: "boolean" },
					markdown: string,
					revision: { type: "integer", minimum: 1 },
				}),
			},
		},
		(request) =>
			synapse.updateNote(
				request.params.space,
				request.params.title,
				request.body,
				actorOf(request),
			),
	);
	server.post<{ Params: NoteParams; Body: AppendSynapseNoteRequest }>(
		"/synapse/spaces/:space/notes/:title/append",
		{
			schema: {
				params: noteParams,
				body: body({ text: string, template: string }, ["text"]),
			},
		},
		async (request, reply) => {
			const { note, created } = await synapse.appendNote(
				request.params.space,
				request.params.title,
				request.body,
				actorOf(request),
			);
			return reply.code(created ? 201 : 200).send(note);
		},
	);
	// `?revision=` deletes only that revision, so a stale confirmation is a 409.
	server.delete<{ Params: NoteParams; Querystring: { revision?: number } }>(
		"/synapse/spaces/:space/notes/:title",
		{
			schema: {
				params: noteParams,
				querystring: {
					type: "object",
					additionalProperties: false,
					properties: { revision: { type: "integer", minimum: 1 } },
				},
			},
		},
		async (request, reply) => {
			await synapse.deleteNote(
				request.params.space,
				request.params.title,
				actorOf(request),
				request.query.revision,
			);
			return reply.code(204).send();
		},
	);
	server.get<{ Params: SpaceParams; Querystring: { limit?: number } }>(
		"/synapse/spaces/:space/unresolved",
		{
			schema: {
				params: spaceParams,
				querystring: {
					type: "object",
					properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } },
				},
			},
		},
		async (request) => ({
			links: await synapse.unresolved(
				request.params.space,
				request.query.limit ?? 200,
			),
		}),
	);
	server.get<{ Params: SpaceParams }>(
		"/synapse/spaces/:space/categories",
		{ schema: { params: spaceParams } },
		async (request) => ({
			categories: await synapse.categories(request.params.space),
		}),
	);
	server.get<{ Params: SpaceParams & { date: string } }>(
		"/synapse/spaces/:space/daily/:date",
		{ schema: { params: dateParams } },
		(request) => synapse.daily(request.params.space, request.params.date),
	);
	server.get<{ Params: SpaceParams; Querystring: { format?: "json" | "zip" } }>(
		"/synapse/spaces/:space/export",
		{
			schema: {
				params: spaceParams,
				querystring: {
					type: "object",
					properties: { format: { enum: ["json", "zip"] } },
				},
			},
		},
		async (request, reply) => {
			const exported = await synapse.exportSpace(request.params.space);
			if (request.query.format !== "zip") return exported;
			return reply
				.header("content-type", "application/zip")
				.header(
					"content-disposition",
					`attachment; filename="${exported.space}.zip"`,
				)
				.send(Buffer.from(zipStore(exported.files)));
		},
	);
	server.post<{ Params: SpaceParams; Body: SynapseImportRequest }>(
		"/synapse/spaces/:space/import",
		{
			bodyLimit: IMPORT_BODY_LIMIT,
			schema: {
				params: spaceParams,
				body: body(
					{
						files: {
							type: "array",
							maxItems: IMPORT_MAX_FILES,
							items: body(
								{
									path: { ...string, minLength: 1, maxLength: 1024 },
									content: string,
								},
								["path", "content"],
							),
						},
						overwrite: { type: "boolean" },
					},
					["files"],
				),
			},
		},
		(request) =>
			synapse.importSpace(request.params.space, request.body, actorOf(request)),
	);
	server.get<{ Querystring: { status?: SynapseProposalStatus } }>(
		"/synapse/proposals",
		{
			schema: {
				querystring: { type: "object", properties: { status } },
			},
		},
		async (request) => ({
			proposals: await synapse.listProposals({
				space: sharedSpaceId(requestWorkspace(request)),
				status: request.query.status,
			}),
		}),
	);
	// Approvals need a workspace admin: API tokens never hold synapse:decide.
	server.post<{ Params: { id: string }; Body: DecideSynapseProposalRequest }>(
		"/synapse/proposals/:id/decide",
		{
			schema: {
				params: idParams,
				body: body(
					{
						decision: { enum: ["approve", "reject"] },
						reason: { ...string, maxLength: MAX_REASON_LENGTH },
					},
					["decision"],
				),
			},
		},
		(request) => {
			const member = signedInMember(request);
			return synapse.decideProposal(
				request.params.id,
				request.body,
				{ kind: "user", id: member.id, name: member.name || member.email },
				sharedSpaceId(requestWorkspace(request)),
			);
		},
	);
}

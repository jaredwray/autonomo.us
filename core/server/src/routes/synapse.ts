import {
	type AppendSynapseNoteRequest,
	type CiteSynapseEvidenceRequest,
	type CreateSynapseCommitmentRequest,
	type CreateSynapseNoteRequest,
	type DecideSynapseFindingsRequest,
	type DecideSynapseProposalRequest,
	type SaveSynapseAnswerRequest,
	type SetSynapseDecisionStatusRequest,
	SYNAPSE_COMMITMENT_STATUSES,
	SYNAPSE_DECISION_STATUSES,
	SYNAPSE_GLOBAL_SPACE,
	SYNAPSE_SHARED_SPACE,
	SYNAPSE_SPACE_ID_PATTERN,
	type SynapseActor,
	type SynapseCaptureRequest,
	type SynapseCommitmentEvent,
	type SynapseCommitmentStatus,
	type SynapseContextRequest,
	type SynapseImportRequest,
	type SynapseNoteSort,
	type SynapseProposal,
	type SynapseProposalStatus,
	type SynapseSpaceId,
	type UpdateSynapseNoteRequest,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requestWorkspace, signedInMember } from "../auth/access.js";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import { mongoErrorDetails } from "../mongo.js";
import {
	captureInput,
	captureNeedsFetch,
	MAX_CAPTURE_LENGTH,
} from "../synapse/capture.js";
import { MAX_TASK_LENGTH } from "../synapse/context.js";
import { SynapseError } from "../synapse/errors.js";
import { type SynapseFeatures, synapseFeatures } from "../synapse/features.js";
import { MAX_FINDINGS } from "../synapse/maintenance.js";
import {
	MAX_ANSWER_EVIDENCE,
	MAX_PASSAGES,
	MAX_QUESTION_LENGTH,
} from "../synapse/retrieval.js";
import {
	agentSpaceId,
	MAX_QUERY_LIMIT,
	MAX_REASON_LENGTH,
	type SynapseService,
	sharedSpaceId,
} from "../synapse/synapse.js";
import { zipStore } from "../synapse/zip.js";

const IMPORT_BODY_LIMIT = 5 * 1024 * 1024;
/** A capture's text in JSON, with room for escapes. */
const CAPTURE_BODY_LIMIT = 2 * 1024 * 1024;
/** How long a capture may wait for the page it names. */
const CAPTURE_FETCH_MS = 60_000;
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
const revisionParams = {
	type: "object",
	required: ["space", "title", "revision"],
	properties: {
		space,
		title: titleParam,
		revision: { type: "integer", minimum: 1 },
	},
};
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const commitmentStatus = { enum: [...SYNAPSE_COMMITMENT_STATUSES] };
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

const spacePattern = new RegExp(SYNAPSE_SPACE_ID_PATTERN);

/**
 * Synapse inside one workspace, under `/v1/:workspace/synapse`. `shared` is
 * the workspace's shared space (which inherits `global`), `global` is the
 * gateway-wide space, and `agent-<id>` is open only for this workspace's agents.
 */
export async function synapseRoutes(
	server: FastifyInstance,
	{
		synapse,
		features,
		fetchPage,
		agentTokens,
		agentName,
		onProposalDecided,
	}: {
		synapse: SynapseService;
		/** What is built on the notes. Made for `synapse` when omitted. */
		features?: SynapseFeatures;
		/**
		 * Reads the page a capture names. Without it, and for anyone but a
		 * workspace admin, a capture needs the page's text.
		 */
		fetchPage?: (
			request: FastifyRequest,
			url: string,
			deadline: number,
		) => Promise<{
			ok: boolean;
			url: string;
			finalUrl: string;
			content: string;
			reason?: string;
		}>;
		/** Who has an agent space here: agent tokens and the gateway's bots. */
		agentTokens: Pick<AgentTokenStore, "ids">;
		/**
		 * An agent's name by its id, for a briefing asked for on its behalf:
		 * rules and commitments are addressed to agents by name.
		 */
		agentName?: (
			workspace: { id: string; isDefault: boolean },
			agentId: string,
		) => Promise<string | null>;
		/**
		 * Called once a proposal is decided, so its author can follow up. The
		 * decision stands whatever this does.
		 */
		onProposalDecided?: (
			workspaceId: string,
			proposal: SynapseProposal,
		) => Promise<unknown>;
	},
) {
	const { capture, retriever, commitments, briefing, maintenance } =
		features ?? synapseFeatures(synapse);
	/** A person, for what only a person may do: approve an answer, review a batch. */
	const person = (request: FastifyRequest): SynapseActor => {
		const member = signedInMember(request);
		return { kind: "user", id: member.id, name: member.name || member.email };
	};
	server.addHook("onRequest", async (request, reply) => {
		reply.header("cache-control", "no-store");
		// Decide access to the space before reading a body (an import is up to
		// 5 MB). A malformed ID is left to schema validation (400).
		const space = (request.params as { space?: string }).space;
		if (space === undefined || !spacePattern.test(space)) return;
		const workspace = requestWorkspace(request);
		if (space === SYNAPSE_GLOBAL_SPACE) {
			// The global space sits above every workspace: people who run the
			// whole gateway change it, and everyone else reads it.
			const write = request.method !== "GET" && request.method !== "HEAD";
			if (write && !(request.auth?.kind === "user" && workspace.implicit))
				throw new SynapseError(
					"Only owners and admins can change the global Synapse.",
					403,
				);
		} else if (space !== SYNAPSE_SHARED_SPACE) {
			const agents = await agentTokens.ids(workspace);
			if (!agents.has(space.slice("agent-".length)))
				throw new SynapseError("No such space in this workspace.", 404);
		}
	});
	// After validation: requests say `shared`; storage keys it by workspace.
	server.addHook("preHandler", async (request) => {
		const params = request.params as { space?: SynapseSpaceId };
		if (params.space === SYNAPSE_SHARED_SPACE)
			params.space = sharedSpaceId(requestWorkspace(request));
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
			agentTokenIds: await agentTokens.ids(requestWorkspace(request)),
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
	server.get<{ Params: SpaceParams }>(
		"/synapse/spaces/:space/graph",
		{ schema: { params: spaceParams } },
		(request) => synapse.graph(request.params.space),
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
	server.get<{ Params: NoteParams }>(
		"/synapse/spaces/:space/notes/:title/history",
		{ schema: { params: noteParams } },
		(request) => synapse.history(request.params.space, request.params.title),
	);
	server.get<{ Params: NoteParams & { revision: number } }>(
		"/synapse/spaces/:space/notes/:title/history/:revision",
		{ schema: { params: revisionParams } },
		(request) =>
			synapse.revision(
				request.params.space,
				request.params.title,
				request.params.revision,
			),
	);
	// `?expected=` restores only over that revision of the note (0: a note
	// that is gone), so a restore chosen from a stale page is a 409.
	server.post<{
		Params: NoteParams & { revision: number };
		Querystring: { expected?: number };
	}>(
		"/synapse/spaces/:space/notes/:title/history/:revision/restore",
		{
			schema: {
				params: revisionParams,
				querystring: {
					type: "object",
					additionalProperties: false,
					properties: { expected: { type: "integer", minimum: 0 } },
				},
			},
		},
		async (request) => {
			const { expected } = request.query;
			if (expected === 0) {
				// The caller saw no note: one that exists now is the conflict.
				const exists = await synapse.repository.getNote(
					request.params.space,
					request.params.title.toLowerCase(),
				);
				if (exists)
					throw new SynapseError(
						"This note changed during your request. Reload it and try again.",
						409,
					);
			}
			return synapse.restoreRevision(
				request.params.space,
				request.params.title,
				request.params.revision,
				actorOf(request),
				expected ? expected : undefined,
			);
		},
	);
	server.post<{ Params: NoteParams; Body: CiteSynapseEvidenceRequest }>(
		"/synapse/spaces/:space/notes/:title/evidence",
		{
			schema: {
				params: noteParams,
				body: body({ source: titleParam, passage: string }, [
					"source",
					"passage",
				]),
			},
		},
		(request) =>
			synapse.cite(
				request.params.space,
				request.params.title,
				request.body,
				actorOf(request),
			),
	);
	server.post<{ Params: NoteParams; Body: SetSynapseDecisionStatusRequest }>(
		"/synapse/spaces/:space/notes/:title/status",
		{
			schema: {
				params: noteParams,
				body: body(
					{
						status: { enum: [...SYNAPSE_DECISION_STATUSES] },
						supersededBy: titleParam,
						reason: { ...string, maxLength: MAX_REASON_LENGTH },
					},
					["status"],
				),
			},
		},
		(request) =>
			synapse.setDecisionStatus(
				request.params.space,
				request.params.title,
				request.body,
				actorOf(request),
			),
	);
	// Approving an answer makes it knowledge: that takes a person.
	server.post<{ Params: NoteParams }>(
		"/synapse/spaces/:space/notes/:title/approve",
		{ schema: { params: noteParams } },
		(request) =>
			retriever.approveAnswer(
				request.params.space,
				request.params.title,
				person(request),
			),
	);
	server.post<{ Params: SpaceParams; Body: SynapseCaptureRequest }>(
		"/synapse/spaces/:space/capture",
		{
			bodyLimit: CAPTURE_BODY_LIMIT,
			schema: {
				params: spaceParams,
				body: body({
					url: { ...string, maxLength: 2000 },
					text: { ...string, maxLength: MAX_CAPTURE_LENGTH },
					document: body(
						{
							name: { ...string, minLength: 1, maxLength: 200 },
							content: { ...string, maxLength: MAX_CAPTURE_LENGTH },
						},
						["name", "content"],
					),
					title: string,
					apply: { type: "boolean" },
				}),
			},
		},
		async (request) => {
			let fetched: { content: string; url: string } | undefined;
			if (captureNeedsFetch(request.body)) {
				// Check the address before anything is fetched for it.
				captureInput({ ...request.body, text: "" });
				// A fetch can spend the workspace's proxy budget, as POST /web/fetch does.
				const workspace = requestWorkspace(request);
				if (
					!fetchPage ||
					request.auth?.kind !== "user" ||
					workspace.role !== "admin"
				)
					throw new SynapseError(
						fetchPage
							? "Only a workspace admin can capture a page by its address alone. Send the page's text along with the url."
							: "Web access is turned off on this gateway. Send the page's text along with the url.",
						fetchPage ? 403 : 400,
					);
				const page = await fetchPage(
					request,
					request.body.url as string,
					Date.now() + CAPTURE_FETCH_MS,
				);
				if (!page.ok)
					throw new SynapseError(
						`Could not fetch ${page.url}. ${page.reason ?? ""}`.trim(),
						502,
					);
				fetched = { content: page.content, url: page.finalUrl };
			}
			return capture.capture(
				request.params.space,
				captureInput(request.body, fetched),
				actorOf(request),
			);
		},
	);
	server.get<{
		Params: SpaceParams;
		Querystring: { question: string; limit?: number };
	}>(
		"/synapse/spaces/:space/retrieve",
		{
			schema: {
				params: spaceParams,
				querystring: {
					type: "object",
					required: ["question"],
					properties: {
						question: { ...string, maxLength: MAX_QUESTION_LENGTH },
						limit: { type: "integer", minimum: 1, maximum: MAX_PASSAGES },
					},
				},
			},
		},
		(request) => retriever.retrieve([request.params.space], request.query),
	);
	server.post<{ Params: SpaceParams; Body: SaveSynapseAnswerRequest }>(
		"/synapse/spaces/:space/answers",
		{
			schema: {
				params: spaceParams,
				body: body(
					{
						question: { ...string, maxLength: MAX_QUESTION_LENGTH },
						answer: string,
						evidence: {
							type: "array",
							maxItems: MAX_ANSWER_EVIDENCE,
							items: body({ source: titleParam, passage: string }, [
								"source",
								"passage",
							]),
						},
						title: string,
					},
					["question", "answer", "evidence"],
				),
			},
		},
		async (request, reply) =>
			reply
				.code(201)
				.send(
					await retriever.saveAnswer(
						request.params.space,
						request.body,
						actorOf(request),
					),
				),
	);
	server.get<{
		Params: SpaceParams;
		Querystring: {
			status?: SynapseCommitmentStatus;
			owner?: string;
			project?: string;
			overdue?: boolean;
		};
	}>(
		"/synapse/spaces/:space/commitments",
		{
			schema: {
				params: spaceParams,
				querystring: {
					type: "object",
					properties: {
						status: commitmentStatus,
						owner: titleParam,
						project: titleParam,
						overdue: { type: "boolean" },
					},
				},
			},
		},
		async (request) => ({
			commitments: await commitments.list(request.params.space, request.query),
		}),
	);
	server.post<{ Params: SpaceParams; Body: CreateSynapseCommitmentRequest }>(
		"/synapse/spaces/:space/commitments",
		{
			schema: {
				params: spaceParams,
				body: body(
					{
						title: string,
						// A name or a list of names; the service checks which.
						owner: {},
						due: date,
						project: {},
						evidence: { ...string, maxLength: 500 },
						body: string,
					},
					["title", "owner", "evidence"],
				),
			},
		},
		async (request, reply) =>
			reply
				.code(201)
				.send(
					await commitments.create(
						request.params.space,
						request.body,
						actorOf(request),
					),
				),
	);
	server.post<{ Params: NoteParams; Body: SynapseCommitmentEvent }>(
		"/synapse/spaces/:space/commitments/:title/events",
		{
			schema: {
				params: noteParams,
				body: body(
					{
						kind: {
							enum: [
								"message",
								"meeting",
								"transcript",
								"confirmation",
								"calendar",
							],
						},
						status: commitmentStatus,
						due: date,
						evidence: { ...string, maxLength: 500 },
						text: { ...string, maxLength: 1000 },
					},
					["kind"],
				),
			},
		},
		(request) =>
			commitments.record(
				request.params.space,
				request.params.title,
				request.body,
				actorOf(request),
			),
	);
	// A briefing for an agent that does not speak MCP: the workspace's canon,
	// and one of its agents' own space when the request names it.
	server.post<{ Body: SynapseContextRequest & { agent?: string } }>(
		"/synapse/context",
		{
			schema: {
				body: body({
					task: { ...string, maxLength: MAX_TASK_LENGTH },
					project: titleParam,
					agent: { ...string, pattern: "^[A-Za-z0-9_-]{1,64}$" },
				}),
			},
		},
		async (request) => {
			const workspace = requestWorkspace(request);
			const { agent, ...brief } = request.body ?? {};
			if (agent !== undefined && !(await agentTokens.ids(workspace)).has(agent))
				throw new SynapseError("No such agent in this workspace.", 404);
			return briefing.brief(
				{
					shared: sharedSpaceId(workspace),
					...(agent === undefined
						? {}
						: {
								own: agentSpaceId(agent),
								agentName:
									(await agentName?.(workspace, agent).catch(() => null)) ??
									undefined,
							}),
				},
				brief,
			);
		},
	);
	server.get<{ Params: SpaceParams }>(
		"/synapse/spaces/:space/maintenance",
		{ schema: { params: spaceParams } },
		(request) => maintenance.view(request.params.space),
	);
	server.post<{ Params: SpaceParams }>(
		"/synapse/spaces/:space/maintenance/run",
		{ schema: { params: spaceParams } },
		async (request) => ({
			batch: await maintenance.run(request.params.space, true),
		}),
	);
	// A review applies fixes that merge and delete notes: that takes a person.
	server.post<{ Params: SpaceParams; Body: DecideSynapseFindingsRequest }>(
		"/synapse/spaces/:space/maintenance/decide",
		{
			schema: {
				params: spaceParams,
				body: body(
					{
						ids: {
							type: "array",
							minItems: 1,
							maxItems: MAX_FINDINGS,
							items: { ...string, maxLength: 64 },
						},
						decision: { enum: ["apply", "dismiss"] },
						revision: { type: "integer", minimum: 1 },
					},
					["ids", "decision"],
				),
			},
		},
		(request) =>
			maintenance.decide(request.params.space, request.body, person(request)),
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
		async (request) => {
			const member = signedInMember(request);
			const workspace = requestWorkspace(request);
			const decided = await synapse.decideProposal(
				request.params.id,
				request.body,
				{ kind: "user", id: member.id, name: member.name || member.email },
				sharedSpaceId(workspace),
			);
			await onProposalDecided?.(workspace.id, decided).catch(() => {});
			return decided;
		},
	);
}

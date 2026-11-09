import {
	type AppendBrainNoteRequest,
	BRAIN_VAULT_ID_PATTERN,
	type BrainActor,
	type BrainImportRequest,
	type BrainNoteSort,
	type BrainProposalStatus,
	type BrainVaultId,
	type CreateBrainNoteRequest,
	type DecideBrainProposalRequest,
	type UpdateBrainNoteRequest,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { signedInMember } from "../auth/access.js";
import { AccountStore } from "../auth/accounts.js";
import {
	type BrainService,
	MAX_QUERY_LIMIT,
	MAX_REASON_LENGTH,
} from "../brain/brain.js";
import { BrainError } from "../brain/errors.js";
import { zipStore } from "../brain/zip.js";
import { mongoErrorDetails } from "../mongo.js";

const IMPORT_BODY_LIMIT = 5 * 1024 * 1024;
const IMPORT_MAX_FILES = 500;
const string = { type: "string" };
const vault = { type: "string", pattern: BRAIN_VAULT_ID_PATTERN };
const titleParam = { type: "string", minLength: 1, maxLength: 200 };
const vaultParams = {
	type: "object",
	required: ["vault"],
	properties: { vault },
};
const noteParams = {
	type: "object",
	required: ["vault", "title"],
	properties: { vault, title: titleParam },
};
const dateParams = {
	type: "object",
	required: ["vault", "date"],
	properties: {
		vault,
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

type VaultParams = { vault: BrainVaultId };
type NoteParams = VaultParams & { title: string };
type NotesQuery = Record<string, string | undefined> & {
	sort?: BrainNoteSort;
	direction?: "asc" | "desc";
	limit?: number;
	offset?: number;
};

function actorOf(request: FastifyRequest): BrainActor {
	const auth = request.auth;
	if (auth?.kind === "user")
		return {
			kind: "user",
			id: auth.member.id,
			name: auth.member.name || auth.member.email,
		};
	if (auth?.kind === "api-token")
		return { kind: "api-token", id: auth.token.id, name: auth.token.name };
	throw new BrainError("Sign in or provide an API token.", 403);
}

export async function brainRoutes(
	server: FastifyInstance,
	{ brain }: { brain: BrainService },
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	// Store errors carry a status; validation failures are 400s. Both answer
	// in the gateway's `{ error: { message } }` shape.
	server.setErrorHandler((error: unknown, request, reply) => {
		const failure = error as { statusCode?: unknown; message?: unknown };
		const status =
			typeof failure.statusCode === "number" && failure.statusCode >= 400
				? failure.statusCode
				: 500;
		// A BrainError's cause may be a driver error whose message holds the URI.
		if (status >= 500)
			request.log.error(
				error instanceof BrainError
					? { ...mongoErrorDetails(error), message: error.message }
					: error,
				"Brain request failed",
			);
		return reply.code(status).send({
			error: {
				message:
					status < 500 || error instanceof BrainError
						? String(failure.message)
						: "The Brain hit an unexpected error.",
			},
		});
	});

	server.get("/v1/brain/vaults", () => brain.listVaults());
	server.get("/v1/brain/templates", () => ({ templates: brain.templates() }));

	server.get<{ Params: VaultParams; Querystring: NotesQuery }>(
		"/v1/brain/vaults/:vault/notes",
		{
			schema: {
				params: vaultParams,
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
			return brain.query(request.params.vault, {
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
	server.post<{ Params: VaultParams; Body: CreateBrainNoteRequest }>(
		"/v1/brain/vaults/:vault/notes",
		{
			schema: {
				params: vaultParams,
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
					await brain.createNote(
						request.params.vault,
						request.body,
						actorOf(request),
					),
				),
	);
	server.get<{ Params: NoteParams }>(
		"/v1/brain/vaults/:vault/notes/:title",
		{ schema: { params: noteParams } },
		(request) => brain.viewNote(request.params.vault, request.params.title),
	);
	server.patch<{ Params: NoteParams; Body: UpdateBrainNoteRequest }>(
		"/v1/brain/vaults/:vault/notes/:title",
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
			brain.updateNote(
				request.params.vault,
				request.params.title,
				request.body,
				actorOf(request),
			),
	);
	server.post<{ Params: NoteParams; Body: AppendBrainNoteRequest }>(
		"/v1/brain/vaults/:vault/notes/:title/append",
		{
			schema: {
				params: noteParams,
				body: body({ text: string, template: string }, ["text"]),
			},
		},
		async (request, reply) => {
			const { note, created } = await brain.appendNote(
				request.params.vault,
				request.params.title,
				request.body,
				actorOf(request),
			);
			return reply.code(created ? 201 : 200).send(note);
		},
	);
	server.delete<{ Params: NoteParams }>(
		"/v1/brain/vaults/:vault/notes/:title",
		{ schema: { params: noteParams } },
		async (request, reply) => {
			await brain.deleteNote(
				request.params.vault,
				request.params.title,
				actorOf(request),
			);
			return reply.code(204).send();
		},
	);
	server.get<{ Params: VaultParams; Querystring: { limit?: number } }>(
		"/v1/brain/vaults/:vault/unresolved",
		{
			schema: {
				params: vaultParams,
				querystring: {
					type: "object",
					properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } },
				},
			},
		},
		async (request) => ({
			links: await brain.unresolved(
				request.params.vault,
				request.query.limit ?? 200,
			),
		}),
	);
	server.get<{ Params: VaultParams }>(
		"/v1/brain/vaults/:vault/categories",
		{ schema: { params: vaultParams } },
		async (request) => ({
			categories: await brain.categories(request.params.vault),
		}),
	);
	server.get<{ Params: VaultParams & { date: string } }>(
		"/v1/brain/vaults/:vault/daily/:date",
		{ schema: { params: dateParams } },
		(request) => brain.daily(request.params.vault, request.params.date),
	);
	server.get<{ Params: VaultParams; Querystring: { format?: "json" | "zip" } }>(
		"/v1/brain/vaults/:vault/export",
		{
			schema: {
				params: vaultParams,
				querystring: {
					type: "object",
					properties: { format: { enum: ["json", "zip"] } },
				},
			},
		},
		async (request, reply) => {
			const exported = await brain.exportVault(request.params.vault);
			if (request.query.format !== "zip") return exported;
			return reply
				.header("content-type", "application/zip")
				.header(
					"content-disposition",
					`attachment; filename="${request.params.vault}.zip"`,
				)
				.send(Buffer.from(zipStore(exported.files)));
		},
	);
	server.post<{ Params: VaultParams; Body: BrainImportRequest }>(
		"/v1/brain/vaults/:vault/import",
		{
			bodyLimit: IMPORT_BODY_LIMIT,
			schema: {
				params: vaultParams,
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
			brain.importVault(request.params.vault, request.body, actorOf(request)),
	);
	server.get<{ Querystring: { status?: BrainProposalStatus } }>(
		"/v1/brain/proposals",
		{
			schema: {
				querystring: { type: "object", properties: { status } },
			},
		},
		async (request) => ({
			proposals: await brain.listProposals({ status: request.query.status }),
		}),
	);
	// Approvals need a person: API tokens are refused by signedInMember.
	server.post<{ Params: { id: string }; Body: DecideBrainProposalRequest }>(
		"/v1/brain/proposals/:id/decide",
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
			if (!AccountStore.canManage(member))
				throw new BrainError("Only owners and admins decide proposals.", 403);
			return brain.decideProposal(request.params.id, request.body, {
				kind: "user",
				id: member.id,
				name: member.name || member.email,
			});
		},
	);
}

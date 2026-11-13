import type { CreateBotRequest, UpdateBotRequest } from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requestWorkspace, signedInMember } from "../auth/access.js";
import type { BotService } from "../bots/bots.js";
import { mongoErrorDetails } from "../mongo.js";
import { ServiceError } from "../service-error.js";

const string = { type: "string" };
const uuid = { type: "string", format: "uuid" };
const botParams = {
	type: "object",
	required: ["bot"],
	properties: { bot: uuid },
};
const integer = { type: "integer" };
const fields = {
	name: string,
	instructions: string,
	model: string,
	enabled: { type: "boolean" },
	tools: { type: "boolean" },
	agentHops: integer,
	limits: {
		type: "object",
		additionalProperties: false,
		properties: {
			repliesPerHour: integer,
			tokensPerDay: integer,
			maxOutputTokens: integer,
			contextMessages: integer,
		},
	},
};

/**
 * Bots the gateway runs, under `/v1/:workspace/bots`. Members see them;
 * workspace admins create and change them, because a bot spends the
 * workspace's provider keys.
 */
export async function botRoutes(
	server: FastifyInstance,
	{ bots }: { bots: BotService },
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	server.setErrorHandler((error: unknown, request, reply) => {
		const failure = error as { statusCode?: unknown; message?: unknown };
		const status =
			typeof failure.statusCode === "number" && failure.statusCode >= 400
				? failure.statusCode
				: 500;
		// A service error's cause may be a driver error whose message holds the URI.
		if (status >= 500)
			request.log.error(
				error instanceof ServiceError
					? { ...mongoErrorDetails(error), message: error.message }
					: error,
				"Bots request failed",
			);
		return reply.code(status).send({
			error: {
				message:
					status < 500 || error instanceof ServiceError
						? String(failure.message)
						: "Bots hit an unexpected error.",
			},
		});
	});
	const workspaceId = (request: FastifyRequest) => requestWorkspace(request).id;

	server.get("/bots", (request) => bots.list(workspaceId(request)));
	server.post<{ Body: CreateBotRequest }>(
		"/bots",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name", "model"],
					properties: fields,
				},
			},
		},
		async (request, reply) => {
			const member = signedInMember(request);
			return reply
				.code(201)
				.send(
					await bots.create(
						workspaceId(request),
						request.body,
						member.name || member.email,
					),
				);
		},
	);
	server.get<{ Querystring: { channel: string } }>(
		"/bots/activity",
		{
			schema: {
				querystring: {
					type: "object",
					required: ["channel"],
					properties: { channel: uuid },
				},
			},
		},
		(request) => bots.activity(workspaceId(request), request.query.channel),
	);
	server.get<{ Params: { bot: string } }>(
		"/bots/:bot",
		{ schema: { params: botParams } },
		(request) => bots.get(workspaceId(request), request.params.bot),
	);
	server.patch<{ Params: { bot: string }; Body: UpdateBotRequest }>(
		"/bots/:bot",
		{
			schema: {
				params: botParams,
				body: {
					type: "object",
					additionalProperties: false,
					properties: { ...fields, revision: { type: "integer", minimum: 1 } },
				},
			},
		},
		(request) =>
			bots.update(workspaceId(request), request.params.bot, request.body),
	);
	server.delete<{ Params: { bot: string } }>(
		"/bots/:bot",
		{ schema: { params: botParams } },
		async (request, reply) => {
			await bots.remove(workspaceId(request), request.params.bot);
			return reply.code(204).send();
		},
	);
}

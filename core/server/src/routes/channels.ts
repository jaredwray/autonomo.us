import {
	CHANNEL_LIMITS,
	type CreateChannelRequest,
	type EditChannelMessageRequest,
	type MarkChannelReadRequest,
	type PostChannelMessageRequest,
	type SetChannelAgentRequest,
	type UpdateChannelRequest,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { memberMay, requestWorkspace } from "../auth/access.js";
import type { ChannelCaller, ChannelService } from "../channels/channels.js";
import { ChannelError } from "../channels/errors.js";
import { mongoErrorDetails } from "../mongo.js";
import { ServiceError } from "../service-error.js";

const string = { type: "string" };
const uuid = { type: "string", format: "uuid" };
const channelParams = {
	type: "object",
	required: ["channel"],
	properties: { channel: uuid },
};
const messageParams = {
	type: "object",
	required: ["channel", "message"],
	properties: { channel: uuid, message: uuid },
};
const agentParams = {
	type: "object",
	required: ["channel", "agentTokenId"],
	properties: { channel: uuid, agentTokenId: uuid },
};
const body = (properties: Record<string, object>, required: string[] = []) => ({
	type: "object",
	additionalProperties: false,
	...(required.length ? { required } : {}),
	properties,
});

type ChannelParams = { channel: string };
type MessageParams = ChannelParams & { message: string };

/** The person or API token behind a request, as the channel service sees it. */
function callerOf(request: FastifyRequest): ChannelCaller {
	const auth = request.auth;
	if (auth?.kind === "user")
		return {
			actor: {
				kind: "user",
				id: auth.member.id,
				name: auth.member.name || auth.member.email,
			},
			moderate: memberMay(requestWorkspace(request), "channels:moderate"),
		};
	if (auth?.kind === "api-token")
		return {
			actor: { kind: "api-token", id: auth.token.id, name: auth.token.name },
		};
	throw new ChannelError("Sign in or provide an API token.", 403);
}

/** Aborts when the client goes away, so a long poll stops looking. */
function clientSignal(reply: FastifyReply): AbortSignal {
	const controller = new AbortController();
	reply.raw.once("close", () => {
		if (!reply.raw.writableEnded) controller.abort();
	});
	return controller.signal;
}

/** Channels of one workspace, under `/v1/:workspace/channels`. */
export async function channelRoutes(
	server: FastifyInstance,
	{ channels }: { channels: ChannelService },
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	// Service errors carry a status; validation failures are 400s. Both answer
	// in the gateway's `{ error: { message } }` shape.
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
				"Channels request failed",
			);
		if (status === 429) reply.header("retry-after", "60");
		return reply.code(status).send({
			error: {
				message:
					status < 500 || error instanceof ServiceError
						? String(failure.message)
						: "Channels hit an unexpected error.",
			},
		});
	});
	const workspaceId = (request: FastifyRequest) => requestWorkspace(request).id;

	server.get<{ Querystring: { archived?: boolean } }>(
		"/channels",
		{
			schema: {
				querystring: {
					type: "object",
					properties: { archived: { type: "boolean" } },
				},
			},
		},
		(request) =>
			channels.listChannels(workspaceId(request), callerOf(request), {
				archived: request.query.archived ?? false,
			}),
	);
	server.post<{ Body: CreateChannelRequest }>(
		"/channels",
		{
			schema: {
				body: body({ name: string, topic: string, description: string }, [
					"name",
				]),
			},
		},
		async (request, reply) =>
			reply
				.code(201)
				.send(
					await channels.createChannel(
						workspaceId(request),
						callerOf(request),
						request.body,
					),
				),
	);
	// The workspace's agents, for the picker. Token management itself stays
	// with org owners and admins; this returns names and ids only.
	server.get("/channels/agents", (request) =>
		channels.agentOptions(workspaceId(request), callerOf(request)),
	);

	server.get<{ Params: ChannelParams }>(
		"/channels/:channel",
		{ schema: { params: channelParams } },
		(request) =>
			channels.getChannel(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
			),
	);
	server.patch<{ Params: ChannelParams; Body: UpdateChannelRequest }>(
		"/channels/:channel",
		{
			schema: {
				params: channelParams,
				body: body({
					name: string,
					topic: string,
					description: string,
					revision: { type: "integer", minimum: 1 },
				}),
			},
		},
		(request) =>
			channels.updateChannel(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
				request.body,
			),
	);
	for (const [path, archived] of [
		["archive", true],
		["unarchive", false],
	] as const)
		server.post<{ Params: ChannelParams }>(
			`/channels/:channel/${path}`,
			{ schema: { params: channelParams } },
			(request) =>
				channels.setArchived(
					workspaceId(request),
					callerOf(request),
					request.params.channel,
					archived,
				),
		);

	server.get<{ Params: ChannelParams }>(
		"/channels/:channel/members",
		{ schema: { params: channelParams } },
		(request) =>
			channels.members(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
			),
	);
	server.put<{
		Params: ChannelParams & { agentTokenId: string };
		Body: SetChannelAgentRequest;
	}>(
		"/channels/:channel/agents/:agentTokenId",
		{
			schema: {
				params: agentParams,
				body: body({ access: { enum: ["read", "post"] } }, ["access"]),
			},
		},
		(request) =>
			channels.setAgent(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
				request.params.agentTokenId,
				request.body.access,
			),
	);
	server.delete<{ Params: ChannelParams & { agentTokenId: string } }>(
		"/channels/:channel/agents/:agentTokenId",
		{ schema: { params: agentParams } },
		(request) =>
			channels.setAgent(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
				request.params.agentTokenId,
				null,
			),
	);

	server.get<{
		Params: ChannelParams;
		Querystring: {
			after?: number;
			before?: number;
			thread?: string;
			limit?: number;
			wait?: number;
		};
	}>(
		"/channels/:channel/messages",
		{
			schema: {
				params: channelParams,
				querystring: {
					type: "object",
					properties: {
						after: { type: "integer", minimum: 0 },
						before: { type: "integer", minimum: 1 },
						thread: uuid,
						limit: {
							type: "integer",
							minimum: 1,
							maximum: CHANNEL_LIMITS.maxPageSize,
						},
						wait: {
							type: "integer",
							minimum: 0,
							maximum: CHANNEL_LIMITS.maxWaitSeconds,
						},
					},
				},
			},
		},
		(request, reply) =>
			channels.read(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
				{
					...request.query,
					signal: request.query.wait ? clientSignal(reply) : undefined,
				},
			),
	);
	server.post<{ Params: ChannelParams; Body: PostChannelMessageRequest }>(
		"/channels/:channel/messages",
		{
			schema: {
				params: channelParams,
				body: body({ body: string, threadId: uuid, nonce: string }, ["body"]),
			},
		},
		async (request, reply) => {
			const { message, created } = await channels.post(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
				request.body,
			);
			// A retry with a nonce that already landed returns the first message.
			return reply.code(created ? 201 : 200).send(message);
		},
	);
	server.patch<{ Params: MessageParams; Body: EditChannelMessageRequest }>(
		"/channels/:channel/messages/:message",
		{
			schema: { params: messageParams, body: body({ body: string }, ["body"]) },
		},
		(request) =>
			channels.editMessage(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
				request.params.message,
				request.body,
			),
	);
	server.delete<{ Params: MessageParams }>(
		"/channels/:channel/messages/:message",
		{ schema: { params: messageParams } },
		async (request, reply) => {
			await channels.deleteMessage(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
				request.params.message,
			);
			return reply.code(204).send();
		},
	);
	server.put<{ Params: ChannelParams; Body: MarkChannelReadRequest }>(
		"/channels/:channel/read",
		{
			schema: {
				params: channelParams,
				body: body({ seq: { type: "integer", minimum: 0 } }, ["seq"]),
			},
		},
		(request) =>
			channels.markRead(
				workspaceId(request),
				callerOf(request),
				request.params.channel,
				request.body.seq,
			),
	);
}

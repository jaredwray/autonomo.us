import {
	AGENT_TOKEN_PERMISSIONS,
	type AgentConnectionList,
	type AgentList,
	type AgentSummary,
	type ApproveOAuthSignInRequest,
	type CreateOAuthAgentRequest,
	type OAuthSignInDecision,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requestWorkspace, signedInMember } from "../auth/access.js";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import { ApiTokenError } from "../auth/token-store.js";
import type { BotService } from "../bots/bots.js";
import { mongoErrorDetails } from "../mongo.js";
import type { OAuthService } from "../oauth/oauth.js";
import { ServiceError } from "../service-error.js";

const uuid = { type: "string", format: "uuid" };
const signInId = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" };
const agentFields = {
	name: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
	description: { type: "string", maxLength: 1000 },
	permissions: {
		type: "array",
		maxItems: Object.keys(AGENT_TOKEN_PERMISSIONS).length,
		uniqueItems: true,
		items: { type: "string", enum: Object.keys(AGENT_TOKEN_PERMISSIONS) },
	},
};
const agentBody = {
	type: "object",
	additionalProperties: false,
	required: ["name", "description"],
	properties: agentFields,
};

function errors(server: FastifyInstance) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	server.setErrorHandler((error: unknown, request, reply) => {
		const failure = error as { statusCode?: unknown; message?: unknown };
		const status =
			typeof failure.statusCode === "number" && failure.statusCode >= 400
				? failure.statusCode
				: 500;
		const known =
			error instanceof ServiceError || error instanceof ApiTokenError;
		// A storage error's cause may be a driver error whose message holds the URI.
		if (status >= 500)
			request.log.error(
				known
					? { ...mongoErrorDetails(error), message: failure.message }
					: error,
				"Agents request failed",
			);
		return reply.code(status).send({
			error: {
				message:
					status < 500 || known
						? String(failure.message)
						: "Agents hit an unexpected error.",
			},
		});
	});
}
const actor = (request: FastifyRequest) => {
	const member = signedInMember(request);
	return member.name || member.email;
};

export type AgentRouteOptions = {
	agentTokens: AgentTokenStore;
	bots: BotService;
	oauth: OAuthService;
};

/**
 * A workspace's agents as one list, whichever way each was made, and what
 * only OAuth agents have: creation without a token, the apps signed in to
 * them, and approving a sign-in. Members see the list; workspace admins do
 * the rest. Agents with instructions are managed under `/bots`, and agents
 * that use MCP are edited and revoked under `/agent-tokens`.
 */
export async function agentRoutes(
	server: FastifyInstance,
	{ agentTokens, bots, oauth }: AgentRouteOptions,
) {
	errors(server);

	server.get("/agents", async (request): Promise<AgentList> => {
		const workspace = requestWorkspace(request);
		const [tokens, hosted, connections] = await Promise.all([
			agentTokens.settings(workspace, true),
			bots.list(workspace.id),
			oauth.connections(workspace.id),
		]);
		const connected = new Map<string, number>();
		for (const connection of connections)
			connected.set(
				connection.agentId,
				(connected.get(connection.agentId) ?? 0) + 1,
			);
		const agents: AgentSummary[] = [
			...hosted.bots.map((bot) => ({
				id: bot.id,
				kind: "instructions" as const,
				name: bot.name,
				description: "",
				status: bot.enabled ? ("active" as const) : ("paused" as const),
				permissions: [],
				model: bot.model,
				connections: 0,
				createdAt: bot.createdAt,
			})),
			...tokens.tokens.map((token) => ({
				id: token.id,
				kind: token.auth,
				name: token.name,
				description: token.description,
				status: token.status,
				permissions: token.permissions,
				model: null,
				connections: connected.get(token.id) ?? 0,
				createdAt: token.createdAt,
			})),
		];
		return {
			agents: agents.sort(
				(a, b) =>
					a.name.localeCompare(b.name) ||
					a.createdAt.localeCompare(b.createdAt),
			),
			persistence: tokens.persistence,
		};
	});

	server.post<{ Body: CreateOAuthAgentRequest }>(
		"/agents/oauth",
		{ schema: { body: agentBody } },
		async (request, reply) =>
			reply
				.code(201)
				.send(
					await agentTokens.createOAuth(
						requestWorkspace(request),
						request.body,
						"user",
						actor(request),
					),
				),
	);

	/** An agent of this workspace that signs in with OAuth and is not revoked. */
	const oauthAgent = async (request: FastifyRequest, id: string) => {
		const workspace = requestWorkspace(request);
		const found = (await agentTokens.settings(workspace, true)).tokens.find(
			(token) => token.id === id,
		);
		if (!found) throw new ApiTokenError("Agent not found.", 404);
		if (found.auth !== "oauth")
			throw new ApiTokenError(
				"Only an agent that signs in with OAuth has connections.",
				409,
			);
		return found;
	};

	const agentParams = {
		type: "object",
		required: ["agent"],
		properties: { agent: uuid },
	};
	server.get<{ Params: { agent: string } }>(
		"/agents/:agent/connections",
		{ schema: { params: agentParams } },
		async (request): Promise<AgentConnectionList> => {
			const agent = await oauthAgent(request, request.params.agent);
			return {
				connections: await oauth.connections(
					requestWorkspace(request).id,
					agent.id,
				),
			};
		},
	);
	server.delete<{ Params: { agent: string; connection: string } }>(
		"/agents/:agent/connections/:connection",
		{
			schema: {
				params: {
					type: "object",
					required: ["agent", "connection"],
					properties: { agent: uuid, connection: uuid },
				},
			},
		},
		async (request, reply) => {
			const agent = await oauthAgent(request, request.params.agent);
			await oauth.disconnect(
				requestWorkspace(request).id,
				agent.id,
				request.params.connection,
				actor(request),
			);
			return reply.code(204).send();
		},
	);

	server.post<{ Params: { id: string }; Body: ApproveOAuthSignInRequest }>(
		"/oauth/sign-ins/:id/approve",
		{
			schema: {
				params: {
					type: "object",
					required: ["id"],
					properties: { id: signInId },
				},
				body: {
					type: "object",
					additionalProperties: false,
					minProperties: 1,
					maxProperties: 1,
					properties: { agentId: uuid, agent: agentBody },
				},
			},
		},
		async (request): Promise<OAuthSignInDecision> => {
			const workspace = requestWorkspace(request);
			const body = request.body;
			let agentId: string;
			if ("agentId" in body) {
				const agent = await oauthAgent(request, body.agentId);
				if (agent.status !== "active")
					throw new ApiTokenError("This agent has been revoked.", 409);
				await oauth.approvable(request.params.id, workspace.id, agent.id);
				agentId = agent.id;
			} else {
				// Refuse a sign-in that has expired before making an agent for it.
				await oauth.approvable(request.params.id, workspace.id);
				agentId = (
					await agentTokens.createOAuth(
						workspace,
						body.agent,
						"user",
						actor(request),
					)
				).id;
			}
			return {
				redirectTo: await oauth.approve(
					request.params.id,
					{ workspaceId: workspace.id, agentId },
					actor(request),
				),
			};
		},
	);
}

/**
 * Looking at a sign-in and refusing it. Any signed-in person may: neither
 * grants anything, and the workspace is only chosen on approval.
 */
export async function oauthSignInRoutes(
	server: FastifyInstance,
	{ oauth }: { oauth: OAuthService },
) {
	errors(server);
	const params = {
		type: "object",
		required: ["id"],
		properties: { id: signInId },
	};
	server.get<{ Params: { id: string } }>(
		"/v1/oauth/sign-ins/:id",
		{ schema: { params } },
		(request) => {
			signedInMember(request);
			return oauth.signIn(request.params.id);
		},
	);
	server.post<{ Params: { id: string } }>(
		"/v1/oauth/sign-ins/:id/deny",
		{ schema: { params } },
		async (request): Promise<OAuthSignInDecision> => {
			signedInMember(request);
			return { redirectTo: await oauth.deny(request.params.id) };
		},
	);
}

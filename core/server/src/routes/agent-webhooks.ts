import {
	AGENT_WEBHOOK_EVENTS,
	AGENT_WEBHOOK_LIMITS,
	type AgentWebhook,
	type AgentWebhookDetails,
	type AgentWebhookEventGroup,
	type AgentWebhookSecret,
	type AgentWebhookTestResult,
	type CreateAgentWebhookRequest,
	type UpdateAgentWebhookRequest,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AgentWebhookError } from "../agent-webhooks/errors.js";
import type { AgentWebhooks } from "../agent-webhooks/webhooks.js";
import { requestWorkspace, signedInMember } from "../auth/access.js";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import type { BotService } from "../bots/bots.js";
import { agentRouteErrors } from "./agents.js";

const params = {
	type: "object",
	required: ["agent"],
	properties: { agent: { type: "string", format: "uuid" } },
};
/** The groups of events a webhook can choose, from the shared catalog. */
const events = {
	type: "array",
	minItems: 1,
	maxItems: Object.keys(AGENT_WEBHOOK_EVENTS).length,
	uniqueItems: true,
	items: { type: "string", enum: Object.keys(AGENT_WEBHOOK_EVENTS) },
};
const url = { type: "string", maxLength: AGENT_WEBHOOK_LIMITS.urlLength };
const authKey = {
	type: "string",
	maxLength: AGENT_WEBHOOK_LIMITS.authKeyLength,
};
const headers = {
	type: "array",
	maxItems: AGENT_WEBHOOK_LIMITS.headers,
	items: {
		type: "object",
		additionalProperties: false,
		required: ["name", "value"],
		properties: {
			name: {
				type: "string",
				maxLength: AGENT_WEBHOOK_LIMITS.headerNameLength,
			},
			value: {
				type: "string",
				maxLength: AGENT_WEBHOOK_LIMITS.headerValueLength,
			},
		},
	},
};
/** A union type, not `anyOf`: with type coercion, `anyOf` turns null into "". */
const orNull = (schema: { type: string }) => ({
	...schema,
	type: [schema.type, "null"],
});

const groups = (list: readonly AgentWebhookEventGroup[]) =>
	list.map((group) => AGENT_WEBHOOK_EVENTS[group].toLowerCase()).join(", ");
/** Only the host goes into history: a path can carry a secret. */
const host = (value: string) => new URL(value).host;

export type AgentWebhookRouteOptions = {
	webhooks: AgentWebhooks;
	agentTokens: AgentTokenStore;
	bots: Pick<BotService, "bots">;
};

/**
 * An agent's webhook, under `/agents/:agent/webhook`: the URL the gateway
 * POSTs to when something should wake the agent. Workspace admins only,
 * since the settings hold the receiver's credentials. Changes are written to
 * the agent's history without any secret.
 */
export async function agentWebhookRoutes(
	server: FastifyInstance,
	{ webhooks, agentTokens, bots }: AgentWebhookRouteOptions,
) {
	agentRouteErrors(server);
	const actor = (request: FastifyRequest) => {
		const member = signedInMember(request);
		return member.name || member.email;
	};
	/**
	 * An agent of this workspace that uses MCP. `live`: refuse a revoked one,
	 * which can no longer be woken.
	 */
	const mcpAgent = async (request: FastifyRequest, live: boolean) => {
		const workspace = requestWorkspace(request);
		const id = (request.params as { agent: string }).agent;
		const found = (await agentTokens.settings(workspace, true)).tokens.find(
			(token) => token.id === id,
		);
		if (!found) {
			const hosted = (await bots.bots(workspace.id)).some(
				(bot) => bot.id === id,
			);
			throw hosted
				? new AgentWebhookError(
						"An agent with instructions runs inside the gateway, so it needs no webhook.",
						409,
					)
				: new AgentWebhookError("Agent not found.", 404);
		}
		if (live && found.status === "revoked")
			throw new AgentWebhookError("This agent has been revoked.", 409);
		return { workspace, agent: found };
	};
	const note = (
		request: FastifyRequest,
		agentId: string,
		detail: string,
	): Promise<unknown> =>
		agentTokens
			.note(
				requestWorkspace(request),
				agentId,
				"updated",
				detail,
				actor(request),
			)
			.catch(() => {});

	server.get<{ Params: { agent: string } }>(
		"/agents/:agent/webhook",
		{ schema: { params } },
		async (request): Promise<AgentWebhookDetails> => {
			const { workspace, agent } = await mcpAgent(request, false);
			return { webhook: await webhooks.get(workspace.id, agent.id) };
		},
	);

	server.post<{ Params: { agent: string }; Body: CreateAgentWebhookRequest }>(
		"/agents/:agent/webhook",
		{
			schema: {
				params,
				body: {
					type: "object",
					additionalProperties: false,
					required: ["url"],
					properties: { url, events, authKey, headers },
				},
			},
		},
		async (request, reply) => {
			const { workspace, agent } = await mcpAgent(request, true);
			const created: AgentWebhookSecret = await webhooks.create(
				workspace.id,
				agent.id,
				request.body,
				actor(request),
			);
			await note(
				request,
				agent.id,
				`Webhook added: POSTs to ${host(created.webhook.url)} on ${groups(created.webhook.events)}.`,
			);
			return reply.code(201).send(created);
		},
	);

	server.patch<{ Params: { agent: string }; Body: UpdateAgentWebhookRequest }>(
		"/agents/:agent/webhook",
		{
			schema: {
				params,
				body: {
					type: "object",
					additionalProperties: false,
					minProperties: 1,
					properties: {
						url,
						events,
						authKey: orNull(authKey),
						headers: orNull(headers),
						enabled: { type: "boolean" },
					},
				},
			},
		},
		async (request): Promise<AgentWebhook> => {
			const { workspace, agent } = await mcpAgent(request, true);
			const body = request.body;
			const updated = await webhooks.update(workspace.id, agent.id, body);
			const changes = [
				body.url !== undefined && `POSTs to ${host(updated.url)}`,
				body.events !== undefined && `wakes on ${groups(updated.events)}`,
				body.authKey === null && "auth key removed",
				typeof body.authKey === "string" && "auth key replaced",
				body.headers !== undefined &&
					(updated.headerNames.length
						? `headers set: ${updated.headerNames.join(", ")}`
						: "headers removed"),
				body.enabled === false && "paused",
				body.enabled === true && "started",
			].filter((change): change is string => Boolean(change));
			await note(request, agent.id, `Webhook changed: ${changes.join("; ")}.`);
			return updated;
		},
	);

	server.delete<{ Params: { agent: string } }>(
		"/agents/:agent/webhook",
		{ schema: { params } },
		async (request, reply) => {
			const { workspace, agent } = await mcpAgent(request, false);
			if (!(await webhooks.remove(workspace.id, agent.id)))
				throw new AgentWebhookError("This agent has no webhook.", 404);
			await note(request, agent.id, "Webhook deleted.");
			return reply.code(204).send();
		},
	);

	server.post<{ Params: { agent: string } }>(
		"/agents/:agent/webhook/secret",
		{ schema: { params } },
		async (request): Promise<AgentWebhookSecret> => {
			const { workspace, agent } = await mcpAgent(request, true);
			const rotated = await webhooks.rotateSecret(workspace.id, agent.id);
			await note(
				request,
				agent.id,
				"Webhook signing secret replaced. The old one no longer verifies.",
			);
			return rotated;
		},
	);

	// A real POST to the receiver, which may start a paid run there.
	server.post<{ Params: { agent: string } }>(
		"/agents/:agent/webhook/test",
		{ schema: { params } },
		async (request): Promise<AgentWebhookTestResult> => {
			const { workspace, agent } = await mcpAgent(request, true);
			return webhooks.test(workspace.id, agent.id, actor(request));
		},
	);
}

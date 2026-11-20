import {
	BUDGET_LIMITS,
	BUDGET_PERIODS,
	type BudgetPolicyInput,
	type UpdateBudgetPolicyRequest,
} from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { requestWorkspace } from "../auth/access.js";
import type { BudgetService } from "../budgets/service.js";
import { mongoErrorDetails } from "../mongo.js";
import { ServiceError } from "../service-error.js";

const id = { type: "string", minLength: 1, maxLength: 64 };
const idParams = { type: "object", required: ["id"], properties: { id } };
// Flat objects, not oneOf: Fastify removes properties a oneOf branch does
// not list before trying the next one. The service checks the combinations.
const appliesTo = {
	type: "object",
	additionalProperties: false,
	required: ["kind"],
	properties: {
		kind: { enum: ["everyone", "agents"] },
		agentIds: {
			type: "array",
			maxItems: BUDGET_LIMITS.agentsPerPolicy,
			items: { type: "string", minLength: 1, maxLength: 200 },
		},
	},
};
const covers = {
	type: "object",
	additionalProperties: false,
	required: ["kind"],
	properties: {
		kind: { enum: ["all", "llm", "video", "llm-model", "video-model"] },
		model: { type: "string", maxLength: BUDGET_LIMITS.modelLength },
	},
};
const fields = {
	appliesTo,
	covers,
	limitUsd: { type: "number", minimum: 0, maximum: BUDGET_LIMITS.maxLimitUsd },
	period: { enum: BUDGET_PERIODS },
	enabled: { type: "boolean" },
};

/** Errors as `{ error: { message } }`, never internals on a 500. */
function errorHandler(server: FastifyInstance) {
	server.setErrorHandler((error: unknown, request, reply) => {
		const failure = error as { statusCode?: unknown; message?: unknown };
		const status =
			typeof failure.statusCode === "number" && failure.statusCode >= 400
				? failure.statusCode
				: 500;
		if (status >= 500)
			request.log.error(
				error instanceof ServiceError
					? { ...mongoErrorDetails(error), message: error.message }
					: error,
				"Budget request failed",
			);
		return reply.code(status).send({
			error: {
				message:
					status < 500 || error instanceof ServiceError
						? String(failure.message)
						: "Budgets hit an unexpected error.",
			},
		});
	});
}

/**
 * Budgets under `/v1/:workspace`. Members read them; workspace admins add,
 * change, and delete them, since a budget decides what agents may spend.
 */
export async function budgetRoutes(
	server: FastifyInstance,
	options: { budgets: BudgetService },
) {
	const { budgets } = options;
	errorHandler(server);

	server.get("/budgets", async (request, reply) => {
		reply.header("cache-control", "no-store");
		return budgets.list(requestWorkspace(request));
	});

	server.post<{ Body: BudgetPolicyInput }>(
		"/budgets",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["appliesTo", "covers", "limitUsd", "period"],
					properties: fields,
				},
			},
		},
		async (request, reply) => {
			reply.header("cache-control", "no-store");
			const created = await budgets.create(
				requestWorkspace(request),
				request.body,
			);
			return reply.code(201).send(created);
		},
	);

	server.patch<{ Params: { id: string }; Body: UpdateBudgetPolicyRequest }>(
		"/budgets/:id",
		{
			schema: {
				params: idParams,
				body: {
					type: "object",
					additionalProperties: false,
					minProperties: 1,
					properties: fields,
				},
			},
		},
		async (request, reply) => {
			reply.header("cache-control", "no-store");
			return budgets.update(
				requestWorkspace(request),
				request.params.id,
				request.body,
			);
		},
	);

	server.delete<{ Params: { id: string } }>(
		"/budgets/:id",
		{ schema: { params: idParams } },
		async (request, reply) => {
			await budgets.remove(requestWorkspace(request), request.params.id);
			return reply.code(204).send();
		},
	);
}

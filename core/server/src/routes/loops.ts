import type {
	CreateLoop,
	LoopObservationInput,
	LoopPreviewInput,
	LoopRunCommand,
	PublishLoopWorkflow,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requestWorkspace, signedInMember } from "../auth/access.js";
import type { LoopsAssignments } from "../loops/assignments.js";
import type { LoopsService } from "../loops/service.js";
import type { OrganizationService } from "../organization/organization.js";
import { agentRouteErrors } from "./agents.js";

const text = { type: "string", minLength: 1 };
const object = (
	properties: Record<string, unknown>,
	required = Object.keys(properties),
) => ({
	type: "object",
	additionalProperties: false,
	properties,
	required,
});
const actor = object({ kind: { enum: ["user", "agent"] }, id: text });
const workflow = object({
	triggerCount: { type: "integer", minimum: 1 },
	decisionKey: text,
	steps: {
		type: "array",
		minItems: 1,
		items: object(
			{
				id: text,
				kind: { enum: ["decision", "action", "task", "verify"] },
				name: text,
				assignee: { anyOf: [actor, { type: "null" }] },
				maxCostCents: { type: "integer", minimum: 0 },
			},
			["id", "kind", "name", "assignee"],
		),
	},
});
const metric = object({
	name: text,
	source: text,
	direction: { enum: ["at_least", "at_most"] },
	target: { type: "number", minimum: 0, maximum: 100 },
	staleAfterMinutes: { type: "integer", minimum: 1 },
});
const observation = object(
	{
		eventId: text,
		workId: text,
		workRevision: text,
		observedAt: { type: "string", format: "date-time" },
		numerator: { type: "integer", minimum: 0 },
		denominator: { type: "integer", minimum: 0 },
		trigger: { type: "boolean" },
		evidence: text,
	},
	[
		"eventId",
		"workId",
		"workRevision",
		"observedAt",
		"numerator",
		"denominator",
		"trigger",
	],
);
const command = object(
	{
		expectedRevision: { type: "integer", minimum: 1 },
		action: { enum: ["claim", "complete", "pass", "fail"] },
		evidence: text,
		costCents: { type: "integer", minimum: 0 },
	},
	["expectedRevision", "action"],
);
const caller = (request: FastifyRequest) => ({
	workspaceId: requestWorkspace(request).id,
	actor: { kind: "user" as const, id: signedInMember(request).id },
});
type LoopParams = { id: string };

export async function loopsRoutes(
	server: FastifyInstance,
	{
		loops,
		organization,
		assignments,
	}: {
		loops: LoopsService;
		organization: OrganizationService;
		assignments: LoopsAssignments;
	},
) {
	agentRouteErrors(server);
	server.get("/loops", async (request) => {
		const context = caller(request);
		const [rows, pendingDecisions] = await Promise.all([
			loops.list(context),
			organization.pendingCount(context),
		]);
		return { loops: rows, pendingDecisions };
	});
	server.post<{ Body: LoopPreviewInput }>(
		"/loops/preview",
		{
			schema: {
				body: object({
					ownerPositionId: text,
					workflow,
					observations: {
						type: "array",
						maxItems: 100,
						items: object({
							eventId: text,
							workId: text,
							workRevision: text,
							trigger: { type: "boolean" },
						}),
					},
				}),
			},
		},
		(r) => loops.preview(caller(r), r.body),
	);
	server.post<{ Body: CreateLoop }>(
		"/loops",
		{
			schema: {
				body: object({
					name: text,
					goal: text,
					ownerPositionId: text,
					metric,
					workflow,
				}),
			},
		},
		async (r, reply) =>
			reply.code(201).send(await loops.create(caller(r), r.body)),
	);
	server.get<{ Querystring: { after?: string; limit?: number } }>(
		"/loops/assignments",
		{
			schema: {
				querystring: object(
					{
						after: { type: "string", minLength: 1, maxLength: 200 },
						limit: { type: "integer", minimum: 1, maximum: 100 },
					},
					[],
				),
			},
		},
		(r) => {
			const c = caller(r);
			return assignments.list(
				c.workspaceId,
				c.actor,
				r.query.after,
				r.query.limit,
			);
		},
	);
	server.get<{
		Params: LoopParams;
		Querystring: { day: string; after?: string; limit?: number };
	}>(
		"/loops/:id/samples",
		{
			schema: {
				querystring: object(
					{
						day: { type: "string", format: "date" },
						after: { type: "string", maxLength: 1500 },
						limit: { type: "integer", minimum: 1, maximum: 100 },
					},
					["day"],
				),
			},
		},
		(r) =>
			loops.samples(
				caller(r),
				r.params.id,
				r.query.day,
				r.query.after,
				r.query.limit,
			),
	);
	server.get<{ Params: LoopParams }>("/loops/:id", (r) =>
		loops.get(caller(r), r.params.id),
	);
	server.get<{ Params: LoopParams & { runId: string } }>(
		"/loops/:id/runs/:runId",
		(r) => loops.getRun(caller(r), r.params.id, r.params.runId),
	);
	server.put<{ Params: LoopParams; Body: PublishLoopWorkflow }>(
		"/loops/:id/workflow",
		{
			schema: {
				body: object(
					{
						expectedVersion: { type: "integer", minimum: 1 },
						workflow,
						target: { type: "number", minimum: 0, maximum: 100 },
						staleAfterMinutes: { type: "integer", minimum: 1, maximum: 525600 },
					},
					["expectedVersion", "workflow"],
				),
			},
		},
		(r) => loops.publish(caller(r), r.params.id, r.body),
	);
	server.post<{ Params: LoopParams; Body: LoopObservationInput }>(
		"/loops/:id/observations",
		{
			schema: { body: observation },
		},
		(r) => {
			const source =
				r.auth?.kind === "api-token"
					? {
							workspaceId: requestWorkspace(r).id,
							actor: { kind: "api-token" as const, id: r.auth.token.id },
						}
					: caller(r);
			return loops.observe(source, r.params.id, r.body);
		},
	);
	server.post<{ Params: LoopParams & { runId: string }; Body: LoopRunCommand }>(
		"/loops/:id/runs/:runId/actions",
		{
			schema: { body: command },
		},
		(r) => loops.command(caller(r), r.params.id, r.params.runId, r.body),
	);
}

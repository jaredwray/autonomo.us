import type {
	ActOnDecision,
	DecisionRuleInput,
	OpenDecisionCase,
	OrgPositionInput,
	OrgSettings,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requestWorkspace, signedInMember } from "../auth/access.js";
import type { BranchQuery, PreviewInput } from "../organization/chart.js";
import type { OrganizationService } from "../organization/organization.js";
import { agentRouteErrors } from "./agents.js";

const object = (
	properties: Record<string, unknown>,
	required: string[] = [],
) => ({ type: "object", additionalProperties: false, properties, required });
const text = (maxLength: number) => ({ type: "string", maxLength });
const id = { type: "string", minLength: 1, maxLength: 100 };
const nullableId = { anyOf: [id, { type: "null" }] };
const position = {
	title: text(160),
	remit: text(2000),
	authority: text(2000),
	managerId: nullableId,
	archived: { type: "boolean" },
	occupant: {
		anyOf: [
			object({ kind: { enum: ["user", "agent"] }, id }, ["kind", "id"]),
			{ type: "null" },
		],
	},
};
const rule = {
	ownerPositionId: id,
	fallbackPositionIds: { type: "array", items: id, maxItems: 12 },
	deadlineMinutes: { type: "integer", minimum: 1, maximum: 43200 },
};
const routing = { decisionKey: text(80), requesterPositionId: id };
const paging = {
	limit: { type: "integer", minimum: 1, maximum: 100 },
	after: text(100),
};
const caller = (request: FastifyRequest) => ({
	workspaceId: requestWorkspace(request).id,
	actor: { kind: "user" as const, id: signedInMember(request).id },
});
type IdParams = { id: string };
export async function organizationRoutes(
	server: FastifyInstance,
	{ organization: s }: { organization: OrganizationService },
) {
	agentRouteErrors(server);
	server.get<{ Querystring: BranchQuery }>(
		"/organization/branch",
		{
			schema: {
				querystring: object({
					...paging,
					positionId: id,
					parentId: id,
					q: text(140),
				}),
			},
		},
		(r) => s.branch(caller(r), r.query),
	);
	server.get<{ Querystring: { q?: string } }>(
		"/organization/identities",
		{ schema: { querystring: object({ q: text(140) }) } },
		(r) => s.identities(caller(r), r.query.q),
	);
	server.get<{ Params: IdParams }>("/organization/positions/:id", (r) =>
		s.detail(caller(r), r.params.id),
	);
	server.post<{ Body: OrgPositionInput }>(
		"/organization/positions",
		{ schema: { body: object(position, ["title"]) } },
		async (r, reply) =>
			reply.code(201).send(await s.position(caller(r), null, r.body)),
	);
	server.patch<{ Body: OrgPositionInput; Params: IdParams }>(
		"/organization/positions/:id",
		{ schema: { body: { ...object(position), minProperties: 1 } } },
		(r) => s.position(caller(r), r.params.id, r.body),
	);
	server.put<{ Body: OrgSettings }>(
		"/organization/settings",
		{
			schema: {
				body: object(
					{ leadPositionId: nullableId, humanFallbackPositionId: nullableId },
					["leadPositionId", "humanFallbackPositionId"],
				),
			},
		},
		(r) => s.settings(caller(r), r.body),
	);
	server.get("/organization/rules", (r) => s.rules(caller(r)));
	server.put<{
		Params: { key: string };
		Body: DecisionRuleInput & { expectedVersion?: number };
	}>(
		"/organization/rules/:key",
		{
			schema: {
				body: object(
					{ ...rule, expectedVersion: { type: "integer", minimum: 0 } },
					Object.keys(rule),
				),
			},
		},
		(r) => s.rule(caller(r), r.params.key, r.body),
	);
	server.post<{ Body: PreviewInput }>(
		"/organization/preview",
		{
			schema: {
				body: object({ ...routing, rule: object(rule, Object.keys(rule)) }, [
					"decisionKey",
				]),
			},
		},
		(r) => s.preview(caller(r), r.body),
	);
	server.get<{
		Querystring: {
			view?: "assigned" | "requested" | "triage";
			after?: string;
			limit?: number;
		};
	}>(
		"/organization/cases",
		{
			schema: {
				querystring: object({
					...paging,
					view: { enum: ["assigned", "requested", "triage"] },
				}),
			},
		},
		(r) => s.list(caller(r), r.query),
	);
	server.get<{ Params: IdParams }>("/organization/cases/:id", (r) =>
		s.read(caller(r), r.params.id),
	);
	server.post<{ Body: OpenDecisionCase }>(
		"/organization/cases",
		{
			schema: {
				body: object(
					{
						...routing,
						sourceWorkId: text(200),
						sourceRevision: text(120),
						question: text(3000),
						evidence: {
							type: "array",
							maxItems: 12,
							items: object({ label: text(160), ref: text(400) }, [
								"label",
								"ref",
							]),
						},
					},
					["decisionKey", "sourceWorkId", "sourceRevision", "question"],
				),
			},
		},
		async (r, reply) => reply.code(201).send(await s.open(caller(r), r.body)),
	);
	server.post<{ Params: IdParams; Body: ActOnDecision }>(
		"/organization/cases/:id/act",
		{
			schema: {
				body: object(
					{
						action: { enum: ["approve", "request_changes", "handoff"] },
						reason: text(2000),
						targetPositionId: id,
						expectedRevision: { type: "integer", minimum: 1 },
					},
					["action", "expectedRevision"],
				),
			},
		},
		(r) => s.act(caller(r), r.params.id, r.body),
	);
}

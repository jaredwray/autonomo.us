import type { AgentKind } from "./agents.js";

export type OrgActorRef = { kind: "user" | "agent"; id: string };
export type OrgIdentity = OrgActorRef & {
	name: string;
	type: "human" | AgentKind;
};
export type OrgPosition = {
	id: string;
	title: string;
	remit: string;
	authority: string;
	occupant: OrgIdentity | null;
	managerId: string | null;
	archived: boolean;
	childCount: number;
};
export type OrgPositionInput = Partial<
	Pick<OrgPosition, "title" | "remit" | "authority" | "managerId" | "archived">
> & {
	occupant?: OrgActorRef | null;
};
export type OrgSettings = {
	leadPositionId: string | null;
	humanFallbackPositionId: string | null;
};
export type OrgBranch = OrgSettings & {
	positions: OrgPosition[];
	viewerPositionIds: string[];
	next: string | null;
	canManage: boolean;
};
export type DecisionRuleInput = {
	ownerPositionId: string;
	fallbackPositionIds: string[];
	deadlineMinutes: number;
};
export type DecisionRule = DecisionRuleInput & { key: string; version: number };
export type RoutePosition = Pick<OrgPosition, "id" | "title" | "occupant">;
export type DecisionRouteStep = {
	position: RoutePosition;
	role: "owner" | "fallback";
	reason: string;
	eligible: boolean;
	/** The designated human fallback in the original route must remain human. */
	humanOnly?: boolean;
};
export type DecisionRoute = {
	decisionKey: string;
	ruleVersion: number | null;
	requesterPosition: RoutePosition | null;
	steps: DecisionRouteStep[];
	deadlineMinutes: number;
};
export type DecisionEvidence = { label: string; ref: string };
export type DecisionAction = "approve" | "request_changes" | "handoff";
export type DecisionStatus =
	| "open"
	| "triage"
	| "approved"
	| "changes_requested";
export type DecisionOutcome = {
	id: string;
	caseId: string;
	decisionKey: string;
	sourceWorkId: string;
	sourceRevision: string;
	status: "approved" | "changes_requested";
	reason: string;
	by: OrgIdentity;
	at: string;
};
export type DecisionHistoryEntry = {
	at: string;
	event:
		| "opened"
		| "assigned"
		| "skipped"
		| "timeout"
		| "handoff"
		| "triage"
		| "approved"
		| "changes_requested";
	reason: string;
	by: OrgIdentity | null;
	positionId: string | null;
	assignee: OrgIdentity | null;
};
export type DecisionCase = {
	id: string;
	revision: number;
	status: DecisionStatus;
	decisionKey: string;
	sourceWorkId: string;
	sourceRevision: string;
	question: string;
	requester: OrgIdentity;
	evidence: DecisionEvidence[];
	route: DecisionRoute;
	assignee: OrgIdentity | null;
	assigneePositionId: string | null;
	deadline: string | null;
	createdAt: string;
	updatedAt: string;
	history: DecisionHistoryEntry[];
	outcome: DecisionOutcome | null;
	canAct: boolean;
	canHandoff: boolean;
};
export type OrgPositionDetail = {
	position: OrgPosition;
	manager: OrgPosition | null;
	fallback: OrgPosition | null;
	cases: DecisionCase[];
};
export type DecisionCasePage = { cases: DecisionCase[]; next: string | null };
export type OpenDecisionCase = {
	decisionKey: string;
	requesterPositionId?: string;
	sourceWorkId: string;
	sourceRevision: string;
	question: string;
	evidence?: DecisionEvidence[];
};
export type ActOnDecision = {
	action: DecisionAction;
	expectedRevision: number;
	reason?: string;
	targetPositionId?: string;
};

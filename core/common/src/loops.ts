import type { DecisionRoute, OrgActorRef } from "./organization.js";

export type LoopSourceActor = OrgActorRef | { kind: "api-token"; id: string };

export type LoopMetric = {
	name: string;
	source: string;
	direction: "at_least" | "at_most";
	target: number;
	staleAfterMinutes: number;
};
export type LoopStep = {
	id: string;
	kind: "decision" | "action" | "task" | "verify";
	name: string;
	/** Decision assignment is resolved through the organization's decision rule. */
	assignee: OrgActorRef | null;
	/** Optional USD cents authorized for this action. */
	maxCostCents?: number;
};
export type LoopWorkflow = {
	triggerCount: number;
	decisionKey: string;
	steps: LoopStep[];
};
export type CreateLoop = {
	name: string;
	goal: string;
	ownerPositionId: string;
	metric: LoopMetric;
	workflow: LoopWorkflow;
};
export type PublishLoopWorkflow = {
	expectedVersion: number;
	target?: number;
	staleAfterMinutes?: number;
	workflow: LoopWorkflow;
};
export type LoopObservationInput = {
	eventId: string;
	workId: string;
	workRevision: string;
	observedAt: string;
	numerator: number;
	denominator: number;
	/** This observation should count toward the trigger for this work revision. */
	trigger: boolean;
	evidence?: string;
};
export type LoopObservation = LoopObservationInput & { actor: LoopSourceActor };
export type LoopSamplesPage = {
	observations: LoopObservation[];
	next: string | null;
};
export type LoopMetricPoint = {
	day: string;
	numerator: number;
	denominator: number;
	value: number | null;
};
export type LoopSummary = Omit<CreateLoop, "workflow"> & {
	id: string;
	ownerName: string;
	version: number;
	current: LoopMetricPoint | null;
	trend: LoopMetricPoint[];
	change: number | null;
	lastObservedAt: string | null;
	status: "on_target" | "off_target" | "stale" | "no_data";
	activeRuns: number;
	pendingDecisions: number;
};
export type LoopRun = {
	id: string;
	loopId: string;
	workId: string;
	workRevision: string;
	version: number;
	workflow: LoopWorkflow;
	stepIndex: number;
	status: "active" | "completed" | "failed" | "changes_requested";
	revision: number;
	caseId: string | null;
	claimedBy: OrgActorRef | null;
	/** Pass this stable key to the external provider for a claimed step. */
	readonly executionKey?: string;
	events: {
		at: string;
		message: string;
		actor: LoopSourceActor | null;
		costCents?: number;
		evidence?: string;
	}[];
};
export type LoopDetail = LoopSummary & {
	workflow: LoopWorkflow;
	runs: LoopRun[];
	observations: LoopObservation[];
};
export type LoopRunCommand = {
	expectedRevision: number;
	action: "claim" | "complete" | "pass" | "fail";
	evidence?: string;
	costCents?: number;
};

export type LoopPreviewInput = {
	ownerPositionId: string;
	workflow: LoopWorkflow;
	observations: Pick<
		LoopObservationInput,
		"eventId" | "workId" | "workRevision" | "trigger"
	>[];
};
export type LoopPreview = {
	distinctEvents: number;
	matched: { workId: string; workRevision: string; count: number }[];
	steps: LoopStep[];
	route: DecisionRoute;
};

import type { AgentWakeEvent, LoopRun, OrgActorRef } from "@autonomo.us/common";
import type { AgentNotice } from "../agent-webhooks/webhooks.js";
import { pageLimit } from "../organization/chart.js";
import { ServiceError } from "../service-error.js";
import type { LoopRepository, RunRecord } from "./repository.js";

/** A decision is assigned through Organization. Other steps belong to their workflow assignee. */
export function currentAssignment(run: LoopRun) {
	const step = run.workflow.steps[run.stepIndex];
	if (run.status !== "active" || !step?.assignee || step.kind === "decision")
		return null;
	return { step, assignee: step.assignee };
}

/** The run is pinned to one workflow version. An action keeps its key across reconnects. */
export function loopExecutionKey(run: LoopRun) {
	return `${run.id}:${run.workflow.steps[run.stepIndex].id}`;
}

/** These indexed fields are written atomically with every run transition. */
export function assignmentFields(record: RunRecord) {
	const current = currentAssignment(record.run);
	return {
		assignedId: current?.assignee.id ?? null,
		assignedKind: current?.assignee.kind ?? null,
		wakeAt:
			current?.assignee.kind === "agent" && !record.run.claimedBy ? 0 : null,
		decisionCheckAt: record.waiting ? 0 : null,
	};
}
export type AssignmentFields = ReturnType<typeof assignmentFields>;
export type AssignmentClock = "wakeAt" | "decisionCheckAt";
const BATCH = 40;
const RECHECK_MS = 30_000;

/** Polling reads the durable run. A metadata-only webhook is an optional hint to poll. */
export class LoopsAssignments {
	constructor(
		private readonly repository: LoopRepository,
		private readonly reconcile: (record: RunRecord) => Promise<unknown>,
		private readonly notify?: (
			workspaceId: string,
			agentId: string,
			notice: AgentNotice,
		) => Promise<void>,
		private readonly now: () => number = Date.now,
	) {}
	async list(
		workspaceId: string,
		actor: OrgActorRef,
		after?: string,
		limit?: number,
	) {
		const size = pageLimit(limit);
		if (
			after !== undefined &&
			(typeof after !== "string" || after.length > 100)
		)
			throw new ServiceError("Invalid loop assignment cursor.");
		const rows = await this.repository.assigned(
			workspaceId,
			actor,
			after ?? "",
			size + 1,
		);
		const assignments = rows.slice(0, size).map(({ run }) => {
			const step = run.workflow.steps[run.stepIndex];
			const evidence = run.events.findLast((event) => event.evidence)?.evidence;
			return {
				loopId: run.loopId,
				runId: run.id,
				stepId: step.id,
				stepName: step.name,
				stepKind: step.kind,
				...(evidence ? { evidence } : {}),
				revision: run.revision,
				claimed: !!run.claimedBy,
				...(run.claimedBy?.kind === actor.kind && run.claimedBy.id === actor.id
					? { executionKey: loopExecutionKey(run) }
					: {}),
				...(step.maxCostCents === undefined
					? {}
					: { maxCostCents: step.maxCostCents }),
				workId: run.workId,
				workRevision: run.workRevision,
			};
		});
		return {
			assignments,
			next: rows.length > size ? rows[size - 1].run.id : null,
		};
	}

	async mayNotify(
		workspaceId: string,
		agentId: string,
		event: Extract<AgentWakeEvent, { type: "loop.assigned" }>,
	) {
		const row = await this.repository.run(
			workspaceId,
			event.loopId,
			event.runId,
		);
		if (!row || row.run.stepIndex !== event.stepIndex || row.run.claimedBy)
			return false;
		const actor = currentAssignment(row.run)?.assignee;
		return actor?.kind === "agent" && actor.id === agentId;
	}

	private async processDue(
		field: AssignmentClock,
		process: (row: RunRecord) => Promise<void>,
	) {
		const now = this.now();
		const rows = await this.repository.dueAssignments(field, now, BATCH);
		const results = await Promise.allSettled(
			rows.map(async (row) => {
				// Defer before calling the consumer so failing rows yield to other work and crashes retry.
				if (
					!(await this.repository.deferAssignment(
						row,
						field,
						now,
						now + RECHECK_MS,
					))
				)
					return;
				await process(row);
			}),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}

	private async deliver(row: RunRecord) {
		const { run, workspaceId } = row;
		const recipient = currentAssignment(run)?.assignee;
		if (recipient?.kind !== "agent" || !this.notify) return;
		await this.notify(workspaceId, recipient.id, {
			key: JSON.stringify(["loop", run.loopId, run.id, run.stepIndex]),
			event: {
				type: "loop.assigned",
				at: run.events.at(-1)?.at ?? row.createdAt,
				loopId: run.loopId,
				runId: run.id,
				stepIndex: run.stepIndex,
			},
		});
		await this.repository.acknowledgeAssignment(row);
	}

	async sweep() {
		try {
			await this.processDue("decisionCheckAt", async (row) => {
				await this.reconcile(row);
			});
		} finally {
			if (this.notify)
				await this.processDue("wakeAt", (row) => this.deliver(row));
		}
	}
}

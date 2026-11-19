import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	CreateLoop,
	LoopDetail,
	LoopMetricPoint,
	LoopObservation,
	LoopObservationInput,
	LoopPreview,
	LoopPreviewInput,
	LoopRun,
	LoopRunCommand,
	LoopSamplesPage,
	LoopSourceActor,
	LoopSummary,
	LoopWorkflow,
	PublishLoopWorkflow,
} from "@autonomo.us/common";
import {
	boundedText,
	decisionKey,
	type OrgCaller,
} from "../organization/chart.js";
import type { OrganizationDirectory } from "../organization/directory.js";
import type { OrganizationService } from "../organization/organization.js";
import {
	type OrganizationRepository,
	sameActor,
} from "../organization/repository.js";
import { ServiceError } from "../service-error.js";
import { loopExecutionKey } from "./assignments.js";
import { previewTriggers } from "./preview.js";
import type { Definition, LoopRepository, RunRecord } from "./repository.js";

export type LoopCaller = { workspaceId: string; actor: LoopSourceActor };
const dayMs = 86_400_000;
const digest = (...parts: string[]) =>
	createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const conflict = () =>
	new ServiceError(
		"This record changed. Read its current revision and retry.",
		409,
	);
function integer(value: number, min: number, max: number, label: string) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new ServiceError(
			`${label} must be an integer between ${min} and ${max}.`,
		);
	return value;
}
function targetPercent(value: number) {
	if (!Number.isFinite(value) || value < 0 || value > 100)
		throw new ServiceError("Target must be between 0 and 100 percent.");
	return value;
}
function evidenceRef(value: unknown) {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		!/^work:[A-Za-z0-9][A-Za-z0-9._:/-]{0,249}$/.test(value)
	)
		throw new ServiceError("Evidence must be an opaque work: reference.");
	return value;
}
function point(day: string, n = 0, d = 0): LoopMetricPoint {
	return { day, numerator: n, denominator: d, value: d ? (100 * n) / d : null };
}
function advance(run: LoopRun) {
	run.claimedBy = null;
	if (run.stepIndex + 1 === run.workflow.steps.length) run.status = "completed";
	else run.stepIndex++;
}
function approvalQuestion(run: LoopRun) {
	const steps = run.workflow.steps;
	const action = steps.find((s) => s.kind === "action");
	const tasks = steps.filter((s) => s.kind === "task");
	const verifier = steps.at(-1);
	const scope = action
		? ` Authorize one ${action.name} for work ${JSON.stringify(run.workId)}, revision ${JSON.stringify(run.workRevision)}.${action.maxCostCents === undefined ? "" : ` Maximum ${action.maxCostCents} USD cents.`}`
		: "";
	const question = steps[0].name + scope;
	const verification = verifier ? ` Verification: ${verifier.name}.` : "";
	if (!tasks.length) return question + verification;
	const extra = ` Additional tasks: ${tasks.map((s) => s.name).join(", ")}.`;
	// The linked run always contains the complete immutable workflow. Organization questions allow 3,000 characters.
	return (
		question +
		(question.length + extra.length + verification.length <= 3000
			? extra
			: ` Includes ${tasks.length} additional tasks in the linked workflow.`) +
		verification
	);
}

export class LoopsService {
	constructor(
		private readonly repo: LoopRepository,
		private readonly organization: Pick<
			OrganizationService,
			"openLoopCase" | "read" | "preview"
		>,
		private readonly directory: OrganizationDirectory,
		private readonly orgRepo: Pick<
			OrganizationRepository,
			"select" | "getCase"
		>,
		private readonly now: () => number = Date.now,
	) {}
	private async access(c: OrgCaller, manage = false) {
		if (!(await this.directory.active(c.workspaceId)))
			throw new ServiceError("This workspace is unavailable.", 409);
		const principal = await this.directory.resolve(c.workspaceId, c.actor);
		if (!principal?.use || (manage && !principal.manage))
			throw new ServiceError(
				"This action is not available to this workspace actor.",
				403,
			);
		return principal;
	}

	private async owner(w: string, id: string) {
		return (
			(await this.orgRepo.select(w, { ids: [id], active: true, limit: 1 }))
				.positions[0] ?? null
		);
	}
	private async definition(w: string, id: string) {
		const loop = await this.repo.get(w, id);
		if (!loop) throw new ServiceError("Loop not found in this workspace.", 404);
		return loop;
	}
	private async workflow(
		w: string,
		input: LoopWorkflow,
	): Promise<LoopWorkflow> {
		if (
			!input ||
			!Array.isArray(input.steps) ||
			input.steps.length < 3 ||
			input.steps.length > 20
		)
			throw new ServiceError("Provide 3–20 workflow steps.");
		const triggerCount = integer(input.triggerCount, 1, 100, "Trigger count"),
			key = decisionKey(input.decisionKey);
		const ids = new Set<string>();
		const steps = input.steps.map((step) => {
			const id = boundedText(step?.id, "Step ID", 80),
				name = boundedText(step?.name, "Step name", 160);
			if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id))
				throw new ServiceError(
					"Use distinct step IDs containing letters, digits, hyphens or underscores.",
				);
			ids.add(id);
			const kind = step.kind;
			if (!["decision", "action", "task", "verify"].includes(kind))
				throw new ServiceError("Unknown workflow step kind.");
			if (step.maxCostCents !== undefined && kind !== "action")
				throw new ServiceError("Only an action can set a cost ceiling.");
			const maxCostCents =
				step.maxCostCents === undefined
					? undefined
					: integer(
							step.maxCostCents,
							0,
							Number.MAX_SAFE_INTEGER,
							"Action ceiling",
						);
			if (kind === "decision") {
				if (step.assignee !== null)
					throw new ServiceError(
						"Decision reviewers come from the organization's routing rule.",
					);
				return { id, kind, name, assignee: null };
			}
			if (!step.assignee || !["agent", "user"].includes(step.assignee.kind))
				throw new ServiceError(
					"An action, task, or verification step needs a workspace assignee.",
				);
			return {
				id,
				kind,
				name,
				...(maxCostCents === undefined ? {} : { maxCostCents }),
				assignee: {
					kind: step.assignee.kind,
					id: boundedText(step.assignee.id, "Assignee ID", 100),
				},
			};
		});
		if (
			steps[0].kind !== "decision" ||
			steps.at(-1)?.kind !== "verify" ||
			steps
				.slice(1, -1)
				.some((s) => s.kind !== "action" && s.kind !== "task") ||
			steps.filter((s) => s.kind === "action").length !== 1
		)
			throw new ServiceError(
				"Start with one decision, include one action and optional tasks, and end with verification.",
			);
		const verifier = steps.at(-1)?.assignee;
		if (steps.slice(1, -1).some((s) => sameActor(s.assignee, verifier)))
			throw new ServiceError(
				"Choose a verifier independent of all action and task assignees.",
			);
		const actors = new Map(
			steps.flatMap((s) =>
				s.assignee ? [[JSON.stringify(s.assignee), s.assignee] as const] : [],
			),
		);
		for (const actor of actors.values())
			if (!(await this.directory.resolve(w, actor))?.loopAct)
				throw new ServiceError(
					"A workflow assignee is unavailable in this workspace.",
				);
		return { triggerCount, decisionKey: key, steps };
	}
	private async occupiedOwner(w: string, positionId: unknown) {
		const id = boundedText(positionId, "Owner position", 100),
			owner = await this.owner(w, id);
		if (
			!owner?.occupant ||
			!(await this.directory.resolve(w, owner.occupant))?.use
		)
			throw new ServiceError(
				"Choose an occupied, active owner position in this workspace.",
			);
		return owner;
	}
	async preview(c: OrgCaller, input: LoopPreviewInput): Promise<LoopPreview> {
		await this.access(c, true);
		const owner = await this.occupiedOwner(
			c.workspaceId,
			input?.ownerPositionId,
		);
		const workflow = await this.workflow(c.workspaceId, input.workflow);
		const results = previewTriggers(input.observations, workflow.triggerCount);
		const route = await this.organization.preview(c, {
			requesterPositionId: owner.id,
			decisionKey: workflow.decisionKey,
		});
		return { ...results, steps: workflow.steps, route };
	}
	async create(c: OrgCaller, input: CreateLoop): Promise<LoopDetail> {
		await this.access(c, true);
		const name = boundedText(input?.name, "Loop name", 160),
			goal = boundedText(input?.goal, "Goal", 2000);
		const owner = await this.occupiedOwner(
			c.workspaceId,
			input?.ownerPositionId,
		);
		const ownerPositionId = owner.id;
		const m = input.metric;
		if (!m || !["at_least", "at_most"].includes(m.direction))
			throw new ServiceError(
				"Choose a metric direction and a target between 0 and 100 percent.",
			);
		const metric = {
			name: boundedText(m.name, "Metric name", 160),
			source: boundedText(m.source, "Metric source", 200),
			direction: m.direction,
			target: targetPercent(m.target),
			staleAfterMinutes: integer(
				m.staleAfterMinutes,
				1,
				525600,
				"Staleness threshold",
			),
		};
		const d: Definition = {
			name,
			goal,
			ownerPositionId,
			ownerName: owner.title,
			metric,
			workflow: await this.workflow(c.workspaceId, input.workflow),
			version: 1,
			id: randomUUID(),
			workspaceId: c.workspaceId,
		};
		if (!(await this.repo.save(d, 0))) throw conflict();
		return this.detail(c, d);
	}
	async publish(
		c: OrgCaller,
		id: string,
		input: PublishLoopWorkflow,
	): Promise<LoopDetail> {
		await this.access(c, true);
		const d = await this.definition(c.workspaceId, id);
		if (d.version !== input?.expectedVersion) throw conflict();
		const workflow = await this.workflow(c.workspaceId, input.workflow);
		const metric = { ...d.metric };
		if (input.target !== undefined) metric.target = targetPercent(input.target);
		if (input.staleAfterMinutes !== undefined)
			metric.staleAfterMinutes = integer(
				input.staleAfterMinutes,
				1,
				525600,
				"Staleness threshold",
			);
		const next = { ...d, metric, workflow, version: d.version + 1 };
		if (!(await this.repo.save(next, d.version))) throw conflict();
		return this.detail(c, next);
	}
	async observe(
		c: LoopCaller,
		id: string,
		input: LoopObservationInput,
	): Promise<{ eventId: string; runId: string | null }> {
		if (c.actor.kind !== "api-token")
			await this.access({ workspaceId: c.workspaceId, actor: c.actor });
		else if (!(await this.directory.active(c.workspaceId)))
			throw new ServiceError("This workspace is unavailable.", 409);
		const d = await this.definition(c.workspaceId, id);
		const observedAt = Date.parse(input?.observedAt);
		if (
			typeof input?.observedAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(input.observedAt) ||
			!Number.isFinite(observedAt) ||
			observedAt > this.now()
		)
			throw new ServiceError(
				"Use a past or current ISO timestamp with a time zone.",
			);
		if (typeof input.trigger !== "boolean")
			throw new ServiceError(
				"Specify whether this observation counts toward the trigger.",
			);
		const denominator = integer(
			input.denominator,
			input.trigger ? 0 : 1,
			1_000_000_000,
			"Denominator",
		);
		const numerator = integer(input.numerator, 0, denominator, "Numerator"),
			evidence = evidenceRef(input.evidence);
		const observation: LoopObservation = {
			eventId: boundedText(input.eventId, "Event ID", 160),
			workId: boundedText(input.workId, "Work ID", 200),
			workRevision: boundedText(input.workRevision, "Work revision", 120),
			observedAt: iso(observedAt),
			numerator,
			denominator,
			trigger: input.trigger,
			...(evidence ? { evidence } : {}),
			actor: { kind: c.actor.kind, id: c.actor.id },
		};
		const row = await this.repo.insertObservation({
			workspaceId: c.workspaceId,
			loopId: id,
			observation,
			workflow: observation.trigger ? d.workflow : null,
			version: d.version,
		});
		if (!isDeepStrictEqual(row.observation, observation))
			throw new ServiceError(
				"This event ID already identifies a different observation.",
				409,
			);
		const runId = digest(
			c.workspaceId,
			id,
			observation.workId,
			observation.workRevision,
		);
		if (!row.workflow) return { eventId: observation.eventId, runId: null };
		let record = await this.repo.run(c.workspaceId, id, runId);
		if (
			!record &&
			(await this.repo.triggers(row, row.workflow.triggerCount)) >=
				row.workflow.triggerCount
		) {
			const at = iso(this.now());
			const run: LoopRun = {
				id: runId,
				loopId: id,
				workId: observation.workId,
				workRevision: observation.workRevision,
				version: row.version,
				workflow: row.workflow,
				stepIndex: 0,
				status: "active",
				revision: 1,
				caseId: null,
				claimedBy: null,
				events: [
					{
						at,
						actor: observation.actor,
						message:
							"Observation threshold reached. Decision requested by the loop owner.",
						...(evidence ? { evidence } : {}),
					},
				],
			};
			const fresh: RunRecord = {
				approvalQuestion: approvalQuestion(run),
				workspaceId: c.workspaceId,
				run,
				ownerPositionId: d.ownerPositionId,
				createdAt: at,
				waiting: true,
			};
			record = (await this.repo.saveRun(fresh, 0))
				? fresh
				: await this.repo.run(c.workspaceId, id, runId);
		}
		if (record?.waiting) await this.reconcileRun(record);
		return { eventId: observation.eventId, runId: record?.run.id ?? null };
	}
	async reconcileRun(initial: RunRecord): Promise<RunRecord> {
		let r = initial;
		for (let i = 0; i < 6 && r.waiting; i++) {
			const run = r.run,
				w = r.workspaceId,
				key = run.workflow.decisionKey,
				work = `loop-run:${run.loopId}:${run.id}`;
			const caseId = run.caseId ?? digest(w, work, run.workRevision, key);
			const question = r.approvalQuestion ?? approvalQuestion(run);
			const evidence = [
				{
					label: "Loop workflow run",
					ref: `work:loop/${run.loopId}/run/${run.id}`,
				},
			];
			const stored = await this.orgRepo.getCase(w, caseId);
			let decision: Pick<
				Awaited<ReturnType<OrganizationService["openLoopCase"]>>,
				| "id"
				| "outcome"
				| "status"
				| "sourceRevision"
				| "sourceWorkId"
				| "decisionKey"
				| "question"
				| "evidence"
				| "requester"
				| "route"
			>;
			if (stored) {
				if (!stored.loopOwned)
					throw new ServiceError(
						"This organization case was not opened by this loop.",
						409,
					);
				if (!r.requester) {
					const fresh = await this.repo.run(w, run.loopId, run.id);
					if (fresh && fresh.run.revision !== run.revision) {
						r = fresh;
						continue;
					}
				}
				decision = stored;
			} else {
				const owner = await this.owner(w, r.ownerPositionId);
				// A vacant owner blocks the run until an eligible occupant is assigned.
				if (
					!owner?.occupant ||
					!(await this.directory.resolve(w, owner.occupant))?.use
				)
					return r;
				if (!sameActor(r.requester, owner.occupant)) {
					r.requester = { kind: owner.occupant.kind, id: owner.occupant.id };
					const prior = run.revision++;
					const saved = await this.repo.saveRun(r, prior);
					if (!saved) {
						const live = await this.repo.run(w, run.loopId, run.id);
						if (!live) throw conflict();
						r = live;
					}
					continue;
				}
				decision = await this.organization.openLoopCase(
					{ workspaceId: w, actor: owner.occupant },
					{
						requesterPositionId: owner.id,
						decisionKey: key,
						sourceWorkId: work,
						sourceRevision: run.workRevision,
						question,
						evidence,
					},
				);
			}
			if (
				!sameActor(decision.requester, r.requester) ||
				decision.route.requesterPosition?.id !== r.ownerPositionId ||
				decision.sourceWorkId !== work ||
				decision.sourceRevision !== run.workRevision ||
				decision.decisionKey !== key ||
				decision.question !== question ||
				!isDeepStrictEqual(decision.evidence, evidence)
			)
				throw new ServiceError(
					"Decision does not match this run's recorded owner, revision and action scope.",
					409,
				);
			const outcome = decision.outcome;
			if (run.caseId === decision.id && !outcome) return r;
			const prior = run.revision;
			run.caseId = decision.id;
			if (outcome) {
				if (outcome.status === "approved") advance(run);
				else run.status = "changes_requested";
				r.waiting = false;
				run.events.push({
					at: outcome.at,
					actor: { kind: outcome.by.kind, id: outcome.by.id },
					message:
						outcome.status === "approved"
							? "Decision approved."
							: "Changes requested.",
				});
			}
			run.revision++;
			if (await this.repo.saveRun(r, prior)) return r;
			const current = await this.repo.run(w, run.loopId, run.id);
			if (!current) throw conflict();
			r = current;
		}
		return r;
	}
	async command(
		c: OrgCaller,
		id: string,
		runId: string,
		input: LoopRunCommand,
	): Promise<LoopRun> {
		const principal = await this.access(c);
		if (!principal.loopAct)
			throw new ServiceError(
				"This actor is not currently authorized to perform loop steps.",
				403,
			);
		const row = await this.repo.run(c.workspaceId, id, runId);
		if (!row) throw new ServiceError("Loop run not found.", 404);
		const r = await this.reconcileRun(row),
			run = r.run;
		if (run.status !== "active" || run.revision !== input?.expectedRevision)
			throw conflict();
		const step = run.workflow.steps[run.stepIndex];
		if (step.kind === "decision" || !sameActor(step.assignee, c.actor))
			throw new ServiceError(
				"Only the assigned actor can perform this step.",
				403,
			);
		const evidence = evidenceRef(input.evidence);
		if (
			input.costCents !== undefined &&
			(input.action !== "complete" || step.kind !== "action")
		)
			throw new ServiceError("Only action completion can report a cost.");
		const costCents =
			input.costCents === undefined
				? undefined
				: integer(input.costCents, 0, Number.MAX_SAFE_INTEGER, "Reported cost");
		if (
			input.action === "complete" &&
			step.maxCostCents !== undefined &&
			(costCents === undefined || costCents > step.maxCostCents)
		)
			throw new ServiceError(
				"Report the actual cost within the approved ceiling.",
			);
		switch (input.action) {
			case "claim":
				if (step.kind === "verify" || run.claimedBy) throw conflict();
				run.claimedBy = { kind: c.actor.kind, id: c.actor.id };
				break;
			case "complete":
				if (step.kind === "verify" || !sameActor(run.claimedBy, c.actor))
					throw new ServiceError("Claim the action before completing it.", 409);
				if (!evidence)
					throw new ServiceError(
						"Attach a work: reference for the completed step.",
					);
				advance(run);
				break;
			case "pass":
			case "fail":
				if (step.kind !== "verify")
					throw new ServiceError("This step is not a verification.", 409);
				if (!evidence)
					throw new ServiceError("Attach a work: reference for verification.");
				if (input.action === "pass") advance(run);
				else run.status = "failed";
				break;
			default:
				throw new ServiceError("Unknown run command.");
		}
		const message = {
			claim: "Claimed",
			complete: "Completed",
			pass: "Verified",
			fail: "Failed verification for",
		}[input.action];
		run.events.push({
			at: iso(this.now()),
			actor: c.actor,
			message: `${message}: ${step.name}`,
			...(costCents === undefined ? {} : { costCents }),
			...(evidence ? { evidence } : {}),
		});
		run.revision++;
		if (!(await this.repo.saveRun(r, input.expectedRevision))) throw conflict();
		return this.presentRun(c, run);
	}
	private async summary(c: OrgCaller, d: Definition): Promise<LoopSummary> {
		const w = d.workspaceId,
			id = d.id;
		const lastObservedAt = await this.repo.lastMetricAt(w, id),
			now = this.now(),
			day = Date.parse(`${iso(now).slice(0, 10)}T00:00:00Z`),
			first = day - 6 * dayMs;
		const lastDay = lastObservedAt?.slice(0, 10),
			from = iso(first).slice(0, 10);
		const rows = await this.repo.days(
			w,
			id,
			`${lastDay && lastDay < from ? lastDay : from}T00:00:00.000Z`,
		);
		const sums = new Map(
			rows.map((r) => [r.day, point(r.day, r.numerator, r.denominator)]),
		);
		const trend = Array.from({ length: 7 }, (_, i) => {
			const date = iso(first + i * dayMs).slice(0, 10);
			return sums.get(date) ?? point(date);
		});
		const current = lastDay ? (sums.get(lastDay) ?? null) : null;
		const value = current?.value ?? null,
			base = trend[0].value,
			end = trend.at(-1)?.value;
		const change = base !== null && end != null ? end - base : null;
		const status: LoopSummary["status"] =
			value === null || !lastObservedAt
				? "no_data"
				: now - Date.parse(lastObservedAt) > d.metric.staleAfterMinutes * 60_000
					? "stale"
					: (
								d.metric.direction === "at_least"
									? value >= d.metric.target
									: value <= d.metric.target
							)
						? "on_target"
						: "off_target";
		const pending = await this.repo.waiting(w, id);
		let pendingDecisions = 0;
		for (const r of pending) {
			const updated = await this.reconcileRun(r);
			if (updated.waiting && updated.run.caseId) {
				const visible = await this.visibleCase(c, updated.run.caseId);
				if (
					visible &&
					(visible.status === "open" || visible.status === "triage")
				)
					pendingDecisions++;
			}
		}
		return {
			id,
			name: d.name,
			goal: d.goal,
			ownerPositionId: d.ownerPositionId,
			ownerName: d.ownerName,
			metric: d.metric,
			version: d.version,
			current,
			trend,
			change,
			lastObservedAt,
			status,
			activeRuns: await this.repo.active(w, id),
			pendingDecisions,
		};
	}
	async list(c: OrgCaller): Promise<LoopSummary[]> {
		await this.access(c);
		const loops = await this.repo.list(c.workspaceId);
		const summaries = [];
		for (const d of loops) summaries.push(await this.summary(c, d));
		return summaries;
	}
	private async visibleCase(c: OrgCaller, caseId: string) {
		try {
			return await this.organization.read(c, caseId);
		} catch (e) {
			if (e instanceof ServiceError && e.statusCode === 404) return null;
			throw e;
		}
	}
	private async presentRun(c: OrgCaller, run: LoopRun) {
		const caseId =
			run.caseId && (await this.visibleCase(c, run.caseId)) ? run.caseId : null;
		// A retried or reconnected executor must reuse this key at the provider.
		const executionKey =
			run.status === "active" && sameActor(run.claimedBy, c.actor)
				? loopExecutionKey(run)
				: undefined;
		return { ...run, caseId, ...(executionKey ? { executionKey } : {}) };
	}
	private async detail(c: OrgCaller, d: Definition): Promise<LoopDetail> {
		const summary = await this.summary(c, d);
		const [runs, observations] = await Promise.all([
			this.repo.runs(d.workspaceId, d.id, 50),
			this.repo.recent(d.workspaceId, d.id, 100),
		]);
		return {
			...summary,
			workflow: d.workflow,
			runs: await Promise.all(runs.map((r) => this.presentRun(c, r.run))),
			observations,
		};
	}
	async samples(
		c: OrgCaller,
		id: string,
		day: string,
		after?: string,
		limit = 25,
	): Promise<LoopSamplesPage> {
		await this.access(c);
		await this.definition(c.workspaceId, id);
		const from = `${day}T00:00:00.000Z`;
		const start = Date.parse(from);
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
			!Number.isFinite(start) ||
			iso(start) !== from
		)
			throw new ServiceError("Choose a valid UTC date.");
		integer(limit, 1, 100, "Page size");
		let before = null;
		if (after !== undefined) {
			try {
				if (after.length > 1500) throw new Error();
				const cursor = JSON.parse(
					Buffer.from(after, "base64url").toString("utf8"),
				);
				if (!Array.isArray(cursor) || cursor.length !== 2) throw new Error();
				const [observedAt, eventId] = cursor;
				if (
					typeof observedAt !== "string" ||
					!observedAt.startsWith(`${day}T`) ||
					iso(Date.parse(observedAt)) !== observedAt ||
					typeof eventId !== "string" ||
					!eventId.length ||
					eventId.length > 160
				)
					throw new Error();
				before = { observedAt, eventId };
			} catch {
				throw new ServiceError("Invalid observation cursor for this UTC day.");
			}
		}
		const rows = await this.repo.samples(
			c.workspaceId,
			id,
			from,
			iso(start + dayMs),
			before,
			limit + 1,
		);
		const observations = rows.slice(0, limit);
		const last = observations.at(-1);
		const next =
			last && rows.length > limit
				? Buffer.from(JSON.stringify([last.observedAt, last.eventId])).toString(
						"base64url",
					)
				: null;
		return { observations, next };
	}
	async getRun(c: OrgCaller, id: string, runId: string): Promise<LoopRun> {
		await this.access(c);
		const record = await this.repo.run(c.workspaceId, id, runId);
		if (!record) throw new ServiceError("Loop run not found.", 404);
		return this.presentRun(c, (await this.reconcileRun(record)).run);
	}

	async get(c: OrgCaller, id: string): Promise<LoopDetail> {
		await this.access(c);
		return this.detail(c, await this.definition(c.workspaceId, id));
	}
}

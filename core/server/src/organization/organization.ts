import { createHash, randomUUID } from "node:crypto";
import type {
	ActOnDecision,
	DecisionCase,
	DecisionCasePage,
	DecisionEvidence,
	DecisionHistoryEntry,
	OpenDecisionCase,
	OrgIdentity,
	OrgPosition,
	OrgPositionDetail,
} from "@autonomo.us/common";
import { ServiceError } from "../service-error.js";
import {
	boundedText,
	conflict,
	decisionKey,
	forbidden,
	missingPosition,
	OrganizationChart,
	type OrgCaller,
	pageLimit,
} from "./chart.js";
import type { OrganizationDirectory, OrgPrincipal } from "./directory.js";
import {
	type CaseFilter,
	type CaseNotice,
	type OrganizationRepository,
	type OrgGraph,
	type StoredCase,
	sameActor,
} from "./repository.js";

const notFound = () =>
	new ServiceError("Decision case not found in this workspace.", 404);
const iso = (ms: number) => new Date(ms).toISOString();
const RECHECK_MS = 60_000;
type CaseListQuery = {
	view?: "assigned" | "requested" | "triage";
	limit?: number;
	after?: string;
};
export class OrganizationService extends OrganizationChart {
	private now: () => number;
	constructor(
		repo: OrganizationRepository,
		directory: OrganizationDirectory,
		private readonly options: {
			now?: () => number;
			/** The case remains the inbox. This optional adapter enqueues a metadata-only wakeup. */
			notify?: (
				workspaceId: string,
				caseId: string,
				notice: CaseNotice,
			) => Promise<void>;
		} = {},
	) {
		super(repo, directory);
		this.now = options.now ?? Date.now;
	}
	private event(
		row: StoredCase,
		event: DecisionHistoryEntry["event"],
		reason: string,
		by: OrgIdentity | null = null,
		positionId = row.assigneePositionId,
		assignee = row.assignee,
	) {
		const at = iso(this.now());
		row.history.push({ event, reason, by, positionId, assignee, at });
		row.updatedAt = at;
	}
	private notice(
		row: StoredCase,
		type: CaseNotice["type"],
		recipient: OrgIdentity,
	) {
		if (
			!this.options.notify ||
			recipient.kind !== "agent" ||
			recipient.type === "instructions"
		)
			return;
		row.notices.push({
			key: `${row.id}:${row.history.length}:${type}`,
			type,
			recipient: { kind: recipient.kind, id: recipient.id },
			at: row.updatedAt,
			outcomeId: row.outcome?.id ?? null,
		});
	}
	private assign(
		row: StoredCase,
		position: OrgPosition,
		identity: OrgIdentity,
		index: number,
		reason: string,
		by: OrgIdentity | null = null,
	) {
		row.stepIndex = index;
		row.status = "open";
		row.assignee = identity;
		row.assigneePositionId = position.id;
		const now = this.now();
		row.deadline = iso(now + row.route.deadlineMinutes * 60_000);
		row.checkAt = iso(Math.min(Date.parse(row.deadline), now + RECHECK_MS));
		this.event(row, "assigned", reason, by);
		this.notice(row, "decision.assigned", identity);
	}
	private async advance(
		row: StoredCase,
		graph: OrgGraph,
		start: number,
		by: OrgIdentity | null = null,
	) {
		for (let i = start; i < row.route.steps.length; i++) {
			const step = row.route.steps[i],
				p = graph.positions.find((x) => x.id === step.position.id);
			const who = await this.eligible(row.workspaceId, p, step.humanOnly);
			if (who && p) {
				this.assign(row, p, who, i, step.reason, by);
				return;
			}
			this.event(
				row,
				"skipped",
				`${step.position.title} is vacant, archived or lacks a currently authorized reviewer.`,
				by,
				step.position.id,
				p?.occupant ?? null,
			);
		}
		row.assignee = null;
		row.assigneePositionId = null;
		row.deadline = null;
		row.checkAt = null;
		row.status = "triage";
		row.stepIndex = row.route.steps.length;
		this.event(
			row,
			"triage",
			"No eligible position remains. A workspace admin can assign a reviewer.",
			by,
		);
	}
	private graphFor(row: StoredCase) {
		return this.repo.select(row.workspaceId, {
			ids: [
				...row.route.steps.map((s) => s.position.id),
				...(row.assigneePositionId ? [row.assigneePositionId] : []),
			],
		});
	}
	private async store(
		row: StoredCase,
		previous: number,
		graphRevision: number,
	) {
		row.revision = previous + 1;
		row.changeIds.push(randomUUID());
		return this.repo.saveCase(row, previous, graphRevision);
	}
	/** Revalidate metadata-only push when enqueuing and when sending a retry. */
	async mayNotify(
		workspaceId: string,
		agentId: string,
		event: {
			type: CaseNotice["type"];
			caseId: string;
			outcomeId: string | null;
		},
	) {
		const actor = { kind: "agent" as const, id: agentId };
		if (!(await this.directory.active(workspaceId))) return false;
		const principal = await this.directory.resolve(workspaceId, actor);
		if (!principal?.use) return false;
		const row = await this.repo.getCase(workspaceId, event.caseId);
		if (!row) return false;
		if (event.type === "decision.outcome")
			return (
				sameActor(row.requester, actor) &&
				!!row.outcome &&
				row.outcome.id === event.outcomeId
			);
		if (
			!principal.decide ||
			row.status !== "open" ||
			!sameActor(row.assignee, actor) ||
			!row.assigneePositionId ||
			!row.deadline ||
			Date.parse(row.deadline) <= this.now()
		)
			return false;
		const graph = await this.repo.select(workspaceId, {
			ids: [row.assigneePositionId],
			active: true,
		});
		return sameActor(graph.positions[0]?.occupant, actor);
	}
	private async deliver(row: StoredCase) {
		// An inbox-only process leaves any previously queued push for a capable worker.
		const notify = this.options.notify;
		if (!notify) return;
		for (const n of row.notices) {
			if (
				await this.mayNotify(row.workspaceId, n.recipient.id, {
					...n,
					caseId: row.id,
				})
			) {
				await notify(row.workspaceId, row.id, n);
			}
			await this.repo.acknowledge(row, n.key);
		}
	}
	private async wake(row: StoredCase) {
		// If enqueuing fails, the pending event survives in the case for the next sweep.
		await this.deliver(row).catch(() => {});
	}
	private async reconcile(initial: StoredCase): Promise<StoredCase> {
		let row = initial;
		for (let attempt = 0; attempt < 12; attempt++) {
			if (row.status !== "open") return row;
			const g = await this.graphFor(row);
			const p = g.positions.find((x) => x.id === row.assigneePositionId);
			const qualified = await this.eligible(
				row.workspaceId,
				p,
				row.route.steps[row.stepIndex]?.humanOnly,
			);
			const now = this.now(),
				expired = !row.deadline || Date.parse(row.deadline) <= now;
			if (!expired && sameActor(qualified, row.assignee)) {
				const next = iso(
					Math.min(Date.parse(row.deadline as string), now + RECHECK_MS),
				);
				if ((row.checkAt ?? "") <= iso(now))
					await this.repo.checkLater(row, next);
				return row;
			}
			const previous = row.revision;
			if (expired) this.event(row, "timeout", "The response deadline passed.");
			else
				this.event(
					row,
					"skipped",
					"The assigned reviewer no longer holds this position or the required workspace permission.",
				);
			if (!expired && qualified && p)
				this.assign(
					row,
					p,
					qualified,
					row.stepIndex,
					"The position has a new eligible occupant.",
				);
			else await this.advance(row, g, row.stepIndex + 1);
			if (await this.store(row, previous, g.revision)) {
				await this.wake(row);
				return row;
			}
			const current = await this.repo.getCase(row.workspaceId, row.id);
			if (!current) throw notFound();
			row = current;
		}
		throw conflict();
	}
	private visible(row: StoredCase, who: OrgPrincipal) {
		return (
			who.manage ||
			sameActor(row.requester, who.identity) ||
			sameActor(row.assignee, who.identity) ||
			sameActor(row.outcome?.by, who.identity)
		);
	}
	private async present(
		row: StoredCase,
		who: OrgPrincipal,
		acceptedHandoff = false,
	): Promise<DecisionCase> {
		// The authorized reviewer receives a receipt for their successful handoff.
		// Later reads and mutations always recheck the new assignment.
		if (!acceptedHandoff && !this.visible(row, who)) throw notFound();
		const { workspaceId, stepIndex, checkAt, notices, changeIds, ...result } =
			row;
		const permitted = await Promise.all(
			result.evidence.map((e) =>
				this.directory.evidence(workspaceId, who.identity, e),
			),
		);
		const canAct =
			row.status === "open" &&
			who.decide &&
			sameActor(who.identity, row.assignee);
		return {
			...result,
			evidence: result.evidence.filter((_, i) => permitted[i]),
			canAct,
			canHandoff:
				(row.status === "triage" && who.manage) ||
				(canAct && stepIndex < row.route.steps.length - 1),
		};
	}
	async open(c: OrgCaller, input: OpenDecisionCase): Promise<DecisionCase> {
		const sourceWorkId = boundedText(input.sourceWorkId, "Source work ID", 200),
			sourceRevision = boundedText(
				input.sourceRevision,
				"Source revision",
				120,
			);
		const key = decisionKey(input.decisionKey),
			question = boundedText(input.question, "Question", 3000);
		const id = createHash("sha256")
			.update(
				JSON.stringify([c.workspaceId, sourceWorkId, sourceRevision, key]),
			)
			.digest("hex");
		if (
			!Array.isArray(input.evidence ?? []) ||
			(input.evidence?.length ?? 0) > 12
		)
			throw new ServiceError("Attach at most 12 evidence references.");
		const evidence: DecisionEvidence[] = (input.evidence ?? []).map((e) => ({
			label: boundedText(e?.label, "Evidence label", 160),
			ref: boundedText(e?.ref, "Evidence reference", 400),
		}));
		for (let attempt = 0; attempt < 12; attempt++) {
			const who = await this.principal(c);
			const existing = await this.repo.getCase(c.workspaceId, id);
			if (existing) {
				if (
					!sameActor(c.actor, existing.requester) ||
					existing.question !== question ||
					JSON.stringify(existing.evidence) !== JSON.stringify(evidence) ||
					(input.requesterPositionId &&
						existing.route.requesterPosition?.id !== input.requesterPositionId)
				)
					throw new ServiceError(
						"This work revision already has a case for this decision with another request.",
						409,
					);
				return this.present(await this.reconcile(existing), who);
			}
			for (const e of evidence)
				if (!(await this.directory.evidence(c.workspaceId, c.actor, e)))
					throw new ServiceError(
						"One or more evidence references are invalid or inaccessible.",
						403,
					);
			const { route, graphRevision } = await this.routing(c, who, input);
			const at = iso(this.now());
			const row: StoredCase = {
				id,
				workspaceId: c.workspaceId,
				revision: 0,
				status: "open",
				decisionKey: key,
				sourceWorkId,
				sourceRevision,
				question,
				requester: who.identity,
				evidence,
				route,
				assignee: null,
				assigneePositionId: null,
				deadline: null,
				createdAt: at,
				updatedAt: at,
				history: [],
				outcome: null,
				notices: [],
				changeIds: [],
				checkAt: null,
				stepIndex: -1,
			};
			this.event(
				row,
				"opened",
				"The requester is blocked on this work revision.",
				who.identity,
				route.requesterPosition?.id ?? null,
				null,
			);
			const graph = await this.graphFor(row);
			if (graph.revision !== graphRevision) continue;
			await this.advance(row, graph, 0);
			if (await this.store(row, 0, graph.revision)) {
				await this.wake(row);
				return this.present(row, who);
			}
		}
		throw conflict();
	}
	private async accessible(c: OrgCaller, who: OrgPrincipal, id: string) {
		const row = await this.repo.getCase(c.workspaceId, id);
		if (!row) throw notFound();
		if (!this.visible(row, who)) {
			// A new occupant may be the first person to open a reassigned case.
			if (row.status !== "open" || !row.assigneePositionId) throw notFound();
			const g = await this.repo.select(c.workspaceId, {
				ids: [row.assigneePositionId],
				active: true,
			});
			if (!who.decide || !sameActor(g.positions[0]?.occupant, c.actor))
				throw notFound();
		}
		return this.reconcile(row);
	}
	async read(c: OrgCaller, id: string) {
		const who = await this.principal(c);
		return this.present(await this.accessible(c, who, id), who);
	}
	async act(
		c: OrgCaller,
		id: string,
		input: ActOnDecision,
	): Promise<DecisionCase> {
		const who = await this.principal(c);
		if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
			throw new ServiceError("Include the case revision you reviewed.");
		if (!["approve", "request_changes", "handoff"].includes(input.action))
			throw new ServiceError("Choose a supported decision action.");
		const reason = boundedText(
			input.reason ?? "",
			"Reason",
			2000,
			input.action !== "request_changes",
		);
		const row = await this.accessible(c, who, id);
		if (!this.visible(row, who)) throw notFound();
		if (row.revision !== input.expectedRevision) throw conflict();
		const triage =
			row.status === "triage" && who.manage && input.action === "handoff";
		const g = await this.graphFor(row);
		if (!triage) {
			if (row.status !== "open") throw conflict();
			const pos = g.positions.find((p) => p.id === row.assigneePositionId);
			if (
				!who.decide ||
				!sameActor(row.assignee, c.actor) ||
				!sameActor(
					await this.eligible(
						c.workspaceId,
						pos,
						row.route.steps[row.stepIndex]?.humanOnly,
					),
					c.actor,
				)
			)
				throw forbidden();
			if (!row.deadline || Date.parse(row.deadline) <= this.now()) {
				await this.reconcile(row);
				throw conflict();
			}
		}
		if (input.action === "handoff") {
			const index = input.targetPositionId
				? row.route.steps.findIndex(
						(s) => s.position.id === input.targetPositionId,
					)
				: row.stepIndex + 1;
			if (triage && !input.targetPositionId)
				throw new ServiceError(
					"Choose a position to receive this triage case.",
				);
			if (
				!triage &&
				(index <= row.stepIndex || index >= row.route.steps.length)
			)
				throw new ServiceError(
					"Choose a later position in the recorded route.",
					403,
				);
			const targetId =
				input.targetPositionId ?? row.route.steps[index]?.position.id;
			const target = await this.repo.select(c.workspaceId, { ids: [targetId] });
			if (g.revision !== target.revision) throw conflict();
			const position = target.positions[0],
				person = await this.eligible(
					c.workspaceId,
					position,
					!triage && row.route.steps[index]?.humanOnly,
				);
			if (!position || !person)
				throw new ServiceError("This position has no eligible reviewer.", 409);
			this.event(
				row,
				"handoff",
				reason || "The reviewer handed off the decision.",
				who.identity,
			);
			this.assign(
				row,
				position,
				person,
				triage ? row.route.steps.length : index,
				triage
					? "Assigned by a workspace admin from human triage."
					: "An authorized handoff along the recorded route.",
				who.identity,
			);
		} else {
			const status =
				input.action === "approve" ? "approved" : "changes_requested";
			this.event(
				row,
				status,
				reason || "Approved the requested change for this work revision.",
				who.identity,
			);
			row.status = status;
			row.deadline = null;
			row.checkAt = null;
			row.outcome = {
				id: randomUUID(),
				caseId: id,
				sourceWorkId: row.sourceWorkId,
				sourceRevision: row.sourceRevision,
				decisionKey: row.decisionKey,
				status,
				reason,
				by: who.identity,
				at: row.updatedAt,
			};
			this.notice(row, "decision.outcome", row.requester);
		}
		if (!(await this.store(row, input.expectedRevision, g.revision)))
			throw conflict();
		await this.wake(row);
		return this.present(row, who, input.action === "handoff");
	}
	private async page(
		c: OrgCaller,
		who: OrgPrincipal,
		q: CaseFilter,
	): Promise<DecisionCasePage> {
		const candidates = await this.repo.listCases(c.workspaceId, {
			...q,
			limit: q.limit + 1,
		});
		const cases: DecisionCase[] = [];
		for (const row of candidates.slice(0, q.limit)) {
			const current = await this.reconcile(row);
			if (!this.visible(current, who)) continue;
			if (
				q.view === "assigned" &&
				(current.status !== "open" || !sameActor(current.assignee, c.actor))
			)
				continue;
			cases.push(await this.present(current, who));
		}
		return {
			cases,
			next: candidates.length > q.limit ? candidates[q.limit - 1].id : null,
		};
	}
	async list(c: OrgCaller, q: CaseListQuery = {}): Promise<DecisionCasePage> {
		const who = await this.principal(c),
			view = q.view ?? "assigned";
		if (!["assigned", "requested", "triage"].includes(view))
			throw new ServiceError("Choose assigned, requested or triage.");
		if (view === "triage" && !who.manage) throw forbidden();
		const own =
			view === "assigned"
				? (await this.repo.occupied(c.workspaceId, c.actor)).positionIds
				: [];
		return this.page(c, who, {
			view,
			actor: c.actor,
			admin: who.manage,
			assignedPositions: own,
			limit: pageLimit(q.limit),
			after: q.after,
		});
	}
	async detail(c: OrgCaller, id: string): Promise<OrgPositionDetail> {
		const who = await this.principal(c),
			g = await this.repo.select(c.workspaceId, { ids: [id] });
		const position = g.positions[0];
		if (!position) throw missingPosition();
		const settings = await this.repo.select(c.workspaceId, {
			ids: [position.managerId, g.humanFallbackPositionId].filter(
				(v): v is string => !!v,
			),
		});
		const cases = await this.page(c, who, {
			actor: c.actor,
			admin: who.manage,
			positionId: id,
			limit: 10,
		});
		return {
			position,
			manager:
				settings.positions.find((p) => p.id === position.managerId) ?? null,
			fallback:
				settings.positions.find((p) => p.id === g.humanFallbackPositionId) ??
				null,
			cases: cases.cases,
		};
	}
	async sweep(limit = 50) {
		await this.repo.recover();
		for (const row of await this.repo.due(iso(this.now()), limit)) {
			if (await this.directory.active(row.workspaceId))
				await this.reconcile(row);
			else await this.repo.checkLater(row, iso(this.now() + RECHECK_MS));
		}
		if (this.options.notify)
			for (const row of await this.repo.undelivered(limit))
				await this.wake(row);
	}
}

import type {
	DecisionCase,
	DecisionRule,
	OrgActorRef,
	OrgPosition,
	OrgSettings,
} from "@autonomo.us/common";
import type { Document, Filter } from "mongodb";
import { isDuplicateKey, type MongoConnection } from "../mongo.js";
import { ServiceError } from "../service-error.js";

export const WORKSPACE_ORGANIZATIONS_COLLECTION = "workspace_organizations";
export const WORKSPACE_DECISION_CASES_COLLECTION = "workspace_decision_cases";

export type OrgGraph = OrgSettings & {
	revision: number;
	positions: OrgPosition[];
	rules: DecisionRule[];
};
export const emptyGraph = (): OrgGraph => ({
	revision: 0,
	positions: [],
	rules: [],
	leadPositionId: null,
	humanFallbackPositionId: null,
});
export type PositionQuery = {
	ids?: string[];
	parentId?: string | null;
	occupant?: OrgActorRef;
	q?: string;
	after?: string;
	limit?: number;
	active?: boolean;
};
export type CaseNotice = {
	key: string;
	type: "decision.assigned" | "decision.outcome";
	recipient: OrgActorRef;
	at: string;
	outcomeId: string | null;
};
export type StoredCase = Omit<DecisionCase, "canAct" | "canHandoff"> & {
	workspaceId: string;
	stepIndex: number;
	checkAt: string | null;
	notices: CaseNotice[];
	/** Identifies a prepared transition even if a different process helps it finish. */
	changeIds: string[];
};
export type CaseFilter = {
	actor?: OrgActorRef;
	view?: "assigned" | "requested" | "triage";
	assignedPositions?: string[];
	admin?: boolean;
	positionId?: string;
	after?: string;
	limit: number;
};
export type OccupiedPositions = OrgSettings & { positionIds: string[] };
export interface OrganizationRepository {
	/** A viewer holding many offices only requires their IDs to identify a branch. */
	occupied(workspaceId: string, actor: OrgActorRef): Promise<OccupiedPositions>;
	graph(workspaceId: string): Promise<OrgGraph>;
	/** Only matching positions and rules leave storage. Omit ruleKey to omit all rules. */
	select(
		workspaceId: string,
		query: PositionQuery,
		ruleKey?: string,
	): Promise<OrgGraph>;
	saveGraph(
		workspaceId: string,
		graph: OrgGraph,
		expected: number,
	): Promise<boolean>;
	getCase(workspaceId: string, id: string): Promise<StoredCase | null>;
	/** Atomically fences the routing graph and compares the case revision. Zero creates a case. */
	saveCase(
		row: StoredCase,
		expected: number,
		graphRevision: number,
	): Promise<boolean>;
	listCases(workspaceId: string, query: CaseFilter): Promise<StoredCase[]>;
	due(now: string, limit: number): Promise<StoredCase[]>;
	checkLater(row: StoredCase, checkAt: string): Promise<void>;
	undelivered(limit: number): Promise<StoredCase[]>;
	acknowledge(row: StoredCase, key: string): Promise<void>;
	recover(): Promise<void>;
}
export const sameActor = (
	left: OrgActorRef | null | undefined,
	right: OrgActorRef | null | undefined,
) => !!left && !!right && left.kind === right.kind && left.id === right.id;
const clone = <T>(value: T): T => structuredClone(value);
function matches(p: OrgPosition, query: PositionQuery) {
	return (
		(!query.active || !p.archived) &&
		(!query.ids || query.ids.includes(p.id)) &&
		(query.parentId === undefined || p.managerId === query.parentId) &&
		(!query.occupant || sameActor(p.occupant, query.occupant)) &&
		(!query.q ||
			[p.title, p.remit, p.occupant?.name ?? ""].some((field) =>
				field.toLowerCase().includes(query.q ?? ""),
			)) &&
		(!query.after || p.id > query.after)
	);
}
function matchesCase(row: StoredCase, q: CaseFilter) {
	if (q.after && row.id <= q.after) return false;
	if (
		q.positionId &&
		!(
			row.route.requesterPosition?.id === q.positionId ||
			row.route.steps.some((step) => step.position.id === q.positionId) ||
			row.assigneePositionId === q.positionId
		)
	)
		return false;
	if (q.view === "triage") return q.admin && row.status === "triage";
	if (q.view === "assigned")
		return (
			row.status === "open" &&
			(sameActor(row.assignee, q.actor) ||
				q.assignedPositions?.includes(row.assigneePositionId ?? ""))
		);
	if (q.view === "requested") return sameActor(row.requester, q.actor);
	return (
		q.admin ||
		sameActor(row.requester, q.actor) ||
		sameActor(row.assignee, q.actor) ||
		sameActor(row.outcome?.by, q.actor)
	);
}
export class MemoryOrganizationRepository implements OrganizationRepository {
	private graphs = new Map<string, OrgGraph>();
	private cases = new Map<string, StoredCase>();
	async graph(w: string) {
		return clone(this.graphs.get(w) ?? emptyGraph());
	}
	async occupied(w: string, actor: OrgActorRef): Promise<OccupiedPositions> {
		const graph = this.graphs.get(w) ?? emptyGraph();
		return {
			leadPositionId: graph.leadPositionId,
			humanFallbackPositionId: graph.humanFallbackPositionId,
			positionIds: graph.positions
				.filter((p) => !p.archived && sameActor(p.occupant, actor))
				.map((p) => p.id),
		};
	}
	async select(w: string, q: PositionQuery, ruleKey?: string) {
		const graph = this.graphs.get(w) ?? emptyGraph();
		return clone({
			...graph,
			positions: graph.positions.filter((p) => matches(p, q)).slice(0, q.limit),
			rules: graph.rules.filter((r) => r.key === ruleKey || ruleKey === "*"),
		});
	}
	async saveGraph(w: string, g: OrgGraph, expected: number) {
		if ((this.graphs.get(w)?.revision ?? 0) !== expected) return false;
		this.graphs.set(w, clone(g));
		return true;
	}
	async getCase(w: string, id: string) {
		const row = this.cases.get(id);
		return row?.workspaceId === w ? clone(row) : null;
	}
	async saveCase(row: StoredCase, expected: number, graphRevision: number) {
		if (
			(this.graphs.get(row.workspaceId)?.revision ?? 0) !== graphRevision ||
			(this.cases.get(row.id)?.revision ?? 0) !== expected
		)
			return false;
		this.cases.set(row.id, clone(row));
		return true;
	}
	async listCases(w: string, q: CaseFilter) {
		return clone(
			[...this.cases.values()]
				.filter((row) => row.workspaceId === w && matchesCase(row, q))
				.sort((a, b) => a.id.localeCompare(b.id))
				.slice(0, q.limit),
		);
	}
	async due(now: string, limit: number) {
		return clone(
			[...this.cases.values()]
				.filter((r) => r.checkAt && r.checkAt <= now)
				.sort((a, b) => (a.checkAt ?? "").localeCompare(b.checkAt ?? ""))
				.slice(0, limit),
		);
	}
	async checkLater(row: StoredCase, checkAt: string) {
		const current = this.cases.get(row.id);
		if (
			current?.workspaceId === row.workspaceId &&
			current.revision === row.revision
		)
			current.checkAt = checkAt;
	}
	async undelivered(limit: number) {
		return clone(
			[...this.cases.values()].filter((r) => r.notices.length).slice(0, limit),
		);
	}
	async acknowledge(row: StoredCase, key: string) {
		const current = this.cases.get(row.id);
		if (current?.workspaceId === row.workspaceId)
			current.notices = current.notices.filter((n) => n.key !== key);
	}
	async recover() {}
}

type Prepared = { id: string; expected: number; row: StoredCase };
type GraphDoc = OrgGraph & { _id: string; prepared?: Prepared };
type CaseDoc = StoredCase & { _id: string };
const omitId = <T extends { _id: string }>(doc: T) => {
	const { _id, ...rest } = doc;
	return rest;
};
const actorFilter = (field: string, actor?: OrgActorRef) => ({
	[`${field}.kind`]: actor?.kind,
	[`${field}.id`]: actor?.id,
});
const literal = (value: unknown) => ({ $literal: value });
function positionProjection(q: PositionQuery) {
	const conditions: Document[] = [];
	if (q.active) conditions.push({ $eq: ["$$p.archived", false] });
	if (q.ids) conditions.push({ $in: ["$$p.id", literal(q.ids)] });
	if (q.parentId !== undefined)
		conditions.push({ $eq: ["$$p.managerId", literal(q.parentId)] });
	if (q.occupant)
		conditions.push(
			{ $eq: ["$$p.occupant.id", literal(q.occupant.id)] },
			{ $eq: ["$$p.occupant.kind", literal(q.occupant.kind)] },
		);
	if (q.after) conditions.push({ $gt: ["$$p.id", literal(q.after)] });
	if (q.q)
		conditions.push({
			$or: ["$$p.title", "$$p.remit", "$$p.occupant.name"].map((field) => ({
				$gte: [
					{
						$indexOfCP: [{ $toLower: { $ifNull: [field, ""] } }, literal(q.q)],
					},
					0,
				],
			})),
		});
	const filtered = {
		$filter: {
			input: "$positions",
			as: "p",
			cond: conditions.length ? { $and: conditions } : true,
		},
	};
	return q.limit === undefined
		? filtered
		: q.limit === 0
			? literal([])
			: { $slice: [filtered, q.limit] };
}

/**
 * The graph fits in one versioned document so competing branch moves cannot form a cycle.
 * Cases have their own indexed documents. A short, recoverable write intent in the graph
 * fences a case transition against a concurrent reassignment, including on standalone MongoDB.
 * Readers project the requested slice of the graph inside MongoDB.
 */
export class MongoOrganizationRepository implements OrganizationRepository {
	private indexed?: Promise<void>;
	constructor(private readonly mongo: MongoConnection) {}
	private graphs() {
		return this.mongo.collection<GraphDoc>(WORKSPACE_ORGANIZATIONS_COLLECTION);
	}
	private cases() {
		return this.mongo.collection<CaseDoc>(WORKSPACE_DECISION_CASES_COLLECTION);
	}
	private async ready() {
		this.indexed ??= Promise.all([
			this.cases().createIndex({
				workspaceId: 1,
				"requester.kind": 1,
				"requester.id": 1,
				_id: 1,
			}),
			this.cases().createIndex({
				workspaceId: 1,
				status: 1,
				"assignee.kind": 1,
				"assignee.id": 1,
				_id: 1,
			}),
			this.cases().createIndex({ workspaceId: 1, status: 1, _id: 1 }),
			this.cases().createIndex(
				{ checkAt: 1 },
				{ partialFilterExpression: { checkAt: { $type: "string" } } },
			),
			this.cases().createIndex(
				{ "notices.0": 1 },
				{ partialFilterExpression: { "notices.0": { $exists: true } } },
			),
		])
			.then(() => {})
			.catch((error) => {
				this.indexed = undefined;
				throw error;
			});
		return this.indexed;
	}
	private async storage<T>(run: () => Promise<T>): Promise<T> {
		try {
			await this.ready();
			return await run();
		} catch (error) {
			throw new ServiceError(
				"Organization storage is unavailable. Check MongoDB and retry.",
				503,
				{ cause: error },
			);
		}
	}
	async occupied(w: string, actor: OrgActorRef): Promise<OccupiedPositions> {
		return this.storage(
			async () =>
				(await this.graphs()
					.aggregate<OccupiedPositions>([
						{ $match: { _id: w } },
						{
							$project: {
								_id: 0,
								leadPositionId: 1,
								humanFallbackPositionId: 1,
								positionIds: {
									$map: {
										input: positionProjection({
											active: true,
											occupant: actor,
										}),
										as: "p",
										in: "$$p.id",
									},
								},
							},
						},
					])
					.next()) ?? {
					leadPositionId: null,
					humanFallbackPositionId: null,
					positionIds: [],
				},
		);
	}
	async graph(w: string): Promise<OrgGraph> {
		return this.storage(async () => {
			const doc = await this.graphs().findOne(
				{ _id: w },
				{ projection: { prepared: 0 } },
			);
			return doc ? omitId(doc) : emptyGraph();
		});
	}
	async select(
		w: string,
		q: PositionQuery,
		ruleKey?: string,
	): Promise<OrgGraph> {
		return this.storage(
			async () =>
				(await this.graphs()
					.aggregate<OrgGraph>([
						{ $match: { _id: w } },
						{
							$project: {
								_id: 0,
								revision: 1,
								leadPositionId: 1,
								humanFallbackPositionId: 1,
								positions: positionProjection(q),
								rules:
									ruleKey === "*"
										? "$rules"
										: ruleKey
											? {
													$filter: {
														input: "$rules",
														as: "r",
														cond: { $eq: ["$$r.key", literal(ruleKey)] },
													},
												}
											: literal([]),
							},
						},
					])
					.next()) ?? emptyGraph(),
		);
	}
	private async ensureGraph(w: string) {
		try {
			await this.graphs().updateOne(
				{ _id: w },
				{ $setOnInsert: emptyGraph() },
				{ upsert: true },
			);
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
		}
	}
	async saveGraph(w: string, g: OrgGraph, expected: number) {
		return this.storage(async () => {
			await this.help(w);
			if (expected === 0) await this.ensureGraph(w);
			return (
				(
					await this.graphs().replaceOne(
						{ _id: w, revision: expected, prepared: { $exists: false } },
						g,
					)
				).modifiedCount === 1
			);
		});
	}
	async getCase(w: string, id: string) {
		return this.storage(async () => {
			const doc = await this.cases().findOne({ _id: id, workspaceId: w });
			return doc ? omitId(doc) : null;
		});
	}
	private async finish(w: string, intent: Prepared): Promise<boolean> {
		const row = intent.row;
		let accepted: boolean;
		if (intent.expected === 0) {
			try {
				await this.cases().insertOne({ ...row, _id: row.id });
				accepted = true;
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
				accepted = false;
			}
		} else {
			accepted =
				(
					await this.cases().replaceOne(
						{ _id: row.id, workspaceId: w, revision: intent.expected },
						row,
					)
				).modifiedCount === 1;
		}
		if (!accepted)
			accepted = !!(await this.cases().findOne(
				{ _id: row.id, workspaceId: w, changeIds: intent.id },
				{ projection: { _id: 1 } },
			));
		await this.graphs().updateOne(
			{ _id: w, "prepared.id": intent.id },
			{ $unset: { prepared: "" } },
		);
		return accepted;
	}
	private async help(w: string) {
		const doc = await this.graphs().findOne(
			{ _id: w, prepared: { $exists: true } },
			{ projection: { prepared: 1 } },
		);
		if (doc?.prepared) await this.finish(w, doc.prepared);
	}
	async saveCase(row: StoredCase, expected: number, graphRevision: number) {
		return this.storage(async () => {
			const w = row.workspaceId;
			await this.help(w);
			if (graphRevision === 0) await this.ensureGraph(w);
			const intent = {
				id: row.changeIds[row.changeIds.length - 1],
				row,
				expected,
			};
			const reserved = await this.graphs().updateOne(
				{ _id: w, revision: graphRevision, prepared: { $exists: false } },
				{ $set: { prepared: intent } },
			);
			return reserved.modifiedCount === 1 && this.finish(w, intent);
		});
	}
	async listCases(w: string, q: CaseFilter) {
		const filter: Filter<CaseDoc> = { workspaceId: w };
		if (q.after) filter._id = { $gt: q.after };
		if (q.view === "assigned")
			Object.assign(filter, {
				status: "open",
				$or: [
					actorFilter("assignee", q.actor),
					{ assigneePositionId: { $in: q.assignedPositions ?? [] } },
				],
			});
		else if (q.view === "requested")
			Object.assign(filter, actorFilter("requester", q.actor));
		else if (q.view === "triage") filter.status = "triage";
		else if (!q.admin)
			filter.$or = ["requester", "assignee", "outcome.by"].map((field) =>
				actorFilter(field, q.actor),
			);
		if (q.positionId)
			filter.$and = [
				{
					$or: [
						{ "route.requesterPosition.id": q.positionId },
						{ "route.steps.position.id": q.positionId },
						{ assigneePositionId: q.positionId },
					],
				},
			];
		return this.storage(async () =>
			(
				await this.cases()
					.find(filter)
					.sort({ _id: 1 })
					.limit(q.limit)
					.toArray()
			).map(omitId),
		);
	}
	async due(now: string, limit: number) {
		return this.storage(async () =>
			(
				await this.cases()
					.find({ checkAt: { $type: "string", $lte: now } })
					.sort({ checkAt: 1 })
					.limit(limit)
					.toArray()
			).map(omitId),
		);
	}
	async checkLater(row: StoredCase, checkAt: string) {
		await this.storage(() =>
			this.cases().updateOne(
				{ _id: row.id, workspaceId: row.workspaceId, revision: row.revision },
				{ $set: { checkAt } },
			),
		);
	}
	async undelivered(limit: number) {
		return this.storage(async () =>
			(
				await this.cases()
					.find({ "notices.0": { $exists: true } })
					.limit(limit)
					.toArray()
			).map(omitId),
		);
	}
	async acknowledge(row: StoredCase, key: string) {
		await this.storage(() =>
			this.cases().updateOne(
				{ _id: row.id, workspaceId: row.workspaceId },
				{ $pull: { notices: { key } } },
			),
		);
	}
	async recover() {
		await this.storage(async () => {
			const docs = await this.graphs()
				.find({ prepared: { $exists: true } }, { projection: { prepared: 1 } })
				.limit(50)
				.toArray();
			for (const doc of docs)
				if (doc.prepared) await this.finish(doc._id, doc.prepared);
		});
	}
}

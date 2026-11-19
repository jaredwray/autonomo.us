import type {
	CreateLoop,
	LoopObservation,
	LoopRun,
	LoopWorkflow,
	OrgActorRef,
} from "@autonomo.us/common";
import { isDuplicateKey, type MongoConnection } from "../mongo.js";

import {
	type AssignmentClock,
	type AssignmentFields,
	assignmentFields,
} from "./assignments.js";

export const LOOP_COLLECTION = "workspace_loops";
export const LOOP_OBSERVATIONS_COLLECTION = "workspace_loop_observations";
export const LOOP_RUNS_COLLECTION = "workspace_loop_runs";
export type Definition = CreateLoop & {
	id: string;
	workspaceId: string;
	version: number;
	ownerName: string;
};
export type ObservationRecord = {
	workspaceId: string;
	loopId: string;
	observation: LoopObservation;
	version: number;
	workflow: LoopWorkflow | null;
};
export type RunRecord = {
	/** Immutable wording of the operation authorized for this run. */
	approvalQuestion?: string;
	requester?: OrgActorRef;
	workspaceId: string;
	run: LoopRun;
	createdAt: string;
	waiting: boolean;
	ownerPositionId: string;
};
export type SampleCursor = Pick<LoopObservation, "observedAt" | "eventId">;
function compareSample(a: SampleCursor, b: SampleCursor) {
	return (
		b.observedAt.localeCompare(a.observedAt) ||
		Buffer.compare(Buffer.from(b.eventId), Buffer.from(a.eventId))
	);
}
type Day = { day: string; numerator: number; denominator: number };
export interface LoopRepository {
	assigned(
		workspaceId: string,
		actor: OrgActorRef,
		after: string,
		limit: number,
	): Promise<RunRecord[]>;
	dueAssignments(
		field: AssignmentClock,
		now: number,
		limit: number,
	): Promise<RunRecord[]>;
	deferAssignment(
		record: RunRecord,
		field: AssignmentClock,
		now: number,
		until: number,
	): Promise<boolean>;
	acknowledgeAssignment(record: RunRecord): Promise<void>;
	list(w: string): Promise<Definition[]>;
	get(w: string, id: string): Promise<Definition | null>;
	save(definition: Definition, expected: number): Promise<boolean>;
	insertObservation(record: ObservationRecord): Promise<ObservationRecord>;
	triggers(record: ObservationRecord, threshold: number): Promise<number>;
	recent(w: string, id: string, limit: number): Promise<LoopObservation[]>;
	samples(
		w: string,
		id: string,
		from: string,
		to: string,
		before: SampleCursor | null,
		limit: number,
	): Promise<LoopObservation[]>;
	lastMetricAt(w: string, id: string): Promise<string | null>;
	days(w: string, id: string, from: string): Promise<Day[]>;
	run(w: string, id: string, runId: string): Promise<RunRecord | null>;
	saveRun(record: RunRecord, expected: number): Promise<boolean>;
	runs(w: string, id: string, limit: number): Promise<RunRecord[]>;
	waiting(w: string, id: string): Promise<RunRecord[]>;
	active(w: string, id: string): Promise<number>;
}
const key = (...parts: string[]) => JSON.stringify(parts);
const eventKey = (r: ObservationRecord) =>
	key(r.workspaceId, r.loopId, r.observation.eventId);
export class MemoryLoopRepository implements LoopRepository {
	private definitions = new Map<string, Definition>();
	private observations = new Map<string, ObservationRecord>();
	private records = new Map<string, RunRecord & AssignmentFields>();
	async list(w: string) {
		return structuredClone(
			[...this.definitions.values()]
				.filter((d) => d.workspaceId === w)
				.sort(
					(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
				),
		);
	}
	async get(w: string, id: string) {
		return structuredClone(this.definitions.get(key(w, id)) ?? null);
	}
	async save(d: Definition, expected: number) {
		const k = key(d.workspaceId, d.id);
		if ((this.definitions.get(k)?.version ?? 0) !== expected) return false;
		this.definitions.set(k, structuredClone(d));
		return true;
	}
	async insertObservation(r: ObservationRecord) {
		const k = eventKey(r);
		const old = this.observations.get(k);
		if (old) return structuredClone(old);
		this.observations.set(k, structuredClone(r));
		return structuredClone(r);
	}
	private observed(w: string, id: string) {
		return [...this.observations.values()].filter(
			(e) => e.workspaceId === w && e.loopId === id,
		);
	}
	async triggers(r: ObservationRecord, threshold: number) {
		return Math.min(
			threshold,
			this.observed(r.workspaceId, r.loopId).filter(
				(e) =>
					e.version === r.version &&
					e.observation.trigger &&
					e.observation.workId === r.observation.workId &&
					e.observation.workRevision === r.observation.workRevision,
			).length,
		);
	}
	async samples(
		w: string,
		id: string,
		from: string,
		to: string,
		before: SampleCursor | null,
		limit: number,
	) {
		const rows = this.observed(w, id)
			.map((r) => r.observation)
			.filter(
				(o) =>
					o.denominator > 0 &&
					o.observedAt >= from &&
					o.observedAt < to &&
					(!before || compareSample(o, before) > 0),
			)
			.sort(compareSample)
			.slice(0, limit);
		return structuredClone(rows);
	}
	async recent(w: string, id: string, limit: number) {
		return structuredClone(
			this.observed(w, id)
				.map((r) => r.observation)
				.sort(
					(a, b) =>
						b.observedAt.localeCompare(a.observedAt) ||
						b.eventId.localeCompare(a.eventId),
				)
				.slice(0, limit),
		);
	}
	async lastMetricAt(w: string, id: string) {
		return (
			this.observed(w, id)
				.filter((r) => r.observation.denominator > 0)
				.map((r) => r.observation.observedAt)
				.sort()
				.at(-1) ?? null
		);
	}
	async days(w: string, id: string, from: string) {
		const sums = new Map<string, Day>();
		for (const { observation: e } of this.observed(w, id)) {
			if (e.observedAt < from) continue;
			const day = e.observedAt.slice(0, 10);
			const point = sums.get(day) ?? { day, numerator: 0, denominator: 0 };
			point.numerator += e.numerator;
			point.denominator += e.denominator;
			sums.set(day, point);
		}
		return [...sums.values()];
	}
	async run(w: string, id: string, runId: string) {
		return structuredClone(this.records.get(key(w, id, runId)) ?? null);
	}
	async saveRun(r: RunRecord, expected: number) {
		const k = key(r.workspaceId, r.run.loopId, r.run.id);
		if ((this.records.get(k)?.run.revision ?? 0) !== expected) return false;
		this.records.set(k, structuredClone({ ...r, ...assignmentFields(r) }));
		return true;
	}
	async assigned(w: string, actor: OrgActorRef, after: string, limit: number) {
		return structuredClone(
			[...this.records.values()]
				.filter(
					(row) =>
						row.workspaceId === w &&
						row.assignedKind === actor.kind &&
						row.assignedId === actor.id &&
						row.run.id > after,
				)
				.sort((a, b) => a.run.id.localeCompare(b.run.id))
				.slice(0, limit),
		);
	}
	async dueAssignments(field: AssignmentClock, now: number, limit: number) {
		return structuredClone(
			[...this.records.values()]
				.filter((row) => row[field] !== null && row[field] <= now)
				.sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0))
				.slice(0, limit),
		);
	}
	private stored(row: RunRecord) {
		const found = this.records.get(
			key(row.workspaceId, row.run.loopId, row.run.id),
		);
		return found?.run.revision === row.run.revision ? found : null;
	}
	async deferAssignment(
		row: RunRecord,
		field: AssignmentClock,
		now: number,
		until: number,
	) {
		const found = this.stored(row);
		if (!found || found[field] === null || found[field] > now) return false;
		found[field] = until;
		return true;
	}
	async acknowledgeAssignment(row: RunRecord) {
		const found = this.stored(row);
		if (found) found.wakeAt = null;
	}
	private matching(w: string, id: string) {
		return [...this.records.values()].filter(
			(r) => r.workspaceId === w && r.run.loopId === id,
		);
	}
	async runs(w: string, id: string, limit: number) {
		return structuredClone(
			this.matching(w, id)
				.sort(
					(a, b) =>
						b.createdAt.localeCompare(a.createdAt) ||
						b.run.id.localeCompare(a.run.id),
				)
				.slice(0, limit),
		);
	}
	async waiting(w: string, id: string) {
		return structuredClone(this.matching(w, id).filter((r) => r.waiting));
	}
	async active(w: string, id: string) {
		return this.matching(w, id).filter((r) => r.run.status === "active").length;
	}
}

export class MongoLoopRepository implements LoopRepository {
	constructor(private readonly mongo: MongoConnection) {}
	private defs() {
		return this.mongo.collection<Definition & { _id: string }>(LOOP_COLLECTION);
	}
	private obs() {
		return this.mongo.collection<ObservationRecord & { _id: string }>(
			LOOP_OBSERVATIONS_COLLECTION,
		);
	}
	private work() {
		return this.mongo.collection<
			RunRecord & AssignmentFields & { _id: string }
		>(LOOP_RUNS_COLLECTION);
	}
	private indexes?: Promise<unknown>;
	private ready() {
		this.indexes ??= Promise.all([
			this.defs().createIndex({ workspaceId: 1, name: 1, id: 1 }),
			this.obs().createIndex({
				workspaceId: 1,
				loopId: 1,
				"observation.observedAt": -1,
				"observation.eventId": -1,
			}),
			this.obs().createIndex({
				workspaceId: 1,
				loopId: 1,
				version: 1,
				"observation.workId": 1,
				"observation.workRevision": 1,
				"observation.trigger": 1,
			}),
			this.work().createIndex({
				workspaceId: 1,
				"run.loopId": 1,
				createdAt: -1,
				"run.id": -1,
			}),
			this.work().createIndex({ workspaceId: 1, "run.loopId": 1, waiting: 1 }),
			this.work().createIndex({
				workspaceId: 1,
				assignedKind: 1,
				assignedId: 1,
				"run.id": 1,
			}),
			this.work().createIndex(
				{ decisionCheckAt: 1 },
				{ partialFilterExpression: { decisionCheckAt: { $type: "number" } } },
			),
			this.work().createIndex(
				{ wakeAt: 1 },
				{ partialFilterExpression: { wakeAt: { $type: "number" } } },
			),
			this.work().createIndex({
				workspaceId: 1,
				"run.loopId": 1,
				"run.status": 1,
			}),
		]).catch((e) => {
			this.indexes = undefined;
			throw e;
		});
		return this.indexes;
	}
	async list(w: string) {
		await this.ready();
		return this.defs()
			.find({ workspaceId: { $eq: w } }, { projection: { _id: 0 } })
			.sort({ name: 1, id: 1 })
			.toArray();
	}
	async get(w: string, id: string) {
		return this.defs().findOne(
			{ _id: { $eq: key(w, id) }, workspaceId: { $eq: w } },
			{ projection: { _id: 0 } },
		);
	}
	async save(d: Definition, expected: number) {
		const _id = key(d.workspaceId, d.id);
		if (expected === 0) {
			try {
				await this.defs().insertOne({ ...d, _id });
				return true;
			} catch (e) {
				if (isDuplicateKey(e)) return false;
				throw e;
			}
		}
		return (
			(
				await this.defs().replaceOne(
					{
						_id: { $eq: _id },
						workspaceId: { $eq: d.workspaceId },
						version: { $eq: expected },
					},
					d,
				)
			).matchedCount === 1
		);
	}
	async insertObservation(r: ObservationRecord) {
		const _id = eventKey(r);
		try {
			await this.obs().insertOne({ ...r, _id });
			return r;
		} catch (e) {
			if (!isDuplicateKey(e)) throw e;
			const old = await this.obs().findOne(
				{ _id: { $eq: _id }, workspaceId: { $eq: r.workspaceId } },
				{ projection: { _id: 0 } },
			);
			if (!old) throw e;
			return old;
		}
	}
	async triggers(r: ObservationRecord, threshold: number) {
		await this.ready();
		return this.obs().countDocuments(
			{
				workspaceId: { $eq: r.workspaceId },
				loopId: { $eq: r.loopId },
				version: { $eq: r.version },
				"observation.workId": { $eq: r.observation.workId },
				"observation.workRevision": { $eq: r.observation.workRevision },
				"observation.trigger": true,
			},
			{ limit: threshold },
		);
	}
	async samples(
		w: string,
		id: string,
		from: string,
		to: string,
		before: SampleCursor | null,
		limit: number,
	) {
		await this.ready();
		const rows = await this.obs()
			.find(
				{
					workspaceId: { $eq: w },
					loopId: { $eq: id },
					"observation.denominator": { $gt: 0 },
					"observation.observedAt": { $gte: from, $lt: to },
					...(before
						? {
								$or: [
									{ "observation.observedAt": { $lt: before.observedAt } },
									{
										"observation.observedAt": { $eq: before.observedAt },
										"observation.eventId": { $lt: before.eventId },
									},
								],
							}
						: {}),
				},
				{ projection: { observation: 1, _id: 0 } },
			)
			.sort({ "observation.observedAt": -1, "observation.eventId": -1 })
			.limit(limit)
			.toArray();
		return rows.map((r) => r.observation);
	}
	async recent(w: string, id: string, limit: number) {
		await this.ready();
		return (
			await this.obs()
				.find(
					{ workspaceId: { $eq: w }, loopId: { $eq: id } },
					{ projection: { observation: 1, _id: 0 } },
				)
				.sort({ "observation.observedAt": -1, "observation.eventId": -1 })
				.limit(limit)
				.toArray()
		).map((r) => r.observation);
	}
	async lastMetricAt(w: string, id: string) {
		await this.ready();
		return (
			(
				await this.obs().findOne(
					{
						workspaceId: { $eq: w },
						loopId: { $eq: id },
						"observation.denominator": { $gt: 0 },
					},
					{
						sort: { "observation.observedAt": -1 },
						projection: { "observation.observedAt": 1 },
					},
				)
			)?.observation.observedAt ?? null
		);
	}
	async days(w: string, id: string, from: string) {
		await this.ready();
		return this.obs()
			.aggregate<Day>([
				{
					$match: {
						workspaceId: { $eq: w },
						loopId: { $eq: id },
						"observation.observedAt": { $gte: from },
					},
				},
				{
					$group: {
						_id: { $substrBytes: ["$observation.observedAt", 0, 10] },
						numerator: { $sum: "$observation.numerator" },
						denominator: { $sum: "$observation.denominator" },
					},
				},
				{ $project: { day: "$_id", numerator: 1, denominator: 1, _id: 0 } },
			])
			.toArray();
	}
	async run(w: string, id: string, runId: string) {
		return this.work().findOne(
			{ _id: { $eq: key(w, id, runId) }, workspaceId: { $eq: w } },
			{ projection: { _id: 0 } },
		);
	}
	async saveRun(r: RunRecord, expected: number) {
		const _id = key(r.workspaceId, r.run.loopId, r.run.id);
		if (expected === 0) {
			try {
				await this.work().insertOne({ ...r, ...assignmentFields(r), _id });
				return true;
			} catch (e) {
				if (isDuplicateKey(e)) return false;
				throw e;
			}
		}
		return (
			(
				await this.work().replaceOne(
					{
						_id: { $eq: _id },
						workspaceId: { $eq: r.workspaceId },
						"run.revision": { $eq: expected },
					},
					{ ...r, ...assignmentFields(r) },
				)
			).matchedCount === 1
		);
	}
	async assigned(w: string, actor: OrgActorRef, after: string, limit: number) {
		await this.ready();
		return this.work()
			.find({
				workspaceId: { $eq: w },
				assignedKind: { $eq: actor.kind },
				assignedId: { $eq: actor.id },
				"run.id": { $gt: after },
			})
			.sort({ "run.id": 1 })
			.limit(limit)
			.toArray();
	}
	async dueAssignments(field: AssignmentClock, now: number, limit: number) {
		await this.ready();
		return this.work()
			.find({ [field]: { $type: "number", $lte: now } })
			.sort({ [field]: 1 })
			.limit(limit)
			.toArray();
	}
	private sameRunRevision(row: RunRecord) {
		return {
			_id: { $eq: key(row.workspaceId, row.run.loopId, row.run.id) },
			workspaceId: { $eq: row.workspaceId },
			"run.revision": { $eq: row.run.revision },
		};
	}
	async deferAssignment(
		row: RunRecord,
		field: AssignmentClock,
		now: number,
		until: number,
	) {
		const result = await this.work().updateOne(
			{ ...this.sameRunRevision(row), [field]: { $type: "number", $lte: now } },
			{ $set: { [field]: until } },
		);
		return result.modifiedCount === 1;
	}
	async acknowledgeAssignment(row: RunRecord) {
		await this.work().updateOne(this.sameRunRevision(row), {
			$set: { wakeAt: null },
		});
	}
	async runs(w: string, id: string, limit: number) {
		await this.ready();
		return this.work()
			.find(
				{ workspaceId: { $eq: w }, "run.loopId": { $eq: id } },
				{ projection: { _id: 0 } },
			)
			.sort({ createdAt: -1, "run.id": -1 })
			.limit(limit)
			.toArray();
	}
	async waiting(w: string, id: string) {
		await this.ready();
		return this.work()
			.find(
				{ workspaceId: { $eq: w }, "run.loopId": { $eq: id }, waiting: true },
				{ projection: { _id: 0 } },
			)
			.toArray();
	}
	async active(w: string, id: string) {
		await this.ready();
		return this.work().countDocuments({
			workspaceId: { $eq: w },
			"run.loopId": { $eq: id },
			"run.status": "active",
		});
	}
}

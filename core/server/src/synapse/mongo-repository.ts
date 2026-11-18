import type {
	SynapseMaintenanceBatch,
	SynapseProposal,
	SynapseSpaceId,
} from "@autonomo.us/common";
import { type Document, MongoClient } from "mongodb";
import {
	MONGO_SELECTION_TIMEOUT_MS,
	mongoOperationDeadlines,
	SharedMongoClient,
} from "../mongo.js";
import { mongoFailureDetails, type SynapseDiagnostic } from "./diagnostics.js";
import { SynapseError, synapseUnavailable } from "./errors.js";
import type {
	FindOptions,
	InstantRange,
	MaintenanceLease,
	MaintenanceRecord,
	NoteFilter,
	NoteIndexEntry,
	ProposalClaim,
	ProposalDecision,
	ProposalFilter,
	SpaceRecord,
	SpaceStats,
	StoredNote,
	StoredRevision,
	SynapseRepository,
} from "./repository.js";
import { DAILY_DATE_PROPERTIES, escapeRegex } from "./repository.js";

export const SYNAPSE_NOTES_COLLECTION = "synapse_notes";
export const SYNAPSE_SPACES_COLLECTION = "synapse_spaces";
export const SYNAPSE_PROPOSALS_COLLECTION = "synapse_proposals";
export const SYNAPSE_REVISIONS_COLLECTION = "synapse_revisions";
export const SYNAPSE_MAINTENANCE_COLLECTION = "synapse_maintenance";

type NoteDocument = Omit<StoredNote, "id"> & { _id: string };
type SpaceDocument = Omit<SpaceRecord, "id"> & { _id: string };
type ProposalDocument = Omit<SynapseProposal, "id"> & {
	_id: string;
	/** Internal: an approval in progress. Never returned to callers. */
	claim?: ProposalClaim;
};
const proposalOf = ({ _id, claim, ...rest }: ProposalDocument) =>
	({ id: _id, ...rest }) as SynapseProposal;
type RevisionDocument = Omit<StoredRevision, "id"> & { _id: string };
/** One document per space, keyed by its storage key. */
type MaintenanceDocument = Omit<MaintenanceRecord, "space"> & {
	_id: string;
	/** Internal: a run in progress. Never returned to callers. */
	lease?: MaintenanceLease;
};
const maintenanceOf = ({
	_id,
	lease,
	...rest
}: MaintenanceDocument): MaintenanceRecord => ({
	space: _id as SynapseSpaceId,
	lastRunAt: rest.lastRunAt ?? null,
	batch: rest.batch ?? null,
	dismissed: rest.dismissed ?? [],
});
/** No unexpired claim holds the proposal. ISO timestamps compare as strings. */
const unclaimed = (now: string): Document => ({
	$or: [{ claim: { $exists: false } }, { "claim.until": { $lte: now } }],
});

const DUPLICATE_KEY = 11000;
/** Indexes are created once per process for each database. */
const indexed = new Map<string, Promise<void>>();

const INDEX_PROJECTION = {
	title: 1,
	titleKey: 1,
	space: 1,
	links: 1,
	linkKeys: 1,
	categories: 1,
	categoryKeys: 1,
	tags: 1,
	tagKeys: 1,
	aliasKeys: 1,
	createdAt: 1,
	updatedAt: 1,
	revision: 1,
};

function toNote({ _id, ...rest }: NoteDocument): StoredNote {
	return { id: _id, ...rest };
}

function toDocument<T extends { id: string }>(
	record: T,
): Omit<T, "id"> & { _id: string } {
	const { id, ...rest } = record;
	return { _id: id, ...rest };
}

function noteQuery(filter: NoteFilter): Document {
	const query: Document = { space: filter.space };
	const and: Document[] = [];
	if (filter.titleKey !== undefined) query.titleKey = filter.titleKey;
	if (filter.titleKeys !== undefined)
		and.push({ titleKey: { $in: filter.titleKeys } });
	if (filter.excludeTitleKeys?.length)
		and.push({ titleKey: { $nin: filter.excludeTitleKeys } });
	if (filter.linkKey !== undefined) and.push({ linkKeys: filter.linkKey });
	if (filter.linkKeys !== undefined)
		and.push({ linkKeys: { $in: filter.linkKeys } });
	if (filter.categoryKey !== undefined) query.categoryKeys = filter.categoryKey;
	if (filter.tagPrefix !== undefined)
		query.tagKeys = {
			$in: [filter.tagPrefix, new RegExp(`^${escapeRegex(filter.tagPrefix)}/`)],
		};
	for (const term of filter.terms ?? [])
		and.push({ searchText: { $regex: escapeRegex(term) } });
	if (filter.anyTerms?.length)
		and.push({
			searchText: { $regex: filter.anyTerms.map(escapeRegex).join("|") },
		});
	for (const entry of filter.where ?? [])
		and.push({ propertyKeys: { $elemMatch: { k: entry.k, v: entry.v } } });
	if (and.length) query.$and = and;
	return query;
}

function sortSpec(sort: FindOptions["sort"]): Document {
	const direction = sort.direction === "asc" ? 1 : -1;
	return { [sort.by]: direction, _id: direction };
}

/** Notes, space records, and proposals in MongoDB; see docs/SYNAPSE.md §11. */
export class MongoSynapseRepository implements SynapseRepository {
	readonly persistence = "mongodb" as const;
	private readonly mongo: SharedMongoClient;
	constructor(
		private readonly mongodbUrl: string,
		private readonly diagnostic?: (details: SynapseDiagnostic) => void,
		selectionTimeoutMs = MONGO_SELECTION_TIMEOUT_MS,
	) {
		this.mongo = new SharedMongoClient(
			() =>
				new MongoClient(mongodbUrl, {
					serverSelectionTimeoutMS: selectionTimeoutMs,
					...mongoOperationDeadlines(5000),
					readPreference: "primary",
				}),
		);
	}

	private database() {
		return this.mongo.current().db();
	}
	private notes() {
		return this.database().collection<NoteDocument>(SYNAPSE_NOTES_COLLECTION);
	}
	private spaces() {
		return this.database().collection<SpaceDocument>(SYNAPSE_SPACES_COLLECTION);
	}
	private proposals() {
		return this.database().collection<ProposalDocument>(
			SYNAPSE_PROPOSALS_COLLECTION,
		);
	}
	private revisions() {
		return this.database().collection<RevisionDocument>(
			SYNAPSE_REVISIONS_COLLECTION,
		);
	}
	private maintenance() {
		return this.database().collection<MaintenanceDocument>(
			SYNAPSE_MAINTENANCE_COLLECTION,
		);
	}
	private async createIndexes() {
		await this.diagnose("initialize", "connect", () =>
			this.database().command({ ping: 1 }),
		);
		await this.diagnose("initialize", "indexes.notes", () =>
			this.notes().createIndexes([
				{ key: { space: 1, titleKey: 1 }, unique: true, name: "space_title" },
				{ key: { space: 1, linkKeys: 1 }, name: "space_links" },
				{ key: { space: 1, categoryKeys: 1 }, name: "space_categories" },
				{ key: { space: 1, tagKeys: 1 }, name: "space_tags" },
				{ key: { space: 1, updatedAt: -1 }, name: "space_updated" },
			]),
		);
		await this.diagnose("initialize", "indexes.proposals", () =>
			this.proposals().createIndexes([
				{
					key: { "author.id": 1, status: 1, createdAt: -1 },
					name: "author_status",
				},
				// Each workspace lists the proposals for its own shared space.
				{ key: { space: 1, status: 1, createdAt: -1 }, name: "space_status" },
				{ key: { space: 1, decidedAt: -1 }, name: "space_decided" },
			]),
		);
		await this.diagnose("initialize", "indexes.revisions", () =>
			this.revisions().createIndexes([
				{ key: { noteId: 1, revision: -1 }, name: "note_revision" },
				// A deleted note's history is found by the title it had.
				{ key: { space: 1, titleKey: 1, at: -1 }, name: "space_title_at" },
				{ key: { space: 1, at: -1 }, name: "space_at" },
			]),
		);
	}
	/** Runs `operation` once the indexes exist; driver failures become 503s. */
	private async storage<T>(
		name: keyof SynapseRepository | "check",
		operation: () => Promise<T>,
	): Promise<T> {
		try {
			let ready = indexed.get(this.mongodbUrl);
			if (!ready) {
				ready = this.createIndexes();
				indexed.set(this.mongodbUrl, ready);
				ready.catch(() => indexed.delete(this.mongodbUrl));
			}
			await ready;
			return await this.diagnose(name, "operation", operation);
		} catch (error) {
			if (error instanceof SynapseError) throw error;
			throw synapseUnavailable(error);
		}
	}

	private async diagnose<T>(
		operation: string,
		stage: SynapseDiagnostic["stage"],
		action: () => Promise<T>,
	): Promise<T> {
		const started = performance.now();
		try {
			const result = await action();
			if (stage === "connect" || stage.startsWith("indexes."))
				this.emit({
					event: "synapse.storage_ready",
					operation,
					stage,
					durationMs: Math.round(performance.now() - started),
				});
			return result;
		} catch (error) {
			if (error instanceof SynapseError) throw error;
			this.emit({
				event: "synapse.storage_failed",
				operation,
				stage,
				durationMs: Math.round(performance.now() - started),
				...mongoFailureDetails(error),
			});
			throw synapseUnavailable(error);
		}
	}
	private emit(details: SynapseDiagnostic) {
		// Logging must never turn a committed write into an application failure.
		try {
			this.diagnostic?.(details);
		} catch {
			/* Diagnostic sinks are best effort. */
		}
	}
	/** Exercise initialization and bounded reads on all three collections, without note contents. */
	async check(): Promise<void> {
		await this.storage("check", async () => {
			// Settle every read before a Worker releases its request-scoped clients.
			const checks = [
				["read.notes", () => this.notes()],
				["read.spaces", () => this.spaces()],
				["read.proposals", () => this.proposals()],
			] as const;
			const results = await Promise.allSettled(
				checks.map(([stage, collection]) =>
					this.diagnose("check", stage, () =>
						collection().findOne(
							{},
							{ projection: { _id: 1 }, maxTimeMS: 3000 },
						),
					),
				),
			);
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		});
	}

	async getNote(space: SynapseSpaceId, titleKey: string) {
		const found = await this.storage("getNote", () =>
			this.notes().findOne({ space, titleKey }),
		);
		return found ? toNote(found) : null;
	}
	async findNotes(filter: NoteFilter, options: FindOptions) {
		const found = await this.storage("findNotes", () =>
			this.notes()
				.find(noteQuery(filter))
				.sort(sortSpec(options.sort))
				.skip(options.offset ?? 0)
				.limit(options.limit)
				.toArray(),
		);
		return found.map(toNote);
	}
	async countNotes(filter: NoteFilter) {
		return this.storage("countNotes", () =>
			this.notes().countDocuments(noteQuery(filter)),
		);
	}
	async scanNotes(space: SynapseSpaceId) {
		const found = await this.storage("scanNotes", () =>
			this.notes().find({ space }, { projection: INDEX_PROJECTION }).toArray(),
		);
		return found.map((document) => toNote(document) as NoteIndexEntry);
	}
	async findDailyNotes(
		space: SynapseSpaceId,
		date: string,
		range: InstantRange,
		limit: number,
	) {
		const dateKey = date.toLowerCase();
		const prefix = new RegExp(`^${escapeRegex(dateKey)}`);
		const found = await this.storage("findDailyNotes", () =>
			this.notes()
				.find({
					space,
					titleKey: { $ne: dateKey },
					$or: [
						{ titleKey: prefix },
						{ createdAt: { $gte: range.from, $lt: range.to } },
						{
							propertyKeys: {
								$elemMatch: { k: { $in: DAILY_DATE_PROPERTIES }, v: prefix },
							},
						},
						{ linkKeys: dateKey },
					],
				})
				.sort({ createdAt: -1, _id: -1 })
				.limit(limit)
				.toArray(),
		);
		return found.map(toNote);
	}
	async insertNote(note: StoredNote) {
		return this.storage("insertNote", async () => {
			try {
				await this.notes().insertOne(toDocument(note));
				return true;
			} catch (error) {
				if ((error as { code?: unknown }).code === DUPLICATE_KEY) return false;
				throw error;
			}
		});
	}
	async replaceNote(note: StoredNote, expectedRevision: number) {
		return this.storage("replaceNote", async () => {
			try {
				const result = await this.notes().replaceOne(
					{ _id: note.id, revision: expectedRevision },
					toDocument(note),
				);
				return result.matchedCount > 0;
			} catch (error) {
				// A rename onto a title another note claimed meanwhile.
				if ((error as { code?: unknown }).code === DUPLICATE_KEY) return false;
				throw error;
			}
		});
	}
	async deleteNote(id: string, expectedRevision?: number) {
		const result = await this.storage("deleteNote", () =>
			this.notes().deleteOne({
				_id: id,
				...(expectedRevision === undefined
					? {}
					: { revision: expectedRevision }),
			}),
		);
		return result.deletedCount > 0;
	}
	async spaceStats() {
		const groups = await this.storage("spaceStats", () =>
			this.notes()
				.aggregate<{
					_id: SynapseSpaceId;
					noteCount: number;
					createdAt: string;
					updatedAt: string;
				}>([
					{
						$group: {
							_id: "$space",
							noteCount: { $sum: 1 },
							createdAt: { $min: "$createdAt" },
							updatedAt: { $max: "$updatedAt" },
						},
					},
				])
				.toArray(),
		);
		return groups.map(
			({ _id, ...rest }): SpaceStats => ({ space: _id, ...rest }),
		);
	}
	async listSpaceRecords() {
		const found = await this.storage("listSpaceRecords", () =>
			this.spaces().find().toArray(),
		);
		return found.map(
			({ _id, ...rest }): SpaceRecord => ({
				id: _id as SynapseSpaceId,
				...rest,
			}),
		);
	}
	async upsertSpaceRecord(
		id: SynapseSpaceId,
		at: string,
		name: string | undefined,
		fallbackName: string,
	) {
		await this.storage("upsertSpaceRecord", () =>
			this.spaces().updateOne(
				{ _id: id },
				{
					$set: { updatedAt: at, ...(name === undefined ? {} : { name }) },
					$setOnInsert: {
						createdAt: at,
						...(name === undefined ? { name: fallbackName } : {}),
					},
				},
				{ upsert: true },
			),
		);
	}
	async insertProposal(proposal: SynapseProposal) {
		await this.storage("insertProposal", () =>
			this.proposals().insertOne(toDocument(proposal)),
		);
	}
	async getProposal(id: string) {
		const found = await this.storage("getProposal", () =>
			this.proposals().findOne({ _id: id }),
		);
		return found ? proposalOf(found) : null;
	}
	private proposalQuery(filter: ProposalFilter): Document {
		return {
			...(filter.space === undefined ? {} : { space: filter.space }),
			...(filter.authorId === undefined
				? {}
				: { "author.id": filter.authorId }),
			...(filter.status === undefined ? {} : { status: filter.status }),
		};
	}
	async listProposals(filter: ProposalFilter) {
		const found = await this.storage("listProposals", () =>
			this.proposals()
				.find(this.proposalQuery(filter))
				.sort({ createdAt: -1, _id: -1 })
				.toArray(),
		);
		return found.map(proposalOf);
	}
	async recentDecisions(space: SynapseSpaceId, limit: number) {
		const found = await this.storage("recentDecisions", () =>
			this.proposals()
				.find({ space, status: { $in: ["approved", "rejected"] } })
				.sort({ decidedAt: -1, _id: -1 })
				.limit(limit)
				.toArray(),
		);
		return found.map(proposalOf);
	}
	async countProposals(filter: ProposalFilter) {
		return this.storage("countProposals", () =>
			this.proposals().countDocuments(this.proposalQuery(filter)),
		);
	}
	async claimProposal(id: string, claim: ProposalClaim, now: string) {
		const result = await this.storage("claimProposal", () =>
			this.proposals().updateOne(
				{ _id: id, status: "pending", ...unclaimed(now) },
				{ $set: { claim } },
			),
		);
		return result.matchedCount > 0;
	}
	async decideProposal(
		id: string,
		decision: ProposalDecision,
		guard: { now: string; claimId?: string },
	) {
		const result = await this.storage("decideProposal", () =>
			this.proposals().updateOne(
				{
					_id: id,
					status: "pending",
					...(guard.claimId === undefined
						? unclaimed(guard.now)
						: { "claim.id": guard.claimId }),
				},
				{ $set: decision, $unset: { claim: "" } },
			),
		);
		return result.matchedCount > 0;
	}
	async releaseProposalClaim(id: string, claimId: string) {
		const result = await this.storage("releaseProposalClaim", () =>
			this.proposals().updateOne(
				{ _id: id, "claim.id": claimId },
				{ $unset: { claim: "" } },
			),
		);
		return result.matchedCount > 0;
	}
	async insertRevision(revision: StoredRevision) {
		await this.storage("insertRevision", async () => {
			try {
				await this.revisions().insertOne(toDocument(revision));
			} catch (error) {
				// The same state recorded twice is one record.
				if ((error as { code?: unknown }).code !== DUPLICATE_KEY) throw error;
			}
		});
	}
	async listRevisions(
		space: SynapseSpaceId,
		note: { noteId: string } | { titleKey: string },
		limit: number,
	) {
		const found = await this.storage("listRevisions", async () => {
			// A title may have named several notes over time: the latest one's history.
			const noteId =
				"noteId" in note
					? note.noteId
					: (
							await this.revisions().findOne(
								{ space, titleKey: note.titleKey },
								{
									sort: { at: -1, revision: -1, _id: -1 },
									projection: { noteId: 1 },
								},
							)
						)?.noteId;
			if (noteId === undefined) return [];
			return this.revisions()
				.find({ space, noteId })
				.sort({ at: -1, revision: -1, _id: -1 })
				.limit(limit)
				.toArray();
		});
		return found.map(
			({ _id, ...rest }): StoredRevision => ({ id: _id, ...rest }),
		);
	}
	async getRevision(noteId: string, revision: number) {
		const found = await this.storage("getRevision", () =>
			this.revisions().findOne({ noteId, revision }),
		);
		if (!found) return null;
		const { _id, ...rest } = found;
		return { id: _id, ...rest };
	}
	async pruneRevisions(noteId: string, revision: number) {
		await this.storage("pruneRevisions", () =>
			this.revisions().deleteMany({ noteId, revision: { $lte: revision } }),
		);
	}
	async revisionsSince(space: SynapseSpaceId, since: string, limit: number) {
		const found = await this.storage("revisionsSince", () =>
			this.revisions()
				.find({ space, at: { $gt: since } })
				.sort({ at: -1, revision: -1, _id: -1 })
				.limit(limit)
				.toArray(),
		);
		return found.map(
			({ _id, ...rest }): StoredRevision => ({ id: _id, ...rest }),
		);
	}
	async getMaintenance(space: SynapseSpaceId) {
		const found = await this.storage("getMaintenance", () =>
			this.maintenance().findOne({ _id: space }),
		);
		return found ? maintenanceOf(found) : null;
	}
	async listMaintenanceRuns() {
		const found = await this.storage("listMaintenanceRuns", () =>
			this.maintenance()
				.find({}, { projection: { lastRunAt: 1 } })
				.toArray(),
		);
		return found.map((document) => ({
			space: document._id as SynapseSpaceId,
			lastRunAt: document.lastRunAt ?? null,
		}));
	}
	async claimMaintenance(
		space: SynapseSpaceId,
		lease: MaintenanceLease,
		now: string,
		dueBefore: string,
	) {
		return this.storage("claimMaintenance", async () => {
			try {
				// A space with no record yet is created by the claim. One whose
				// record does not match is held or not due: the upsert then
				// collides with it and the claim fails.
				const result = await this.maintenance().updateOne(
					{
						_id: space,
						$and: [
							{
								$or: [
									{ lease: { $exists: false } },
									{ "lease.until": { $lte: now } },
								],
							},
							{
								$or: [{ lastRunAt: null }, { lastRunAt: { $lt: dueBefore } }],
							},
						],
					},
					{
						$set: { lease },
						$setOnInsert: { lastRunAt: null, batch: null, dismissed: [] },
					},
					{ upsert: true },
				);
				return result.matchedCount > 0 || result.upsertedCount > 0;
			} catch (error) {
				if ((error as { code?: unknown }).code === DUPLICATE_KEY) return false;
				throw error;
			}
		});
	}
	async finishMaintenance(
		space: SynapseSpaceId,
		leaseId: string,
		batch: SynapseMaintenanceBatch,
		at: string,
	) {
		const result = await this.storage("finishMaintenance", () =>
			this.maintenance().updateOne(
				{ _id: space, "lease.id": leaseId },
				{ $set: { batch, lastRunAt: at }, $unset: { lease: "" } },
			),
		);
		return result.matchedCount > 0;
	}
	async releaseMaintenance(space: SynapseSpaceId, leaseId: string) {
		await this.storage("releaseMaintenance", () =>
			this.maintenance().updateOne(
				{ _id: space, "lease.id": leaseId },
				{ $unset: { lease: "" } },
			),
		);
	}
	async reviewMaintenance(
		space: SynapseSpaceId,
		batch: SynapseMaintenanceBatch,
		expectedRevision: number,
		dismissed: string[],
	) {
		const result = await this.storage("reviewMaintenance", () =>
			this.maintenance().updateOne(
				{
					_id: space,
					"batch.id": batch.id,
					"batch.revision": expectedRevision,
				},
				{
					$set: { batch },
					...(dismissed.length
						? { $addToSet: { dismissed: { $each: dismissed } } }
						: {}),
				},
			),
		);
		return result.matchedCount > 0;
	}
	async close() {
		await this.mongo.close();
	}
}

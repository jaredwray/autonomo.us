import type { SynapseProposal, SynapseSpaceId } from "@autonomo.us/common";
import { type Document, MongoClient } from "mongodb";
import { mongoOperationDeadlines, requestMongoClient } from "../mongo.js";
import { SynapseError, synapseUnavailable } from "./errors.js";
import type {
	FindOptions,
	InstantRange,
	NoteFilter,
	NoteIndexEntry,
	ProposalClaim,
	ProposalDecision,
	ProposalFilter,
	SpaceRecord,
	SpaceStats,
	StoredNote,
	SynapseRepository,
} from "./repository.js";
import { DAILY_DATE_PROPERTIES, escapeRegex } from "./repository.js";

export const SYNAPSE_NOTES_COLLECTION = "synapse_notes";
export const SYNAPSE_SPACES_COLLECTION = "synapse_spaces";
export const SYNAPSE_PROPOSALS_COLLECTION = "synapse_proposals";

type NoteDocument = Omit<StoredNote, "id"> & { _id: string };
type SpaceDocument = Omit<SpaceRecord, "id"> & { _id: string };
type ProposalDocument = Omit<SynapseProposal, "id"> & {
	_id: string;
	/** Internal: an approval in progress. Never returned to callers. */
	claim?: ProposalClaim;
};
const proposalOf = ({ _id, claim, ...rest }: ProposalDocument) =>
	({ id: _id, ...rest }) as SynapseProposal;
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
	private client?: MongoClient;
	constructor(private readonly mongodbUrl: string) {}

	private database() {
		const create = () =>
			new MongoClient(this.mongodbUrl, {
				serverSelectionTimeoutMS: 1500,
				...mongoOperationDeadlines(5000),
				readPreference: "primary",
			});
		let client = requestMongoClient(this, create);
		if (!client) {
			this.client ??= create();
			client = this.client;
		}
		return client.db();
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
	private async createIndexes() {
		const notes = this.notes();
		await notes.createIndexes([
			{ key: { space: 1, titleKey: 1 }, unique: true, name: "space_title" },
			{ key: { space: 1, linkKeys: 1 }, name: "space_links" },
			{ key: { space: 1, categoryKeys: 1 }, name: "space_categories" },
			{ key: { space: 1, tagKeys: 1 }, name: "space_tags" },
			{ key: { space: 1, updatedAt: -1 }, name: "space_updated" },
		]);
		await this.proposals().createIndexes([
			{
				key: { "author.id": 1, status: 1, createdAt: -1 },
				name: "author_status",
			},
		]);
	}
	/** Runs `operation` once the indexes exist; driver failures become 503s. */
	private async storage<T>(operation: () => Promise<T>): Promise<T> {
		try {
			let ready = indexed.get(this.mongodbUrl);
			if (!ready) {
				ready = this.createIndexes();
				indexed.set(this.mongodbUrl, ready);
				ready.catch(() => indexed.delete(this.mongodbUrl));
			}
			await ready;
			return await operation();
		} catch (error) {
			if (error instanceof SynapseError) throw error;
			throw synapseUnavailable(error);
		}
	}

	async getNote(space: SynapseSpaceId, titleKey: string) {
		const found = await this.storage(() =>
			this.notes().findOne({ space, titleKey }),
		);
		return found ? toNote(found) : null;
	}
	async findNotes(filter: NoteFilter, options: FindOptions) {
		const found = await this.storage(() =>
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
		return this.storage(() => this.notes().countDocuments(noteQuery(filter)));
	}
	async scanNotes(space: SynapseSpaceId) {
		const found = await this.storage(() =>
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
		const found = await this.storage(() =>
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
		return this.storage(async () => {
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
		return this.storage(async () => {
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
		const result = await this.storage(() =>
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
		const groups = await this.storage(() =>
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
		const found = await this.storage(() => this.spaces().find().toArray());
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
		await this.storage(() =>
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
		await this.storage(() => this.proposals().insertOne(toDocument(proposal)));
	}
	async getProposal(id: string) {
		const found = await this.storage(() =>
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
		const found = await this.storage(() =>
			this.proposals()
				.find(this.proposalQuery(filter))
				.sort({ createdAt: -1, _id: -1 })
				.toArray(),
		);
		return found.map(proposalOf);
	}
	async countProposals(filter: ProposalFilter) {
		return this.storage(() =>
			this.proposals().countDocuments(this.proposalQuery(filter)),
		);
	}
	async claimProposal(id: string, claim: ProposalClaim, now: string) {
		const result = await this.storage(() =>
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
		const result = await this.storage(() =>
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
		const result = await this.storage(() =>
			this.proposals().updateOne(
				{ _id: id, "claim.id": claimId },
				{ $unset: { claim: "" } },
			),
		);
		return result.matchedCount > 0;
	}
	async close() {
		const client = this.client;
		this.client = undefined;
		await client?.close();
	}
}

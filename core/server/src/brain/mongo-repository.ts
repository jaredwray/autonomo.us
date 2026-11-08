import type { BrainProposal, BrainVaultId } from "@autonomo.us/common";
import { type Document, MongoClient } from "mongodb";
import { mongoOperationDeadlines, requestMongoClient } from "../mongo.js";
import { BrainError, brainUnavailable } from "./errors.js";
import type {
	BrainRepository,
	FindOptions,
	InstantRange,
	NoteFilter,
	NoteIndexEntry,
	ProposalDecision,
	ProposalFilter,
	StoredNote,
	VaultRecord,
	VaultStats,
} from "./repository.js";
import { DAILY_DATE_PROPERTIES, escapeRegex } from "./repository.js";

export const BRAIN_NOTES_COLLECTION = "brain_notes";
export const BRAIN_VAULTS_COLLECTION = "brain_vaults";
export const BRAIN_PROPOSALS_COLLECTION = "brain_proposals";

type NoteDocument = Omit<StoredNote, "id"> & { _id: string };
type VaultDocument = Omit<VaultRecord, "id"> & { _id: string };
type ProposalDocument = Omit<BrainProposal, "id"> & { _id: string };

const DUPLICATE_KEY = 11000;
/** Indexes are created once per process for each database. */
const indexed = new Map<string, Promise<void>>();

const INDEX_PROJECTION = {
	title: 1,
	titleKey: 1,
	vault: 1,
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
	const query: Document = { vault: filter.vault };
	const and: Document[] = [];
	if (filter.titleKey !== undefined) query.titleKey = filter.titleKey;
	if (filter.titleKeys !== undefined)
		and.push({ titleKey: { $in: filter.titleKeys } });
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

/** Notes, vault records, and proposals in MongoDB; see docs/BRAIN.md §11. */
export class MongoBrainRepository implements BrainRepository {
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
		return this.database().collection<NoteDocument>(BRAIN_NOTES_COLLECTION);
	}
	private vaults() {
		return this.database().collection<VaultDocument>(BRAIN_VAULTS_COLLECTION);
	}
	private proposals() {
		return this.database().collection<ProposalDocument>(
			BRAIN_PROPOSALS_COLLECTION,
		);
	}
	private async createIndexes() {
		const notes = this.notes();
		await notes.createIndexes([
			{ key: { vault: 1, titleKey: 1 }, unique: true, name: "vault_title" },
			{ key: { vault: 1, linkKeys: 1 }, name: "vault_links" },
			{ key: { vault: 1, categoryKeys: 1 }, name: "vault_categories" },
			{ key: { vault: 1, tagKeys: 1 }, name: "vault_tags" },
			{ key: { vault: 1, updatedAt: -1 }, name: "vault_updated" },
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
			if (error instanceof BrainError) throw error;
			throw brainUnavailable(error);
		}
	}

	async getNote(vault: BrainVaultId, titleKey: string) {
		const found = await this.storage(() =>
			this.notes().findOne({ vault, titleKey }),
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
	async scanNotes(vault: BrainVaultId) {
		const found = await this.storage(() =>
			this.notes().find({ vault }, { projection: INDEX_PROJECTION }).toArray(),
		);
		return found.map((document) => toNote(document) as NoteIndexEntry);
	}
	async findDailyNotes(
		vault: BrainVaultId,
		date: string,
		range: InstantRange,
		limit: number,
	) {
		const dateKey = date.toLowerCase();
		const prefix = new RegExp(`^${escapeRegex(dateKey)}`);
		const found = await this.storage(() =>
			this.notes()
				.find({
					vault,
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
	async vaultStats() {
		const groups = await this.storage(() =>
			this.notes()
				.aggregate<{
					_id: BrainVaultId;
					noteCount: number;
					createdAt: string;
					updatedAt: string;
				}>([
					{
						$group: {
							_id: "$vault",
							noteCount: { $sum: 1 },
							createdAt: { $min: "$createdAt" },
							updatedAt: { $max: "$updatedAt" },
						},
					},
				])
				.toArray(),
		);
		return groups.map(
			({ _id, ...rest }): VaultStats => ({ vault: _id, ...rest }),
		);
	}
	async listVaultRecords() {
		const found = await this.storage(() => this.vaults().find().toArray());
		return found.map(
			({ _id, ...rest }): VaultRecord => ({ id: _id as BrainVaultId, ...rest }),
		);
	}
	async upsertVaultRecord(
		id: BrainVaultId,
		at: string,
		name: string | undefined,
		fallbackName: string,
	) {
		await this.storage(() =>
			this.vaults().updateOne(
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
	async insertProposal(proposal: BrainProposal) {
		await this.storage(() => this.proposals().insertOne(toDocument(proposal)));
	}
	async getProposal(id: string) {
		const found = await this.storage(() =>
			this.proposals().findOne({ _id: id }),
		);
		if (!found) return null;
		const { _id, ...rest } = found;
		return { id: _id, ...rest } as BrainProposal;
	}
	private proposalQuery(filter: ProposalFilter): Document {
		return {
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
		return found.map(
			({ _id, ...rest }) => ({ id: _id, ...rest }) as BrainProposal,
		);
	}
	async countProposals(filter: ProposalFilter) {
		return this.storage(() =>
			this.proposals().countDocuments(this.proposalQuery(filter)),
		);
	}
	async decideProposal(id: string, decision: ProposalDecision) {
		const result = await this.storage(() =>
			this.proposals().updateOne(
				{ _id: id, status: "pending" },
				{ $set: decision },
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

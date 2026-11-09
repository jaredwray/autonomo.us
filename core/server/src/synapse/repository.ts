import type {
	SynapseNote,
	SynapseProposal,
	SynapseProposalStatus,
	SynapseSpaceId,
} from "@autonomo.us/common";

/** A note plus the lowercased keys queries run on. */
export type StoredNote = SynapseNote & {
	titleKey: string;
	linkKeys: string[];
	categoryKeys: string[];
	tagKeys: string[];
	/** Lowercased title, body, and property values. */
	searchText: string;
	/** One entry per scalar property value or list item, normalized for `where`. */
	propertyKeys: PropertyIndexEntry[];
};

export type PropertyIndexEntry = { k: string; v: string };

/** The fields graph computations need, without bodies. */
export type NoteIndexEntry = Pick<
	StoredNote,
	| "id"
	| "space"
	| "title"
	| "titleKey"
	| "links"
	| "linkKeys"
	| "categories"
	| "categoryKeys"
	| "tags"
	| "tagKeys"
	| "createdAt"
	| "updatedAt"
	| "revision"
>;

/** All given filters must match. Keys are lowercased by the caller. */
export type NoteFilter = {
	space: SynapseSpaceId;
	titleKey?: string;
	titleKeys?: string[];
	/** Notes linking to this title. */
	linkKey?: string;
	/** Notes linking to any of these titles. */
	linkKeys?: string[];
	categoryKey?: string;
	/** `tag` or anything below it (`tag/...`). */
	tagPrefix?: string;
	/** Lowercased terms that must all appear in `searchText`. */
	terms?: string[];
	where?: PropertyIndexEntry[];
};

export type NoteSort = {
	by: "updatedAt" | "createdAt" | "titleKey";
	direction: "asc" | "desc";
};

export type FindOptions = { sort: NoteSort; limit: number; offset?: number };

/** A UTC instant range, start inclusive, end exclusive. */
export type InstantRange = { from: string; to: string };

export type SpaceRecord = {
	id: SynapseSpaceId;
	name: string;
	createdAt: string;
	updatedAt: string;
};

export type SpaceStats = {
	space: SynapseSpaceId;
	noteCount: number;
	createdAt: string;
	updatedAt: string;
};

export type ProposalFilter = {
	authorId?: string;
	status?: SynapseProposalStatus;
};
/** A time-limited reservation of a pending proposal while its approval applies. */
export type ProposalClaim = { id: string; until: string };
export type ProposalDecision = Required<
	Pick<SynapseProposal, "status" | "decidedAt" | "decidedBy">
> &
	Pick<SynapseProposal, "decisionReason">;

/**
 * Storage for notes, space records, and proposals. The memory and MongoDB
 * implementations satisfy the same contract (test/synapse-repository.test.ts).
 */
export interface SynapseRepository {
	readonly persistence: "mongodb" | "memory";
	getNote(space: SynapseSpaceId, titleKey: string): Promise<StoredNote | null>;
	findNotes(filter: NoteFilter, options: FindOptions): Promise<StoredNote[]>;
	countNotes(filter: NoteFilter): Promise<number>;
	/** Every note of the space without bodies, for link and category graphs. */
	scanNotes(space: SynapseSpaceId): Promise<NoteIndexEntry[]>;
	/**
	 * Notes for a daily view: titled with a `date` prefix (other than exactly
	 * `date`), created within `range`, with a `created`, `date`, `start`, `end`,
	 * or `published` property starting with `date`, or linking to `date`.
	 */
	findDailyNotes(
		space: SynapseSpaceId,
		date: string,
		range: InstantRange,
		limit: number,
	): Promise<StoredNote[]>;
	/** False when the space already has a note with that title key. */
	insertNote(note: StoredNote): Promise<boolean>;
	/** Compare-and-set on the stored revision. */
	replaceNote(note: StoredNote, expectedRevision: number): Promise<boolean>;
	deleteNote(id: string, expectedRevision?: number): Promise<boolean>;
	spaceStats(): Promise<SpaceStats[]>;
	listSpaceRecords(): Promise<SpaceRecord[]>;
	/** Creates or touches a space record; `name` is set only when given. */
	upsertSpaceRecord(
		id: SynapseSpaceId,
		at: string,
		name: string | undefined,
		fallbackName: string,
	): Promise<void>;
	insertProposal(proposal: SynapseProposal): Promise<void>;
	getProposal(id: string): Promise<SynapseProposal | null>;
	/** Newest first. */
	listProposals(filter: ProposalFilter): Promise<SynapseProposal[]>;
	countProposals(filter: ProposalFilter): Promise<number>;
	/** Records a decision only while the proposal is still pending. */
	/** Reserves a pending proposal for approval; fails while another unexpired claim holds it. */
	claimProposal(
		id: string,
		claim: ProposalClaim,
		now: string,
	): Promise<boolean>;
	/**
	 * Decides a pending proposal and drops its claim. With `claimId`, only that
	 * claim's holder may decide; without it, an unexpired claim blocks the decision.
	 */
	decideProposal(
		id: string,
		decision: ProposalDecision,
		guard: { now: string; claimId?: string },
	): Promise<boolean>;
	/** Drops a claim whose approval failed, so the proposal can be decided at once. */
	releaseProposalClaim(id: string, claimId: string): Promise<boolean>;
	close(): Promise<void>;
}

export function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `where` form of a property value: lowercased, with [[ ]] stripped. */
export function propertyKeyValue(value: string | number | boolean): string {
	if (typeof value !== "string") return String(value);
	return value
		.trim()
		.replace(/^\[\[(.*)\]\]$/s, "$1")
		.trim()
		.toLowerCase();
}

export const DAILY_DATE_PROPERTIES = [
	"created",
	"date",
	"start",
	"end",
	"published",
];

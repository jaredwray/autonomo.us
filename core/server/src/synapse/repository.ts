import type {
	SynapseActor,
	SynapseFlag,
	SynapseFlagStatus,
	SynapseMaintenanceBatch,
	SynapseNote,
	SynapseProperties,
	SynapseProposal,
	SynapseProposalStatus,
	SynapseRevisionChange,
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
	/**
	 * Lowercased values of the `aliases` property: other names the note goes
	 * by. Absent on notes written before aliases were indexed.
	 */
	aliasKeys?: string[];
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
	| "aliasKeys"
	| "createdAt"
	| "updatedAt"
	| "revision"
>;

/** All given filters must match. Keys are lowercased by the caller. */
export type NoteFilter = {
	space: SynapseSpaceId;
	titleKey?: string;
	titleKeys?: string[];
	/** Notes whose title is none of these, e.g. global notes a workspace overrides. */
	excludeTitleKeys?: string[];
	/** Notes linking to this title. */
	linkKey?: string;
	/** Notes linking to any of these titles. */
	linkKeys?: string[];
	categoryKey?: string;
	/** `tag` or anything below it (`tag/...`). */
	tagPrefix?: string;
	/** Lowercased terms that must all appear in `searchText`. */
	terms?: string[];
	/** Lowercased terms of which at least one appears in `searchText`. */
	anyTerms?: string[];
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
	/** The shared space a proposal targets: one per workspace. */
	space?: SynapseSpaceId;
	authorId?: string;
	status?: SynapseProposalStatus;
};
/** A time-limited reservation of a pending proposal while its approval applies. */
export type ProposalClaim = { id: string; until: string };
export type ProposalDecision = Required<
	Pick<SynapseProposal, "status" | "decidedAt" | "decidedBy">
> &
	Pick<SynapseProposal, "decisionReason">;

export type FlagFilter = {
	/** The shared space a flag is about: one per workspace. */
	space?: SynapseSpaceId;
	authorId?: string;
	status?: SynapseFlagStatus;
	/** The proposal that answers it. */
	proposalId?: string;
};
/** A flag's place in the newest-first order. */
export type FlagCursor = Pick<SynapseFlag, "createdAt" | "id">;
/**
 * Where a flag stands: its status and what belongs to it. Setting a state
 * replaces the whole of it, so a reopened flag keeps no proposal or resolution.
 */
export type FlagState = Pick<
	SynapseFlag,
	"status" | "proposalId" | "resolvedAt" | "resolvedBy" | "resolution"
>;
export const FLAG_STATE_FIELDS = [
	"status",
	"proposalId",
	"resolvedAt",
	"resolvedBy",
	"resolution",
] as const satisfies readonly (keyof FlagState)[];

/** A past state of a note. A `deleted` revision holds what was deleted. */
export type StoredRevision = {
	/** `<note id>:<revision>`, so recording the same state twice is one record. */
	id: string;
	noteId: string;
	space: SynapseSpaceId;
	title: string;
	titleKey: string;
	revision: number;
	change: SynapseRevisionChange;
	at: string;
	by: SynapseActor;
	properties: SynapseProperties;
	body: string;
};

export const revisionId = (noteId: string, revision: number) =>
	`${noteId}:${revision}`;

/** A time-limited hold on a space's maintenance run. */
export type MaintenanceLease = { id: string; until: string };

/** A space's maintenance: its latest batch and what reviewers dismissed for good. */
export type MaintenanceRecord = {
	space: SynapseSpaceId;
	/** When the last run finished, or null before the first. */
	lastRunAt: string | null;
	batch: SynapseMaintenanceBatch | null;
	/** Keys of findings a reviewer dismissed; later runs leave them out. */
	dismissed: string[];
};

/**
 * Storage for notes, space records, proposals, and flags. The memory and MongoDB
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
	/** A shared space's latest decided proposals, most recently decided first. */
	recentDecisions(
		space: SynapseSpaceId,
		limit: number,
	): Promise<SynapseProposal[]>;
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
	insertFlag(flag: SynapseFlag): Promise<void>;
	getFlag(id: string): Promise<SynapseFlag | null>;
	/**
	 * Newest first. With `before`, only the flags older than that one in
	 * this order, wherever it stands now: a place to read on from that does
	 * not move when flags are filed or settled meanwhile.
	 */
	listFlags(
		filter: FlagFilter,
		limit: number,
		before?: FlagCursor,
	): Promise<SynapseFlag[]>;
	countFlags(filter: FlagFilter): Promise<number>;
	/**
	 * Moves a flag to `state`, only while its status is one of `from`. With
	 * `proposalId`, only while that proposal is the one answering it.
	 */
	setFlagState(
		id: string,
		from: { status: readonly SynapseFlagStatus[]; proposalId?: string },
		state: FlagState,
	): Promise<boolean>;
	/** Records a past state once: a second record with the same id changes nothing. */
	insertRevision(revision: StoredRevision): Promise<void>;
	/** A note's states by its id, or by a title it had in the space, newest first. */
	listRevisions(
		space: SynapseSpaceId,
		note: { noteId: string } | { titleKey: string },
		limit: number,
	): Promise<StoredRevision[]>;
	getRevision(noteId: string, revision: number): Promise<StoredRevision | null>;
	/** Deletes a note's states at or below `revision`. */
	pruneRevisions(noteId: string, revision: number): Promise<void>;
	/** States recorded in a space after `since`, newest first. */
	revisionsSince(
		space: SynapseSpaceId,
		since: string,
		limit: number,
	): Promise<StoredRevision[]>;
	getMaintenance(space: SynapseSpaceId): Promise<MaintenanceRecord | null>;
	/** Every space's last run, for deciding which are due. */
	listMaintenanceRuns(): Promise<
		Array<Pick<MaintenanceRecord, "space" | "lastRunAt">>
	>;
	/**
	 * Takes a space's maintenance run. Fails while another unexpired lease
	 * holds it, or when its last run finished at or after `dueBefore`.
	 */
	claimMaintenance(
		space: SynapseSpaceId,
		lease: MaintenanceLease,
		now: string,
		dueBefore: string,
	): Promise<boolean>;
	/** Records a finished run and drops its lease; false when the lease was lost. */
	finishMaintenance(
		space: SynapseSpaceId,
		leaseId: string,
		batch: SynapseMaintenanceBatch,
		at: string,
	): Promise<boolean>;
	/** Drops the lease of a run that failed, so the next sweep retries it. */
	releaseMaintenance(space: SynapseSpaceId, leaseId: string): Promise<void>;
	/**
	 * Replaces the batch after a review, only while it is still at
	 * `expectedRevision`, and adds `dismissed` to the dismissed keys.
	 */
	reviewMaintenance(
		space: SynapseSpaceId,
		batch: SynapseMaintenanceBatch,
		expectedRevision: number,
		dismissed: string[],
	): Promise<boolean>;
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

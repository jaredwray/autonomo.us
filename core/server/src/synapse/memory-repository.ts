import type { SynapseProposal, SynapseSpaceId } from "@autonomo.us/common";
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
import { DAILY_DATE_PROPERTIES } from "./repository.js";

function matches(note: StoredNote, filter: NoteFilter): boolean {
	if (note.space !== filter.space) return false;
	if (filter.titleKey !== undefined && note.titleKey !== filter.titleKey)
		return false;
	if (
		filter.titleKeys !== undefined &&
		!filter.titleKeys.includes(note.titleKey)
	)
		return false;
	if (filter.linkKey !== undefined && !note.linkKeys.includes(filter.linkKey))
		return false;
	if (
		filter.linkKeys !== undefined &&
		!filter.linkKeys.some((key) => note.linkKeys.includes(key))
	)
		return false;
	if (
		filter.categoryKey !== undefined &&
		!note.categoryKeys.includes(filter.categoryKey)
	)
		return false;
	if (
		filter.tagPrefix !== undefined &&
		!note.tagKeys.some(
			(tag) =>
				tag === filter.tagPrefix || tag.startsWith(`${filter.tagPrefix}/`),
		)
	)
		return false;
	if (filter.terms?.some((term) => !note.searchText.includes(term)))
		return false;
	if (
		filter.where?.some(
			(entry) =>
				!note.propertyKeys.some(
					(stored) => stored.k === entry.k && stored.v === entry.v,
				),
		)
	)
		return false;
	return true;
}

/**
 * MongoDB compares strings by UTF-8 bytes, which is code-point order. Plain
 * `<` compares UTF-16 code units and disagrees for characters above U+FFFF.
 */
export function codePointOrder(x: string, y: string): number {
	let index = 0;
	while (index < x.length && index < y.length) {
		const a = x.codePointAt(index) as number;
		const b = y.codePointAt(index) as number;
		if (a !== b) return a - b;
		index += a > 0xffff ? 2 : 1;
	}
	// Equal so far, so the shorter string is a prefix of the longer.
	return x.length - y.length;
}

export function compareNotes(
	a: Pick<StoredNote, "updatedAt" | "createdAt" | "titleKey" | "id">,
	b: Pick<StoredNote, "updatedAt" | "createdAt" | "titleKey" | "id">,
	sort: FindOptions["sort"],
) {
	const order =
		codePointOrder(a[sort.by], b[sort.by]) || codePointOrder(a.id, b.id);
	return sort.direction === "asc" ? order : -order;
}

export function indexEntry(note: StoredNote): NoteIndexEntry {
	return {
		id: note.id,
		space: note.space,
		title: note.title,
		titleKey: note.titleKey,
		links: note.links,
		linkKeys: note.linkKeys,
		categories: note.categories,
		categoryKeys: note.categoryKeys,
		tags: note.tags,
		tagKeys: note.tagKeys,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
		revision: note.revision,
	};
}

/** Lasts until the process restarts. Used when MONGODB_URI is unset. */
export class MemorySynapseRepository implements SynapseRepository {
	readonly persistence = "memory" as const;
	private readonly notes = new Map<string, StoredNote>();
	private readonly spaces = new Map<string, SpaceRecord>();
	private readonly proposals = new Map<string, SynapseProposal>();
	/** Kept apart from proposals so claims never reach callers. */
	private readonly claims = new Map<string, ProposalClaim>();

	private select(filter: NoteFilter) {
		return [...this.notes.values()].filter((note) => matches(note, filter));
	}
	async getNote(space: SynapseSpaceId, titleKey: string) {
		const note = this.select({ space, titleKey })[0];
		return note ? structuredClone(note) : null;
	}
	async findNotes(filter: NoteFilter, options: FindOptions) {
		return this.select(filter)
			.sort((a, b) => compareNotes(a, b, options.sort))
			.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit)
			.map((note) => structuredClone(note));
	}
	async countNotes(filter: NoteFilter) {
		return this.select(filter).length;
	}
	async scanNotes(space: SynapseSpaceId) {
		return this.select({ space }).map((note) =>
			structuredClone(indexEntry(note)),
		);
	}
	async findDailyNotes(
		space: SynapseSpaceId,
		date: string,
		range: InstantRange,
		limit: number,
	) {
		const dateKey = date.toLowerCase();
		return this.select({ space })
			.filter(
				(note) =>
					note.titleKey !== dateKey &&
					(note.titleKey.startsWith(dateKey) ||
						(note.createdAt >= range.from && note.createdAt < range.to) ||
						note.propertyKeys.some(
							(entry) =>
								DAILY_DATE_PROPERTIES.includes(entry.k) &&
								entry.v.startsWith(dateKey),
						) ||
						note.linkKeys.includes(dateKey)),
			)
			.sort((a, b) =>
				compareNotes(a, b, { by: "createdAt", direction: "desc" }),
			)
			.slice(0, limit)
			.map((note) => structuredClone(note));
	}
	async insertNote(note: StoredNote) {
		if (
			this.notes.has(note.id) ||
			this.select({ space: note.space, titleKey: note.titleKey }).length
		)
			return false;
		this.notes.set(note.id, structuredClone(note));
		return true;
	}
	async replaceNote(note: StoredNote, expectedRevision: number) {
		const current = this.notes.get(note.id);
		if (!current || current.revision !== expectedRevision) return false;
		if (
			current.titleKey !== note.titleKey &&
			this.select({ space: note.space, titleKey: note.titleKey }).length
		)
			return false;
		this.notes.set(note.id, structuredClone(note));
		return true;
	}
	async deleteNote(id: string, expectedRevision?: number) {
		const current = this.notes.get(id);
		if (
			!current ||
			(expectedRevision !== undefined && current.revision !== expectedRevision)
		)
			return false;
		return this.notes.delete(id);
	}
	async spaceStats() {
		const stats = new Map<SynapseSpaceId, SpaceStats>();
		for (const note of this.notes.values()) {
			const current = stats.get(note.space);
			if (!current)
				stats.set(note.space, {
					space: note.space,
					noteCount: 1,
					createdAt: note.createdAt,
					updatedAt: note.updatedAt,
				});
			else {
				current.noteCount++;
				if (note.createdAt < current.createdAt)
					current.createdAt = note.createdAt;
				if (note.updatedAt > current.updatedAt)
					current.updatedAt = note.updatedAt;
			}
		}
		return [...stats.values()];
	}
	async listSpaceRecords() {
		return [...this.spaces.values()].map((record) => structuredClone(record));
	}
	async upsertSpaceRecord(
		id: SynapseSpaceId,
		at: string,
		name: string | undefined,
		fallbackName: string,
	) {
		const current = this.spaces.get(id);
		this.spaces.set(id, {
			id,
			name: name ?? current?.name ?? fallbackName,
			createdAt: current?.createdAt ?? at,
			updatedAt: at,
		});
	}
	async insertProposal(proposal: SynapseProposal) {
		this.proposals.set(proposal.id, structuredClone(proposal));
	}
	async getProposal(id: string) {
		const proposal = this.proposals.get(id);
		return proposal ? structuredClone(proposal) : null;
	}
	private selectProposals(filter: ProposalFilter) {
		return [...this.proposals.values()].filter(
			(proposal) =>
				(filter.authorId === undefined ||
					proposal.author.id === filter.authorId) &&
				(filter.status === undefined || proposal.status === filter.status),
		);
	}
	async listProposals(filter: ProposalFilter) {
		return this.selectProposals(filter)
			.sort(
				(a, b) =>
					b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
			)
			.map((proposal) => structuredClone(proposal));
	}
	async countProposals(filter: ProposalFilter) {
		return this.selectProposals(filter).length;
	}
	private claimHeld(id: string, now: string) {
		const claim = this.claims.get(id);
		return claim !== undefined && claim.until > now;
	}
	async claimProposal(id: string, claim: ProposalClaim, now: string) {
		const current = this.proposals.get(id);
		if (!current || current.status !== "pending" || this.claimHeld(id, now))
			return false;
		this.claims.set(id, { ...claim });
		return true;
	}
	async decideProposal(
		id: string,
		decision: ProposalDecision,
		guard: { now: string; claimId?: string },
	) {
		const current = this.proposals.get(id);
		if (!current || current.status !== "pending") return false;
		if (
			guard.claimId === undefined
				? this.claimHeld(id, guard.now)
				: this.claims.get(id)?.id !== guard.claimId
		)
			return false;
		this.claims.delete(id);
		this.proposals.set(id, { ...current, ...structuredClone(decision) });
		return true;
	}
	async releaseProposalClaim(id: string, claimId: string) {
		if (this.claims.get(id)?.id !== claimId) return false;
		return this.claims.delete(id);
	}
	async close() {}
}

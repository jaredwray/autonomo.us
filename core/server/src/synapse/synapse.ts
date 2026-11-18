import { randomUUID } from "node:crypto";
import {
	type AppendSynapseNoteRequest,
	type CiteSynapseEvidenceRequest,
	type CreateSynapseNoteRequest,
	type CreateSynapseProposalRequest,
	type DecideSynapseProposalRequest,
	type SetSynapseDecisionStatusRequest,
	SYNAPSE_DECISION_STATUSES,
	SYNAPSE_GLOBAL_SPACE,
	SYNAPSE_SHARED_SPACE,
	SYNAPSE_SPACE_ID_PATTERN,
	type SynapseActor,
	type SynapseCategory,
	type SynapseDaily,
	type SynapseEvidence,
	type SynapseExport,
	type SynapseGraph,
	type SynapseGraphNode,
	type SynapseHistory,
	type SynapseImportRequest,
	type SynapseImportResult,
	type SynapseNote,
	type SynapseNoteList,
	type SynapseNoteSummary,
	type SynapseNoteView,
	type SynapseProperties,
	type SynapseProposal,
	type SynapseProposalAction,
	type SynapseQuery,
	type SynapseRelatedNote,
	type SynapseRevision,
	type SynapseRevisionChange,
	type SynapseRevisionSummary,
	type SynapseSpace,
	type SynapseSpaceId,
	type SynapseSpaceList,
	type SynapseTemplate,
	type SynapseUnresolvedLink,
	type UpdateSynapseNoteRequest,
} from "@autonomo.us/common";
import { SynapseError } from "./errors.js";
import {
	appendSectionLine,
	cleanPassage,
	comparable,
	EVIDENCE_HEADING,
	evidenceLine,
	evidenceState,
	parseEvidence,
	propertyTargets,
	QUOTING_SECTIONS,
	standingOf,
	withoutSections,
} from "./evidence.js";
import {
	assertTitle,
	extractCategories,
	extractLinks,
	extractTags,
	linkLinter,
	parseMarkdown,
	propertyStrings,
	renderMarkdown,
	rewriteLinks,
	rewritePropertyLinks,
	snippet,
	titleKey,
	titleProblem,
	validateProperties,
} from "./markdown.js";
import { compareNotes } from "./memory-repository.js";
import type {
	FindOptions,
	NoteFilter,
	NoteIndexEntry,
	PropertyIndexEntry,
	ProposalFilter,
	StoredNote,
	StoredRevision,
	SynapseRepository,
} from "./repository.js";
import { propertyKeyValue, revisionId } from "./repository.js";
import {
	BUILTIN_TEMPLATES,
	DAILY_TEMPLATE,
	exportFolder,
	fillTemplate,
	findTemplate,
	templateFileName,
	templateForCategory,
	templateMarkdown,
} from "./templates.js";
import { dayRange, localDate, localTime, validDate } from "./time.js";

export const MAX_BODY_LENGTH = 100_000;
export const MAX_APPEND_LENGTH = 20_000;
export const MAX_NOTES_PER_SPACE = 10_000;
export const MAX_PENDING_PROPOSALS = 50;
/** How long an approval holds a proposal while it applies; a crash only delays the decision this long. */
export const PROPOSAL_CLAIM_MS = 60_000;
export const MAX_REASON_LENGTH = 2000;
/**
 * Past states kept for one note. Older ones are dropped, so a daily note
 * that is logged to hundreds of times does not grow without bound.
 */
export const MAX_REVISIONS_PER_NOTE = 200;
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;
const BACKLINK_LIMIT = 100;
const RELATED_LIMIT = 20;
const DAILY_LIMIT = 200;
const CATEGORY_MEMBER_LIMIT = 500;
const RELEVANCE_CANDIDATES = 1000;
const WRITE_ATTEMPTS = 5;
const UNRESOLVED_SOURCES = 5;
/**
 * The graph keeps this many nodes, notes before unresolved targets, so the
 * largest space stays a small response the dashboard can lay out.
 */
export const MAX_GRAPH_NODES = 1000;
const PROPOSAL_ACTIONS: readonly SynapseProposalAction[] = [
	"create",
	"update",
	"append",
	"delete",
];

export const SYSTEM_ACTOR: SynapseActor = {
	kind: "system",
	id: "synapse",
	name: "Synapse",
};

const spacePattern = new RegExp(SYNAPSE_SPACE_ID_PATTERN);

export function assertSpaceId(id: string): SynapseSpaceId {
	if (!spacePattern.test(id))
		throw new SynapseError(
			'Space IDs are "shared", "global", or "agent-<agent token ID>".',
			400,
		);
	return id as SynapseSpaceId;
}

export const agentSpaceId = (agentTokenId: string): SynapseSpaceId =>
	`agent-${agentTokenId}`;

/** A workspace's shared space in storage. The default workspace keeps the original key. */
/** Pages of Global notes `recentNotes` reads past the ones a workspace overrides. */
const RECENT_NOTES_PAGES = 20;

export const sharedSpaceId = (workspace: {
	id: string;
	isDefault: boolean;
}): SynapseSpaceId =>
	workspace.isDefault ? SYNAPSE_SHARED_SPACE : `shared-${workspace.id}`;

/** Every workspace's shared space inherits the global space. */
export const inheritsGlobal = (space: SynapseSpaceId) =>
	space === SYNAPSE_SHARED_SPACE || space.startsWith("shared-");

/** The ID a request uses for a space: every workspace calls its shared space `shared`. */
export const publicSpaceId = (space: SynapseSpaceId): SynapseSpaceId =>
	inheritsGlobal(space) ? SYNAPSE_SHARED_SPACE : space;

const inherited = (title: string) =>
	new SynapseError(
		`"${title}" is inherited from the global Synapse. Change it there, or create a note with this title here to override it.`,
		409,
	);

const notFound = (title: string) =>
	new SynapseError(`No note titled "${title}" in this space.`, 404);
const titleTaken = (title: string) =>
	new SynapseError(`A note titled "${title}" already exists.`, 409);
const changed = () =>
	new SynapseError(
		"This note changed during your request. Reload it and try again.",
		409,
	);

function assertBody(body: unknown): string {
	if (typeof body !== "string")
		throw new SynapseError("The body must be a string.");
	if (body.length > MAX_BODY_LENGTH)
		throw new SynapseError(
			`Bodies are at most ${MAX_BODY_LENGTH.toLocaleString("en-US")} characters.`,
		);
	return body;
}

function assertAppendText(text: unknown): string {
	if (typeof text !== "string" || text.length === 0)
		throw new SynapseError("Text to append is required.");
	if (text.length > MAX_APPEND_LENGTH)
		throw new SynapseError(
			`An append adds at most ${MAX_APPEND_LENGTH.toLocaleString("en-US")} characters.`,
		);
	return text;
}

function assertReason(reason: unknown, what: string): string {
	if (typeof reason !== "string" || reason.trim().length === 0)
		throw new SynapseError(`${what} needs a reason.`);
	if (reason.length > MAX_REASON_LENGTH)
		throw new SynapseError(
			`Reasons are at most ${MAX_REASON_LENGTH.toLocaleString("en-US")} characters.`,
		);
	return reason;
}

function appendText(body: string, text: string) {
	if (body === "") return text;
	return body.endsWith("\n") ? body + text : `${body}\n${text}`;
}

/** Adds `line` to the `## Log` section, creating the heading at the end if needed. */
export function appendLogLine(body: string, line: string): string {
	return appendSectionLine(body, "Log", line);
}

function indexValues(properties: SynapseProperties): PropertyIndexEntry[] {
	const out: PropertyIndexEntry[] = [];
	for (const [k, value] of Object.entries(properties)) {
		if (value === null) continue;
		if (Array.isArray(value))
			for (const item of value) out.push({ k, v: propertyKeyValue(item) });
		else out.push({ k, v: propertyKeyValue(value) });
	}
	return out;
}

function derive(title: string, properties: SynapseProperties, body: string) {
	// Frontmatter comes first in the file, so its links come first here.
	const links = extractLinks([...propertyStrings(properties), body]);
	const tags = extractTags(body, properties);
	const categories = extractCategories(properties);
	const values = Object.values(properties).flatMap((value) =>
		value === null ? [] : Array.isArray(value) ? value : [String(value)],
	);
	return {
		title,
		properties,
		body,
		links,
		tags,
		categories,
		titleKey: titleKey(title),
		linkKeys: links.map(titleKey),
		categoryKeys: categories.map(titleKey),
		tagKeys: tags,
		searchText: [title, body, ...values].join("\n").toLowerCase(),
		propertyKeys: indexValues(properties),
		// Obsidian's `aliases` property: other names the note goes by.
		aliasKeys: propertyTargets(properties.aliases).map(titleKey),
	};
}

export function publicNote(note: StoredNote): SynapseNote {
	return {
		id: note.id,
		space: publicSpaceId(note.space),
		title: note.title,
		properties: note.properties,
		body: note.body,
		links: note.links,
		tags: note.tags,
		categories: note.categories,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
		createdBy: note.createdBy,
		updatedBy: note.updatedBy,
		revision: note.revision,
	};
}

function summary(note: StoredNote, terms: string[] = []): SynapseNoteSummary {
	return {
		id: note.id,
		space: publicSpaceId(note.space),
		title: note.title,
		categories: note.categories,
		tags: note.tags,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
		revision: note.revision,
		// A snippet shows the note's own words, not what it quotes from sources.
		snippet: snippet(withoutSections(note.body, QUOTING_SECTIONS), terms),
	};
}

const publicProposal = (proposal: SynapseProposal): SynapseProposal => ({
	...proposal,
	space: publicSpaceId(proposal.space),
});

function occurrences(text: string, term: string) {
	let count = 0;
	let at = text.indexOf(term);
	while (at !== -1) {
		count++;
		at = text.indexOf(term, at + term.length);
	}
	return count;
}

/** Title matches first, then body hits, then recency; see docs/SYNAPSE.md §5. */
function relevance(note: StoredNote, terms: string[], text: string) {
	const title = note.titleKey;
	const body = note.body.toLowerCase();
	return {
		exact: title === text ? 1 : 0,
		title: terms.every((term) => title.includes(term)) ? 1 : 0,
		hits: terms.reduce((sum, term) => sum + occurrences(body, term), 0),
	};
}

/**
 * What a write did to a space, for whoever listens: one note created,
 * updated, or deleted, or an import of many, reported once. `space` is the
 * storage key, so a workspace's shared space is `shared` or `shared-<id>`.
 */
export type SynapseChange = {
	space: SynapseSpaceId;
	actor: SynapseActor;
	at: string;
} & (
	| {
			kind: "created" | "updated" | "deleted";
			note: { id: string; title: string; revision: number };
			/** The title before, when the note was renamed. */
			previousTitle: string | null;
	  }
	| { kind: "imported"; created: number; updated: number }
);

export type SynapseServiceOptions = {
	/** IANA time zone deciding "today" for templates, daily notes, and the log. */
	timeZone: string;
	now?: () => number;
	/**
	 * Called after a note is written or deleted, or notes are imported. A
	 * failure here never fails the write. Notes Synapse writes for itself
	 * (category notes, links rewritten by a rename) are not reported.
	 */
	onChange?: (change: SynapseChange) => unknown;
};

/** Synapse's behavior over a repository; see docs/SYNAPSE.md. */
export class SynapseService {
	readonly timeZone: string;
	private readonly clock: () => number;
	private readonly onChange: SynapseServiceOptions["onChange"];
	constructor(
		readonly repository: SynapseRepository,
		options: SynapseServiceOptions,
	) {
		this.timeZone = options.timeZone;
		this.clock = options.now ?? Date.now;
		this.onChange = options.onChange;
	}
	/** Tells whoever listens what a write did. The write stands whatever they do. */
	private async report(
		note: StoredNote,
		kind: "created" | "updated" | "deleted",
		actor: SynapseActor,
		previousTitle: string | null = null,
	) {
		try {
			await this.onChange?.({
				space: note.space,
				actor,
				at: this.now(),
				kind,
				note: { id: note.id, title: note.title, revision: note.revision },
				previousTitle,
			});
		} catch {
			// Whoever listens handles its own trouble.
		}
	}
	private now() {
		return new Date(this.clock()).toISOString();
	}
	/** The service's clock, for the parts of Synapse built on it. */
	nowMs(): number {
		return this.clock();
	}

	private snapshot(
		note: StoredNote,
		change: SynapseRevisionChange,
	): StoredRevision {
		return {
			id: revisionId(note.id, note.revision),
			noteId: note.id,
			space: note.space,
			title: note.title,
			titleKey: note.titleKey,
			revision: note.revision,
			change,
			at: note.updatedAt,
			by: note.updatedBy,
			properties: note.properties,
			body: note.body,
		};
	}
	/**
	 * Records a note's new state in its history. `previous` is the state it
	 * replaced: it is recorded too when it is not there yet, which covers
	 * notes written before history was kept and a record that failed to
	 * write. The note's own write stands whatever happens here.
	 */
	private async remember(
		note: StoredNote,
		change: SynapseRevisionChange,
		previous?: StoredNote,
	) {
		try {
			await Promise.all([
				previous
					? this.repository.insertRevision(
							this.snapshot(
								previous,
								previous.revision === 1 ? "created" : "updated",
							),
						)
					: undefined,
				this.repository.insertRevision(this.snapshot(note, change)),
			]);
			if (note.revision > MAX_REVISIONS_PER_NOTE)
				await this.repository.pruneRevisions(
					note.id,
					note.revision - MAX_REVISIONS_PER_NOTE,
				);
		} catch {
			// The next change to the note records this state as its `previous`.
		}
	}
	today(): string {
		return localDate(this.clock(), this.timeZone);
	}

	templates(): SynapseTemplate[] {
		return structuredClone(BUILTIN_TEMPLATES) as SynapseTemplate[];
	}

	/**
	 * The spaces one workspace sees: global, its shared space (`shared` names
	 * the default workspace's), and the agent spaces of `agentTokenIds` (every
	 * agent space when omitted). Counts are each space's own notes.
	 */
	async listSpaces(
		scope: {
			shared?: SynapseSpaceId;
			agentTokenIds?: ReadonlySet<string>;
		} = {},
	): Promise<SynapseSpaceList> {
		const sharedKey = scope.shared ?? SYNAPSE_SHARED_SPACE;
		const [stats, records] = await Promise.all([
			this.repository.spaceStats(),
			this.repository.listSpaceRecords(),
		]);
		const names = new Map(records.map((record) => [record.id, record.name]));
		const fixed = (
			id: SynapseSpaceId,
			key: SynapseSpaceId,
			kind: "global" | "shared",
			name: string,
		): SynapseSpace => {
			const stat = stats.find((item) => item.space === key);
			return {
				id,
				kind,
				name,
				noteCount: stat?.noteCount ?? 0,
				createdAt: stat?.createdAt ?? null,
				updatedAt: stat?.updatedAt ?? null,
			};
		};
		const spaces: SynapseSpace[] = [
			fixed(SYNAPSE_GLOBAL_SPACE, SYNAPSE_GLOBAL_SPACE, "global", "Global"),
			fixed(SYNAPSE_SHARED_SPACE, sharedKey, "shared", "Shared"),
			...stats
				.filter(
					(item) =>
						item.space.startsWith("agent-") &&
						item.noteCount > 0 &&
						(scope.agentTokenIds === undefined ||
							scope.agentTokenIds.has(item.space.slice("agent-".length))),
				)
				.map(
					(item): SynapseSpace => ({
						id: item.space,
						kind: "agent",
						name: names.get(item.space) ?? item.space,
						agentTokenId: item.space.slice("agent-".length),
						noteCount: item.noteCount,
						createdAt: item.createdAt,
						updatedAt: item.updatedAt,
					}),
				)
				.sort(
					(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
				),
		];
		return {
			spaces,
			persistence: this.repository.persistence,
			timeZone: this.timeZone,
		};
	}

	private newNote(
		space: SynapseSpaceId,
		title: string,
		properties: SynapseProperties,
		body: string,
		actor: SynapseActor,
	): StoredNote {
		const at = this.now();
		return {
			id: randomUUID(),
			space,
			...derive(title, properties, body),
			createdAt: at,
			updatedAt: at,
			createdBy: actor,
			updatedBy: actor,
			revision: 1,
		};
	}
	private revise(
		current: StoredNote,
		title: string,
		properties: SynapseProperties,
		body: string,
		actor: SynapseActor,
	): StoredNote {
		return {
			...current,
			...derive(title, properties, body),
			updatedAt: this.now(),
			updatedBy: actor,
			revision: current.revision + 1,
		};
	}
	private async assertRoom(space: SynapseSpaceId, adding = 1) {
		const count = await this.repository.countNotes({ space });
		if (count + adding > MAX_NOTES_PER_SPACE)
			throw new SynapseError(
				`A space holds at most ${MAX_NOTES_PER_SPACE.toLocaleString("en-US")} notes.`,
			);
	}
	/** The space a space inherits: each workspace's shared space inherits global. */
	private parentOf(space: SynapseSpaceId): SynapseSpaceId | null {
		return inheritsGlobal(space) ? SYNAPSE_GLOBAL_SPACE : null;
	}
	/**
	 * Titles a space defines itself, which override its parent's notes; null
	 * for a space that inherits nothing. A call reads them once and passes
	 * them to each inherited read, so one request scans the index once.
	 */
	private async overrides(space: SynapseSpaceId): Promise<string[] | null> {
		if (!this.parentOf(space)) return null;
		return (await this.repository.scanNotes(space)).map(
			(entry) => entry.titleKey,
		);
	}
	// Reads through inheritance: a space's own notes, then its parent's notes
	// whose titles it does not define. Writes always go to the space itself.
	/** A note as stored, through inheritance, or null. */
	findNote(space: SynapseSpaceId, title: string): Promise<StoredNote | null> {
		return this.readNote(space, titleKey(title));
	}
	/** Every note a space shows, without bodies. */
	index(space: SynapseSpaceId): Promise<NoteIndexEntry[]> {
		return this.readIndex(space);
	}
	/**
	 * Notes a space shows that match `filter`, as stored. A caller that
	 * reads the same space several times passes its `ownTitles` once read.
	 */
	find(
		filter: NoteFilter,
		options: FindOptions,
		ownTitles?: string[] | null,
	): Promise<StoredNote[]> {
		return this.readNotes(filter, options, ownTitles);
	}
	/**
	 * The titles a space defines itself, lowercased, which hide Global's
	 * notes of the same title; null for a space that inherits nothing.
	 */
	ownTitles(space: SynapseSpaceId): Promise<string[] | null> {
		return this.overrides(space);
	}
	private async readNote(space: SynapseSpaceId, key: string) {
		const own = await this.repository.getNote(space, key);
		const parent = this.parentOf(space);
		return own ?? (parent ? this.repository.getNote(parent, key) : null);
	}
	private async readIndex(space: SynapseSpaceId) {
		const own = await this.repository.scanNotes(space);
		const parent = this.parentOf(space);
		if (!parent) return own;
		const keys = new Set(own.map((entry) => entry.titleKey));
		const inherited = await this.repository.scanNotes(parent);
		return [...own, ...inherited.filter((entry) => !keys.has(entry.titleKey))];
	}
	private async readNotes(
		filter: NoteFilter,
		options: FindOptions,
		overrides?: string[] | null,
	) {
		const parent = this.parentOf(filter.space);
		if (!parent) return this.repository.findNotes(filter, options);
		const offset = options.offset ?? 0;
		const window = { sort: options.sort, limit: offset + options.limit };
		const [own, keys] = await Promise.all([
			this.repository.findNotes(filter, window),
			overrides ?? this.overrides(filter.space).then((keys) => keys ?? []),
		]);
		const inherited = await this.repository.findNotes(
			{
				...filter,
				space: parent,
				excludeTitleKeys: [...(filter.excludeTitleKeys ?? []), ...keys],
			},
			window,
		);
		return [...own, ...inherited]
			.sort((a, b) => compareNotes(a, b, options.sort))
			.slice(offset, offset + options.limit);
	}
	private async countVisible(filter: NoteFilter, overrides?: string[] | null) {
		const parent = this.parentOf(filter.space);
		if (!parent) return this.repository.countNotes(filter);
		const [own, keys] = await Promise.all([
			this.repository.countNotes(filter),
			overrides ?? this.overrides(filter.space).then((keys) => keys ?? []),
		]);
		return (
			own +
			(await this.repository.countNotes({
				...filter,
				space: parent,
				excludeTitleKeys: [...(filter.excludeTitleKeys ?? []), ...keys],
			}))
		);
	}
	private async readDaily(
		space: SynapseSpaceId,
		date: string,
		range: { from: string; to: string },
		limit: number,
	) {
		const parent = this.parentOf(space);
		if (!parent)
			return this.repository.findDailyNotes(space, date, range, limit);
		const [own, keys] = await Promise.all([
			this.repository.findDailyNotes(space, date, range, limit),
			this.overrides(space),
		]);
		const overridden = new Set(keys);
		const inherited = await this.repository.findDailyNotes(
			parent,
			date,
			range,
			limit + overridden.size,
		);
		return [
			...own,
			...inherited.filter((note) => !overridden.has(note.titleKey)),
		]
			.sort((a, b) =>
				compareNotes(a, b, { by: "createdAt", direction: "desc" }),
			)
			.slice(0, limit);
	}
	/** Inherited notes are read-only in the inheriting space. */
	private assertOwn(space: SynapseSpaceId, note: StoredNote) {
		if (note.space !== space) throw inherited(note.title);
	}
	private async mustGet(space: SynapseSpaceId, title: string) {
		const note = await this.readNote(space, titleKey(title));
		if (!note) throw notFound(title);
		return note;
	}
	private async touchSpace(space: SynapseSpaceId, actor: SynapseActor) {
		const agent = space.startsWith("agent-") && actor.kind === "agent";
		await this.repository.upsertSpaceRecord(
			space,
			this.now(),
			agent ? actor.name : undefined,
			space === SYNAPSE_GLOBAL_SPACE
				? "Global"
				: inheritsGlobal(space)
					? "Shared"
					: space,
		);
	}
	/** Creates missing category notes, tagged `categories`, with the template's description. */
	private async ensureCategoryNotes(
		space: SynapseSpaceId,
		categories: string[],
	) {
		for (const category of categories) {
			if (titleProblem(category)) continue;
			if (await this.readNote(space, titleKey(category))) continue;
			if ((await this.repository.countNotes({ space })) >= MAX_NOTES_PER_SPACE)
				return;
			const template = templateForCategory(category);
			const note = this.newNote(
				space,
				template?.category ?? category,
				{ tags: ["categories"] },
				template?.description ?? "",
				SYSTEM_ACTOR,
			);
			if (await this.repository.insertNote(note))
				await this.remember(note, "created");
		}
	}
	private async afterWrite(
		space: SynapseSpaceId,
		actor: SynapseActor,
		categories: string[],
	) {
		await this.ensureCategoryNotes(space, categories);
		await this.touchSpace(space, actor);
	}
	private templateFor(name: string | undefined) {
		if (name === undefined) return undefined;
		const template = findTemplate(name);
		if (!template)
			throw new SynapseError(
				`Unknown template "${name}". See synapse_templates or GET /v1/<workspace id>/synapse/templates.`,
			);
		return template;
	}

	async createNote(
		space: SynapseSpaceId,
		request: CreateSynapseNoteRequest,
		actor: SynapseActor,
	): Promise<SynapseNote> {
		const title = assertTitle(request.title);
		let properties: SynapseProperties;
		let body: string;
		if (request.markdown !== undefined) {
			const parsed = parseMarkdown(request.markdown);
			properties = validateProperties(parsed.properties);
			body = parsed.body;
		} else {
			const template = this.templateFor(request.template);
			properties = validateProperties({
				...(template ? fillTemplate(template, this.today()) : {}),
				...validateProperties(request.properties ?? {}),
			});
			body = request.body ?? template?.body ?? "";
		}
		assertBody(body);
		await this.assertRoom(space);
		const note = this.newNote(space, title, properties, body, actor);
		if (!(await this.repository.insertNote(note))) throw titleTaken(title);
		await this.remember(note, "created");
		await this.afterWrite(space, actor, note.categories);
		await this.report(note, "created", actor);
		return publicNote(note);
	}

	async getNote(space: SynapseSpaceId, title: string): Promise<SynapseNote> {
		return publicNote(await this.mustGet(space, title));
	}

	private backlinkCounts(index: NoteIndexEntry[]) {
		const counts = new Map<string, number>();
		for (const entry of index)
			for (const key of entry.linkKeys)
				counts.set(key, (counts.get(key) ?? 0) + 1);
		return counts;
	}

	/** kepano's Related base: direct links or more than two shared outgoing links. */
	private async related(
		space: SynapseSpaceId,
		note: StoredNote,
		index: NoteIndexEntry[],
		overrides: string[] | null,
	): Promise<SynapseRelatedNote[]> {
		const backlinks = this.backlinkCounts(index);
		const linkKeys = new Set(note.linkKeys);
		const tagKeys = new Set(note.tagKeys);
		const ranked = index
			.flatMap((entry) => {
				if (entry.id === note.id) return [];
				const sharedLinks = entry.links.filter((link) =>
					linkKeys.has(titleKey(link)),
				);
				const direct =
					entry.linkKeys.includes(note.titleKey) ||
					linkKeys.has(entry.titleKey);
				if (!direct && sharedLinks.length <= 2) return [];
				const sharedTags = entry.tags.filter((tag) => tagKeys.has(tag));
				return [
					{
						entry,
						sharedLinks,
						sharedTags,
						direct,
						backlinks: backlinks.get(entry.titleKey) ?? 0,
					},
				];
			})
			.sort(
				(a, b) =>
					b.sharedLinks.length - a.sharedLinks.length ||
					b.sharedTags.length - a.sharedTags.length ||
					b.backlinks - a.backlinks ||
					a.entry.titleKey.localeCompare(b.entry.titleKey),
			)
			.slice(0, RELATED_LIMIT);
		if (!ranked.length) return [];
		const notes = await this.readNotes(
			{
				space,
				titleKeys: ranked.map((item) => item.entry.titleKey),
			},
			{ sort: { by: "titleKey", direction: "asc" }, limit: RELATED_LIMIT },
			overrides,
		);
		const byKey = new Map(notes.map((item) => [item.titleKey, item]));
		return ranked.flatMap((item) => {
			const full = byKey.get(item.entry.titleKey);
			return full
				? [
						{
							...summary(full),
							sharedLinks: item.sharedLinks,
							sharedTags: item.sharedTags,
							direct: item.direct,
						},
					]
				: [];
		});
	}

	async viewNote(
		space: SynapseSpaceId,
		title: string,
	): Promise<SynapseNoteView> {
		const note = await this.mustGet(space, title);
		const index = await this.readIndex(space);
		// The index already holds the space's own titles; reuse them.
		const overrides = this.parentOf(space)
			? index
					.filter((entry) => entry.space === space)
					.map((entry) => entry.titleKey)
			: null;
		const [backlinks, members] = await Promise.all([
			this.readNotes(
				{ space, linkKey: note.titleKey },
				{ sort: { by: "updatedAt", direction: "desc" }, limit: BACKLINK_LIMIT },
				overrides,
			),
			this.readNotes(
				{ space, categoryKey: note.titleKey },
				{
					sort: { by: "titleKey", direction: "asc" },
					limit: CATEGORY_MEMBER_LIMIT,
				},
				overrides,
			),
		]);
		const existing = new Set(index.map((entry) => entry.titleKey));
		return {
			note: publicNote(note),
			backlinks: backlinks.map((item) => summary(item)),
			outgoing: note.links.map((link) => ({
				title: link,
				exists: existing.has(titleKey(link)),
			})),
			related: await this.related(space, note, index, overrides),
			categoryMembers: members.map((item) => summary(item)),
			markdown: renderMarkdown(note.properties, note.body),
			standing: standingOf(note.properties),
			evidence: await this.evidenceOf(space, note, overrides),
		};
	}

	/** A note's evidence lines, each checked against its source as it stands. */
	async evidenceOf(
		space: SynapseSpaceId,
		note: Pick<StoredNote, "body">,
		overrides?: string[] | null,
	): Promise<SynapseEvidence[]> {
		const cited = parseEvidence(note.body);
		if (!cited.length) return [];
		const keys = [...new Set(cited.map((item) => titleKey(item.source)))];
		const sources = new Map(
			(
				await this.readNotes(
					{ space, titleKeys: keys },
					{ sort: { by: "titleKey", direction: "asc" }, limit: keys.length },
					overrides,
				)
			).map((source) => [source.titleKey, source.body]),
		);
		return cited.map((item) => ({
			...item,
			state: evidenceState(
				item.passage,
				sources.get(titleKey(item.source)) ?? null,
			),
		}));
	}

	/**
	 * Cites a source for a note: checks that the source contains the passage
	 * and adds a line to the note's `## Evidence` section, with the source's
	 * revision and today's date. Citing the same passage twice adds nothing.
	 */
	async cite(
		space: SynapseSpaceId,
		title: string,
		request: CiteSynapseEvidenceRequest,
		actor: SynapseActor,
	): Promise<{ note: SynapseNote; evidence: SynapseEvidence }> {
		const note = await this.mustGet(space, title);
		this.assertOwn(space, note);
		const source = await this.mustGet(space, assertTitle(request.source));
		const passage = cleanPassage(
			typeof request.passage === "string" ? request.passage : "",
		);
		if (!passage)
			throw new SynapseError(
				"A passage is required: the words in the source that support the note.",
			);
		if (evidenceState(passage, source.body) !== "verified")
			throw new SynapseError(
				`"${source.title}" does not contain that passage. Quote its words exactly.`,
			);
		const evidence: SynapseEvidence = {
			source: source.title,
			revision: source.revision,
			date: this.today(),
			passage,
			state: "verified",
		};
		const cited = (body: string) =>
			parseEvidence(body).some(
				(item) =>
					titleKey(item.source) === source.titleKey &&
					comparable(item.passage) === comparable(passage),
			);
		if (cited(note.body)) return { note: publicNote(note), evidence };
		const line = evidenceLine({
			source: source.title,
			revision: source.revision,
			date: this.today(),
			passage,
		});
		const next = await this.change(space, title, (current) =>
			cited(current.body)
				? current
				: this.revise(
						current,
						current.title,
						current.properties,
						assertBody(appendSectionLine(current.body, EVIDENCE_HEADING, line)),
						actor,
					),
		);
		await this.afterWrite(space, actor, next.categories);
		await this.report(next, "updated", actor);
		return { note: publicNote(next), evidence };
	}

	/**
	 * Marks a decision active, disputed, or superseded. The status goes in the
	 * `status` property, the day in `reviewed`, and a dated line in the note's
	 * `## Status` section. Superseding names the decision that replaces it,
	 * which records in turn what it replaced.
	 */
	async setDecisionStatus(
		space: SynapseSpaceId,
		title: string,
		request: SetSynapseDecisionStatusRequest,
		actor: SynapseActor,
	): Promise<SynapseNote> {
		if (!SYNAPSE_DECISION_STATUSES.includes(request.status))
			throw new SynapseError("A decision is active, disputed, or superseded.");
		const decision = (note: StoredNote) => {
			if (!note.categoryKeys.includes("decisions"))
				throw new SynapseError(
					`"${note.title}" is not a decision: only notes in the Decisions category carry this status.`,
				);
			return note;
		};
		const note = decision(await this.mustGet(space, title));
		this.assertOwn(space, note);
		let by: StoredNote | undefined;
		if (request.status === "superseded") {
			if (request.supersededBy === undefined)
				throw new SynapseError(
					"Say which decision supersedes this one (supersededBy).",
				);
			by = decision(
				await this.mustGet(space, assertTitle(request.supersededBy)),
			);
			if (by.id === note.id)
				throw new SynapseError("A decision cannot supersede itself.");
		} else if (request.supersededBy !== undefined)
			throw new SynapseError(
				"supersededBy applies only when the status is superseded.",
			);
		const reason =
			request.reason === undefined || request.reason.trim() === ""
				? ""
				: assertReason(request.reason, "A status change").trim();
		const label = `${request.status[0].toUpperCase()}${request.status.slice(1)}`;
		const today = this.today();
		const line = `- ${today} ${label}${by ? ` by [[${by.title}]]` : ""} (${actor.name})${reason ? `: ${reason}` : ""}`;
		const { superseded_by: _replaced, ...kept } = note.properties;
		const updated = await this.updateNote(
			space,
			note.title,
			{
				properties: {
					...kept,
					status: [`[[${label}]]`],
					reviewed: today,
					...(by ? { superseded_by: [`[[${by.title}]]`] } : {}),
				},
				replaceProperties: true,
				body: appendSectionLine(note.body, "Status", line),
				revision: note.revision,
			},
			actor,
		);
		// A decision that no longer replaces this one stops saying it does:
		// one reactivated, or superseded now by another.
		for (const former of propertyTargets(note.properties.superseded_by)) {
			if (by && titleKey(former) === by.titleKey) continue;
			// The status is saved. The other decision may be changing too, so
			// this is tried against a fresh copy each time; if it still cannot
			// be written, the status stands and maintenance reports the pair.
			for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
				const replacer = await this.repository.getNote(space, titleKey(former));
				if (!replacer) break;
				const supersedes = propertyTargets(replacer.properties.supersedes);
				const remaining = supersedes.filter(
					(item) => titleKey(item) !== note.titleKey,
				);
				if (remaining.length === supersedes.length) break;
				const written = await this.updateNote(
					space,
					replacer.title,
					{
						properties: {
							supersedes: remaining.map((item) => `[[${item}]]`),
						},
						revision: replacer.revision,
					},
					actor,
				).then(
					() => true,
					(error) => {
						if (error instanceof SynapseError && error.statusCode === 409)
							return false;
						throw error;
					},
				);
				if (written) break;
			}
		}
		// The replacing decision says what it replaced, when it is this space's own.
		if (by && by.space === space) {
			const supersedes = propertyTargets(by.properties.supersedes);
			if (!supersedes.some((item) => titleKey(item) === note.titleKey))
				await this.updateNote(
					space,
					by.title,
					{
						properties: {
							supersedes: [...supersedes, note.title].map(
								(item) => `[[${item}]]`,
							),
						},
					},
					actor,
				);
		}
		return updated;
	}

	private revisionSummary(revision: StoredRevision): SynapseRevisionSummary {
		return {
			revision: revision.revision,
			title: revision.title,
			change: revision.change,
			at: revision.at,
			by: revision.by,
			size: revision.body.length,
		};
	}
	/** A note's recorded states. One written before history was kept shows its current state. */
	private async revisionsOf(space: SynapseSpaceId, title: string) {
		const note = await this.readNote(space, titleKey(title));
		let revisions = note
			? await this.repository.listRevisions(
					note.space,
					{ noteId: note.id },
					MAX_REVISIONS_PER_NOTE,
				)
			: await this.repository.listRevisions(
					space,
					{ titleKey: titleKey(title) },
					MAX_REVISIONS_PER_NOTE,
				);
		if (note && !revisions.some((item) => item.revision === note.revision))
			revisions = [
				this.snapshot(note, note.revision === 1 ? "created" : "updated"),
				...revisions,
			];
		if (!revisions.length) throw notFound(title);
		return { note, revisions };
	}

	/** A note's past states, newest first. A deleted note's history is found by its last title. */
	async history(space: SynapseSpaceId, title: string): Promise<SynapseHistory> {
		const { note, revisions } = await this.revisionsOf(space, title);
		return {
			title: note?.title ?? revisions[0].title,
			exists: note !== null,
			revisions: revisions.map((item) => this.revisionSummary(item)),
		};
	}

	/** One past state of a note in full. */
	async revision(
		space: SynapseSpaceId,
		title: string,
		revision: number,
	): Promise<SynapseRevision> {
		const { revisions } = await this.revisionsOf(space, title);
		const found = revisions.find((item) => item.revision === revision);
		if (!found)
			throw new SynapseError(
				`"${revisions[0].title}" has no revision ${revision} in its history.`,
				404,
			);
		return {
			...this.revisionSummary(found),
			properties: found.properties,
			body: found.body,
			markdown: renderMarkdown(found.properties, found.body),
		};
	}

	/**
	 * Brings a past state back as the note's newest revision. A deleted note
	 * is created again with what the state held.
	 */
	async restoreRevision(
		space: SynapseSpaceId,
		title: string,
		revision: number,
		actor: SynapseActor,
	): Promise<SynapseNote> {
		const past = await this.revision(space, title, revision);
		const current = await this.repository.getNote(space, titleKey(title));
		if (!current) {
			// An inherited note is not this space's to restore.
			const shown = await this.readNote(space, titleKey(title));
			if (shown) throw inherited(shown.title);
			return this.createNote(
				space,
				{ title: past.title, body: past.body, properties: past.properties },
				actor,
			);
		}
		return this.updateNote(
			space,
			current.title,
			{ body: past.body, properties: past.properties, replaceProperties: true },
			actor,
		);
	}

	/** Retries a compare-and-set change against a fresh copy of the note. */
	private async change(
		space: SynapseSpaceId,
		title: string,
		apply: (current: StoredNote) => StoredNote | Promise<StoredNote>,
		/** Own notes only: a missing note is 404 even when an inherited one has its title. */
		own = false,
	): Promise<StoredNote> {
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const current = own
				? await this.repository.getNote(space, titleKey(title))
				: await this.mustGet(space, title);
			if (!current) throw notFound(title);
			this.assertOwn(space, current);
			const next = await apply(current);
			if (await this.repository.replaceNote(next, current.revision)) {
				await this.remember(next, "updated", current);
				return next;
			}
		}
		throw changed();
	}

	async updateNote(
		space: SynapseSpaceId,
		title: string,
		request: UpdateSynapseNoteRequest,
		actor: SynapseActor,
	): Promise<SynapseNote> {
		const current = await this.mustGet(space, title);
		this.assertOwn(space, current);
		if (request.revision !== undefined && request.revision !== current.revision)
			throw changed();
		const newTitle =
			request.title === undefined ? current.title : assertTitle(request.title);
		let properties = current.properties;
		let body = current.body;
		if (request.markdown !== undefined) {
			const parsed = parseMarkdown(request.markdown);
			properties = validateProperties(parsed.properties);
			body = parsed.body;
		} else {
			if (request.properties !== undefined) {
				const incoming = validateProperties(request.properties);
				properties = validateProperties(
					request.replaceProperties ? incoming : { ...properties, ...incoming },
				);
			}
			if (request.body !== undefined) body = request.body;
		}
		assertBody(body);
		const renamed = titleKey(newTitle) !== current.titleKey;
		if (renamed) {
			if (await this.repository.getNote(space, titleKey(newTitle)))
				throw titleTaken(newTitle);
			body = rewriteLinks(body, current.title, newTitle);
			properties = rewritePropertyLinks(properties, current.title, newTitle);
		}
		const next = this.revise(current, newTitle, properties, body, actor);
		if (!(await this.repository.replaceNote(next, current.revision)))
			throw renamed && (await this.repository.getNote(space, next.titleKey))
				? titleTaken(newTitle)
				: changed();
		await this.remember(next, "updated", current);
		if (renamed) {
			await this.rewriteLinksTo(space, current.title, newTitle, actor);
			if (space === SYNAPSE_GLOBAL_SPACE)
				await this.rewriteInheritedLinks(current.title, newTitle, actor);
		}
		await this.afterWrite(space, actor, next.categories);
		await this.report(next, "updated", actor, renamed ? current.title : null);
		return publicNote(next);
	}

	/**
	 * A renamed global note keeps the links to it in every workspace that
	 * inherits it. A workspace that has its own note with either title keeps
	 * its links: they point at, or would land on, that workspace's note.
	 */
	private async rewriteInheritedLinks(
		from: string,
		to: string,
		actor: SynapseActor,
	) {
		const spaces = (await this.repository.spaceStats())
			.map((item) => item.space)
			.filter(inheritsGlobal);
		for (const space of spaces) {
			// Checked again before each note, so an override created during the
			// rename stops it in that workspace.
			const inherits = async () => {
				const [old, taken] = await Promise.all([
					this.repository.getNote(space, titleKey(from)),
					this.repository.getNote(space, titleKey(to)),
				]);
				return !old && !taken;
			};
			if (await inherits())
				await this.rewriteLinksTo(space, from, to, actor, inherits);
		}
	}

	/** Points every [[from]] link in a space at `to`, as a rename does. */
	relink(space: SynapseSpaceId, from: string, to: string, actor: SynapseActor) {
		return this.rewriteLinksTo(space, from, to, actor);
	}

	/** Rewrites [[Old]] links note by note; not a transaction (docs/SYNAPSE.md §3). */
	private async rewriteLinksTo(
		space: SynapseSpaceId,
		from: string,
		to: string,
		actor: SynapseActor,
		/** Checked before each note; false stops the rewrite. */
		proceed?: () => Promise<boolean>,
	) {
		const linked = await this.repository.findNotes(
			{ space, linkKey: titleKey(from) },
			{
				sort: { by: "updatedAt", direction: "asc" },
				limit: MAX_NOTES_PER_SPACE,
			},
		);
		for (const note of linked) {
			if (proceed && !(await proceed())) return;
			await this.change(
				space,
				note.title,
				(current) =>
					this.revise(
						current,
						current.title,
						rewritePropertyLinks(current.properties, from, to),
						rewriteLinks(current.body, from, to),
						actor,
					),
				true,
			).catch((error) => {
				if (!(error instanceof SynapseError && error.statusCode === 404))
					throw error;
			});
		}
	}

	async appendNote(
		space: SynapseSpaceId,
		title: string,
		request: AppendSynapseNoteRequest,
		actor: SynapseActor,
		/** Appends only to this revision; a missing or changed note is a conflict. */
		expectedRevision?: number,
	): Promise<{ note: SynapseNote; created: boolean }> {
		assertTitle(title);
		const text = assertAppendText(request.text);
		const existing = await this.readNote(space, titleKey(title));
		if (!existing && expectedRevision !== undefined) throw notFound(title);
		if (!existing) {
			const template = this.templateFor(request.template);
			const note = await this.createUnlessRaced(
				space,
				{
					title,
					template: template?.name,
					body: appendText(template?.body ?? "", text),
				},
				actor,
			);
			if (note) return { note, created: true };
		}
		const next = await this.change(space, title, (current) => {
			if (
				expectedRevision !== undefined &&
				current.revision !== expectedRevision
			)
				throw changed();
			return this.revise(
				current,
				current.title,
				current.properties,
				assertBody(appendText(current.body, text)),
				actor,
			);
		});
		await this.afterWrite(space, actor, next.categories);
		await this.report(next, "updated", actor);
		return { note: publicNote(next), created: false };
	}

	async deleteNote(
		space: SynapseSpaceId,
		title: string,
		actor: SynapseActor,
		/** Deletes only this revision; a newer one is a conflict. */
		expectedRevision?: number,
	): Promise<void> {
		const note = await this.mustGet(space, title);
		this.assertOwn(space, note);
		if (expectedRevision !== undefined && note.revision !== expectedRevision)
			throw changed();
		if (!(await this.repository.deleteNote(note.id, expectedRevision)))
			throw expectedRevision === undefined ? notFound(title) : changed();
		// The last record of a deleted note holds what was deleted.
		await this.remember(
			{
				...note,
				revision: note.revision + 1,
				updatedAt: this.now(),
				updatedBy: actor,
			},
			"deleted",
			note,
		);
		await this.touchSpace(space, actor);
		await this.report(note, "deleted", actor);
	}

	async query(
		space: SynapseSpaceId,
		query: SynapseQuery,
	): Promise<SynapseNoteList> {
		const limit = Math.min(
			MAX_QUERY_LIMIT,
			Math.max(1, Math.floor(query.limit ?? DEFAULT_QUERY_LIMIT)),
		);
		const offset = Math.max(0, Math.floor(query.offset ?? 0));
		const text = (query.text ?? "").trim().toLowerCase();
		const terms = text.split(/\s+/).filter((term) => term.length > 0);
		const filter: NoteFilter = { space };
		if (terms.length) filter.terms = terms;
		if (query.category) filter.categoryKey = titleKey(query.category.trim());
		if (query.tag)
			filter.tagPrefix = query.tag.trim().replace(/^#/, "").toLowerCase();
		if (query.linksTo) filter.linkKey = titleKey(query.linksTo.trim());
		if (query.where)
			filter.where = Object.entries(query.where).map(([k, value]) => ({
				k,
				v: propertyKeyValue(value),
			}));
		let sort = query.sort ?? (terms.length ? "relevance" : "updated");
		if (sort === "relevance" && !terms.length) sort = "updated";
		const direction = query.direction ?? (sort === "title" ? "asc" : "desc");
		const overrides = await this.overrides(space);
		const total = await this.countVisible(filter, overrides);
		let notes: StoredNote[];
		if (sort === "relevance") {
			const candidates = await this.readNotes(
				filter,
				{
					sort: { by: "updatedAt", direction: "desc" },
					limit: RELEVANCE_CANDIDATES,
				},
				overrides,
			);
			const scored = candidates.map((note) => ({
				note,
				score: relevance(note, terms, text),
			}));
			scored.sort(
				(a, b) =>
					b.score.exact - a.score.exact ||
					b.score.title - a.score.title ||
					b.score.hits - a.score.hits ||
					b.note.updatedAt.localeCompare(a.note.updatedAt) ||
					a.note.titleKey.localeCompare(b.note.titleKey),
			);
			if (direction === "asc") scored.reverse();
			notes = scored.slice(offset, offset + limit).map((item) => item.note);
		} else {
			notes = await this.readNotes(
				filter,
				{
					sort: {
						by:
							sort === "created"
								? "createdAt"
								: sort === "title"
									? "titleKey"
									: "updatedAt",
						direction,
					},
					limit,
					offset,
				},
				overrides,
			);
		}
		return { notes: notes.map((note) => summary(note, terms)), total };
	}

	async unresolved(
		space: SynapseSpaceId,
		limit = 50,
	): Promise<SynapseUnresolvedLink[]> {
		const index = await this.readIndex(space);
		const existing = new Set(index.map((entry) => entry.titleKey));
		const targets = new Map<string, SynapseUnresolvedLink>();
		for (const entry of index)
			entry.links.forEach((link, position) => {
				const key = entry.linkKeys[position];
				if (existing.has(key)) return;
				let target = targets.get(key);
				if (!target) {
					target = { title: link, count: 0, sources: [] };
					targets.set(key, target);
				}
				target.count++;
				if (target.sources.length < UNRESOLVED_SOURCES)
					target.sources.push(entry.title);
			});
		return [...targets.values()]
			.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
			.slice(0, Math.max(1, limit));
	}

	/**
	 * The space's notes and unresolved link targets as an undirected graph.
	 * Over `MAX_GRAPH_NODES`, the best-linked notes stay, then the best-linked
	 * targets, and `degree` counts only the links that stay with them.
	 */
	async graph(space: SynapseSpaceId): Promise<SynapseGraph> {
		const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
		// Sorted first, so "first-seen" spellings do not depend on storage order.
		const index = [...(await this.readIndex(space))].sort((a, b) =>
			order(a.titleKey, b.titleKey),
		);
		const notes = new Map(index.map((entry) => [entry.titleKey, entry]));
		const missing = new Map<string, string>();
		const neighbours = new Map<string, Set<string>>();
		const connect = (from: string, to: string) => {
			const linked = neighbours.get(from);
			if (linked) linked.add(to);
			else neighbours.set(from, new Set([to]));
		};
		for (const entry of index)
			entry.links.forEach((link, position) => {
				const key = entry.linkKeys[position];
				if (key === entry.titleKey) return;
				if (!notes.has(key) && !missing.has(key)) missing.set(key, link);
				connect(entry.titleKey, key);
				connect(key, entry.titleKey);
			});
		/** Keys with their neighbour counts, most-linked first. */
		const ranked = (
			keys: Iterable<string>,
			count: (linked: Set<string>) => number,
		) =>
			[...keys]
				.map((key) => ({
					key,
					degree: count(neighbours.get(key) ?? new Set()),
				}))
				.sort((a, b) => b.degree - a.degree || order(a.key, b.key));
		const rankedNotes = ranked(notes.keys(), (linked) => linked.size);
		const kept = new Set(
			rankedNotes.slice(0, MAX_GRAPH_NODES).map((item) => item.key),
		);
		// Unresolved targets take the room the notes leave, ranked by their
		// links from the notes that stay.
		const room = MAX_GRAPH_NODES - kept.size;
		const rankedTargets = ranked(
			missing.keys(),
			(linked) => [...linked].filter((key) => kept.has(key)).length,
		).filter((item) => item.degree > 0);
		for (const item of rankedTargets.slice(0, room)) kept.add(item.key);
		const keys = [...kept].sort(order);
		const title = (key: string) =>
			notes.get(key)?.title ?? (missing.get(key) as string);
		const links = (key: string) =>
			[...(neighbours.get(key) ?? [])].filter((other) => kept.has(other));
		return {
			nodes: keys.map((key): SynapseGraphNode => {
				const note = notes.get(key);
				return {
					title: title(key),
					exists: Boolean(note),
					...(note ? { space: publicSpaceId(note.space) } : {}),
					categories: note?.categories ?? [],
					tags: note?.tags ?? [],
					degree: links(key).length,
				};
			}),
			// Each pair once: from its earlier key to its later one.
			edges: keys.flatMap((key) =>
				links(key)
					.filter((other) => other > key)
					.sort(order)
					.map((other) => ({ source: title(key), target: title(other) })),
			),
			noteCount: index.length,
			truncated:
				rankedNotes.length > MAX_GRAPH_NODES || rankedTargets.length > room,
		};
	}

	async categories(space: SynapseSpaceId): Promise<SynapseCategory[]> {
		const index = await this.readIndex(space);
		const existing = new Set(index.map((entry) => entry.titleKey));
		const used = new Map<string, { title: string; count: number }>();
		for (const entry of index)
			entry.categories.forEach((category, position) => {
				const key = entry.categoryKeys[position];
				const current = used.get(key);
				if (current) current.count++;
				else used.set(key, { title: category, count: 1 });
			});
		for (const template of BUILTIN_TEMPLATES) {
			if (template.category === null) continue;
			const key = titleKey(template.category);
			if (existing.has(key) && !used.has(key))
				used.set(key, { title: template.category, count: 0 });
		}
		return [...used.entries()]
			.map(([key, item]): SynapseCategory => {
				const description = templateForCategory(item.title)?.description;
				return {
					title: item.title,
					count: item.count,
					...(description === undefined ? {} : { description }),
					exists: existing.has(key),
				};
			})
			.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
	}

	async daily(space: SynapseSpaceId, date: string): Promise<SynapseDaily> {
		if (!validDate(date))
			throw new SynapseError("Dates are written YYYY-MM-DD.", 400);
		const [note, entries] = await Promise.all([
			// The day note is the space's own: a global log is not a workspace's.
			this.repository.getNote(space, date),
			this.readDaily(space, date, dayRange(date, this.timeZone), DAILY_LIMIT),
		]);
		return {
			date,
			note: note ? publicNote(note) : null,
			entries: entries.map((entry) => summary(entry)),
		};
	}

	/** Appends `- HH:mm <text>` under `## Log` in today's daily note. */
	/**
	 * Creates a note for an append or log, or returns null when a concurrent
	 * write created it first, so the caller appends to that note instead.
	 */
	private async createUnlessRaced(
		space: SynapseSpaceId,
		request: CreateSynapseNoteRequest,
		actor: SynapseActor,
	): Promise<SynapseNote | null> {
		try {
			return await this.createNote(space, request, actor);
		} catch (error) {
			if (
				error instanceof SynapseError &&
				error.statusCode === 409 &&
				(await this.repository.getNote(space, titleKey(request.title)))
			)
				return null;
			throw error;
		}
	}

	async log(
		space: SynapseSpaceId,
		text: string,
		actor: SynapseActor,
	): Promise<SynapseNote> {
		const clean = assertAppendText(text).trim();
		if (!clean) throw new SynapseError("Text to log is required.");
		const line = `- ${localTime(this.clock(), this.timeZone)} ${clean}`;
		const today = this.today();
		const existing = await this.repository.getNote(space, today);
		if (!existing) {
			const note = await this.createUnlessRaced(
				space,
				{
					title: today,
					template: DAILY_TEMPLATE,
					body: appendLogLine("", line),
				},
				actor,
			);
			if (note) return note;
		}
		const next = await this.change(space, today, (current) =>
			this.revise(
				current,
				current.title,
				current.properties,
				assertBody(appendLogLine(current.body, line)),
				actor,
			),
		);
		await this.afterWrite(space, actor, next.categories);
		await this.report(next, "updated", actor);
		return publicNote(next);
	}

	async exportSpace(space: SynapseSpaceId): Promise<SynapseExport> {
		const notes = await this.repository.findNotes(
			{ space },
			{
				sort: { by: "titleKey", direction: "asc" },
				limit: MAX_NOTES_PER_SPACE,
			},
		);
		return {
			space: publicSpaceId(space),
			files: [
				...notes.map((note) => {
					const folder = exportFolder(note);
					return {
						path: `${folder ? `${folder}/` : ""}${note.title}.md`,
						content: renderMarkdown(note.properties, note.body),
					};
				}),
				...BUILTIN_TEMPLATES.map((template) => ({
					path: templateFileName(template),
					content: templateMarkdown(template),
				})),
			],
		};
	}

	async importSpace(
		space: SynapseSpaceId,
		request: SynapseImportRequest,
		actor: SynapseActor,
	): Promise<SynapseImportResult> {
		const result: SynapseImportResult = {
			created: [],
			updated: [],
			skipped: [],
		};
		const imported: StoredNote[] = [];
		const seen = new Set<string>();
		const categories = new Set<string>();
		let count = await this.repository.countNotes({ space });
		for (const file of request.files) {
			const skip = (reason: string) =>
				result.skipped.push({ path: file.path, reason });
			const segments = file.path
				.replaceAll("\\", "/")
				.split("/")
				.filter(Boolean);
			const name = segments.at(-1) ?? "";
			const folders = segments.slice(0, -1);
			if (folders.some((folder) => folder.startsWith("."))) {
				skip("Files in dot-folders such as .obsidian are not notes.");
				continue;
			}
			if (folders[0] === "Templates") {
				skip("Templates are built in and are not imported.");
				continue;
			}
			if (!/\.md$/i.test(name)) {
				skip("Only .md files become notes.");
				continue;
			}
			const title = name.slice(0, -3);
			const problem = titleProblem(title);
			if (problem) {
				skip(problem);
				continue;
			}
			const key = titleKey(title);
			if (seen.has(key)) {
				skip("Another file in this import has the same title.");
				continue;
			}
			seen.add(key);
			let properties: SynapseProperties;
			let body: string;
			try {
				const parsed = parseMarkdown(file.content);
				properties = validateProperties(parsed.properties);
				body = assertBody(parsed.body);
			} catch (error) {
				if (!(error instanceof SynapseError)) throw error;
				skip(error.message);
				continue;
			}
			const existing = await this.repository.getNote(space, key);
			if (existing) {
				// A category note Synapse generated and nobody has edited yields
				// to the real file, e.g. when an earlier import batch named the
				// category before this batch brought its note.
				const placeholder =
					existing.revision === 1 && existing.createdBy.kind === "system";
				if (!request.overwrite && !placeholder) {
					skip("A note with this title already exists.");
					continue;
				}
				const next = this.revise(
					existing,
					existing.title,
					properties,
					body,
					actor,
				);
				if (!(await this.repository.replaceNote(next, existing.revision))) {
					skip("This note changed during the import.");
					continue;
				}
				await this.remember(next, "updated", existing);
				imported.push(next);
				(placeholder ? result.created : result.updated).push(existing.title);
				for (const category of next.categories) categories.add(category);
				continue;
			}
			if (count >= MAX_NOTES_PER_SPACE) {
				skip(
					`A space holds at most ${MAX_NOTES_PER_SPACE.toLocaleString("en-US")} notes.`,
				);
				continue;
			}
			const note = this.newNote(space, title, properties, body, actor);
			if (!(await this.repository.insertNote(note))) {
				skip("A note with this title already exists.");
				continue;
			}
			await this.remember(note, "created");
			count++;
			imported.push(note);
			result.created.push(title);
			for (const category of note.categories) categories.add(category);
		}
		if (result.created.length || result.updated.length) {
			await this.afterWrite(space, actor, [...categories]);
			try {
				await this.onChange?.({
					space,
					actor,
					at: this.now(),
					kind: "imported",
					created: result.created.length,
					updated: result.updated.length,
				});
			} catch {
				// The notes are imported; whoever listens handles its own trouble.
			}
		}
		if (imported.length) {
			const lint = linkLinter(
				(await this.repository.scanNotes(space)).map((note) => note.title),
			);
			result.warnings = [];
			// Bound response size even for imports full of unique missing links.
			outer: for (const note of imported)
				for (const warning of lint([
					note.body,
					...propertyStrings(note.properties),
				])) {
					if (result.warnings.length === 100) {
						result.warningsTruncated = true;
						break outer;
					}
					result.warnings.push({ source: note.title, ...warning });
				}
		}
		return result;
	}

	async propose(
		author: SynapseActor,
		request: CreateSynapseProposalRequest,
		/** The shared space of the author's workspace. */
		space: SynapseSpaceId = SYNAPSE_SHARED_SPACE,
	): Promise<SynapseProposal> {
		if (!PROPOSAL_ACTIONS.includes(request.action))
			throw new SynapseError(
				"Proposals create, update, append, or delete a note.",
			);
		const title = assertTitle(request.title);
		const reason = assertReason(request.reason, "A proposal");
		const pending = await this.repository.countProposals({
			authorId: author.id,
			status: "pending",
		});
		if (pending >= MAX_PENDING_PROPOSALS)
			throw new SynapseError(
				`You have ${MAX_PENDING_PROPOSALS} pending proposals. Wait for a decision before proposing more.`,
			);
		// Proposals change the workspace's own notes. Creating a note with an
		// inherited title overrides the global note; the others need its own note.
		const existing = await this.repository.getNote(space, titleKey(title));
		if (!existing && request.action !== "create") {
			const global = await this.readNote(space, titleKey(title));
			if (global) throw inherited(global.title);
		}
		const proposal: SynapseProposal = {
			id: randomUUID(),
			space,
			action: request.action,
			title,
			reason,
			status: "pending",
			author,
			createdAt: this.now(),
			baseRevision: existing?.revision ?? null,
		};
		const properties =
			request.properties === undefined
				? undefined
				: validateProperties(request.properties);
		const body =
			request.body === undefined ? undefined : assertBody(request.body);
		switch (request.action) {
			case "create":
				if (existing)
					throw new SynapseError(
						`"${existing.title}" already exists in the shared space. Propose an update instead.`,
					);
				if (body === undefined && properties === undefined)
					throw new SynapseError(
						"A create proposal needs a body and/or properties.",
					);
				break;
			case "update": {
				if (!existing) throw notFound(title);
				const newTitle =
					request.newTitle === undefined
						? undefined
						: assertTitle(request.newTitle);
				if (
					newTitle === undefined &&
					body === undefined &&
					properties === undefined
				)
					throw new SynapseError(
						"An update proposal needs a new title, a body, and/or properties.",
					);
				if (newTitle !== undefined) proposal.newTitle = newTitle;
				break;
			}
			case "append":
				if (!existing) throw notFound(title);
				proposal.text = assertAppendText(request.text);
				break;
			case "delete":
				if (!existing) throw notFound(title);
				break;
		}
		if (request.action === "create" || request.action === "update") {
			if (body !== undefined) proposal.body = body;
			if (properties !== undefined) proposal.properties = properties;
		}
		await this.repository.insertProposal(proposal);
		return publicProposal(proposal);
	}

	async listProposals(filter: ProposalFilter): Promise<SynapseProposal[]> {
		return (await this.repository.listProposals(filter)).map(publicProposal);
	}
	countProposals(filter: ProposalFilter): Promise<number> {
		return this.repository.countProposals(filter);
	}
	/**
	 * The notes a workspace's shared space shows that changed last: its own,
	 * and Global's it does not override. Unlike `query`, it neither counts
	 * nor scans the space, so the dashboard can poll it.
	 */
	async recentNotes(
		shared: SynapseSpaceId,
		limit: number,
	): Promise<Array<{ title: string; updatedAt: string; global: boolean }>> {
		const latest = {
			sort: { by: "updatedAt" as const, direction: "desc" as const },
			limit,
		};
		const own = await this.repository.findNotes({ space: shared }, latest);
		// Global notes the workspace overrides are not visible in it, so page
		// through Global until enough visible ones are found, the pages reach
		// notes older than the workspace's own oldest shown, or Global ends.
		const global: StoredNote[] = [];
		if (shared !== SYNAPSE_GLOBAL_SPACE)
			for (let page = 0; page < RECENT_NOTES_PAGES; page++) {
				const candidates = await this.repository.findNotes(
					{ space: SYNAPSE_GLOBAL_SPACE },
					{ ...latest, offset: page * limit },
				);
				if (!candidates.length) break;
				const overridden = new Set(
					(
						await this.repository.findNotes(
							{
								space: shared,
								titleKeys: candidates.map((note) => note.titleKey),
							},
							{ ...latest, limit: candidates.length },
						)
					).map((note) => note.titleKey),
				);
				global.push(
					...candidates.filter((note) => !overridden.has(note.titleKey)),
				);
				const oldestShown =
					own.length === limit ? own[own.length - 1].updatedAt : "";
				if (
					global.length >= limit ||
					candidates.length < limit ||
					(candidates.at(-1)?.updatedAt ?? "") < oldestShown
				)
					break;
			}
		return [
			...own.map((note) => ({ note, global: false })),
			...global.map((note) => ({ note, global: true })),
		]
			.sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt))
			.slice(0, limit)
			.map(({ note, global }) => ({
				title: note.title,
				updatedAt: note.updatedAt,
				global,
			}));
	}
	async recentDecisions(
		space: SynapseSpaceId,
		limit: number,
	): Promise<SynapseProposal[]> {
		return (await this.repository.recentDecisions(space, limit)).map(
			publicProposal,
		);
	}

	/** Approval applies the change as the reviewer; see docs/SYNAPSE.md §7. */
	async decideProposal(
		id: string,
		request: DecideSynapseProposalRequest,
		actor: SynapseActor,
		/** The reviewer's workspace: another workspace's proposals are not found. */
		space?: SynapseSpaceId,
	): Promise<SynapseProposal> {
		const proposal = await this.repository.getProposal(id);
		if (!proposal || (space !== undefined && proposal.space !== space))
			throw new SynapseError("Proposal not found.", 404);
		if (proposal.status !== "pending")
			throw new SynapseError(
				`This proposal was already ${proposal.status}.`,
				409,
			);
		const busy = () =>
			new SynapseError(
				"Someone else is deciding this proposal. Reload it and try again.",
				409,
			);
		if (request.decision === "reject") {
			const reason = assertReason(request.reason, "Rejecting a proposal");
			const decided = await this.repository.decideProposal(
				id,
				{
					status: "rejected",
					decidedAt: this.now(),
					decidedBy: actor,
					decisionReason: reason,
				},
				{ now: this.now() },
			);
			if (!decided) throw busy();
			if (proposal.author.kind === "agent") {
				// The reason becomes a breadcrumb in the agent's own memory. A full
				// space must not undo the decision, so failures here are swallowed.
				const space = agentSpaceId(proposal.author.id);
				await this.log(
					space,
					`Proposal to ${proposal.action} [[${proposal.title}]] in the shared space was rejected by ${actor.name}: ${reason}`,
					actor,
				)
					// The space may not exist yet; it belongs to the author, not the reviewer.
					.then(() =>
						this.repository.upsertSpaceRecord(
							space,
							this.now(),
							proposal.author.name,
							proposal.author.name,
						),
					)
					.catch(() => {});
			}
		} else {
			// Hold a short claim while the change applies. The proposal stays
			// pending, so a crash mid-approval never records an unapplied change,
			// and a concurrent decision is refused until the claim ends or expires.
			const claim = {
				id: randomUUID(),
				until: new Date(this.clock() + PROPOSAL_CLAIM_MS).toISOString(),
			};
			if (!(await this.repository.claimProposal(id, claim, this.now())))
				throw busy();
			try {
				await this.applyProposal(proposal, actor);
			} catch (error) {
				// If the release fails too, the claim simply expires.
				await this.repository
					.releaseProposalClaim(id, claim.id)
					.catch(() => {});
				throw error;
			}
			const decided = await this.repository.decideProposal(
				id,
				{
					status: "approved",
					decidedAt: this.now(),
					decidedBy: actor,
					...(request.reason ? { decisionReason: request.reason } : {}),
				},
				{ now: this.now(), claimId: claim.id },
			);
			if (!decided)
				throw new SynapseError(
					"The change was applied, but the approval outlasted its claim and was decided by someone else.",
					409,
				);
		}
		return publicProposal((await this.repository.getProposal(id)) ?? proposal);
	}

	private async applyProposal(proposal: SynapseProposal, actor: SynapseActor) {
		const space = proposal.space;
		const stale = (why: string) =>
			new SynapseError(`${why} Reject the proposal or ask for a new one.`, 409);
		if (proposal.action === "create") {
			if (await this.repository.getNote(space, titleKey(proposal.title)))
				throw stale(`"${proposal.title}" now exists in the shared space.`);
			await this.createNote(
				space,
				{
					title: proposal.title,
					body: proposal.body,
					properties: proposal.properties,
				},
				actor,
			);
			return;
		}
		const note = await this.repository.getNote(space, titleKey(proposal.title));
		if (!note)
			throw stale(`"${proposal.title}" no longer exists in the shared space.`);
		if (note.revision !== proposal.baseRevision)
			throw stale(`"${proposal.title}" changed since this was proposed.`);
		switch (proposal.action) {
			case "update":
				await this.updateNote(
					space,
					proposal.title,
					{
						title: proposal.newTitle,
						body: proposal.body,
						properties: proposal.properties,
						revision: note.revision,
					},
					actor,
				);
				return;
			case "append":
				await this.appendNote(
					space,
					proposal.title,
					{ text: proposal.text ?? "" },
					actor,
					note.revision,
				);
				return;
			case "delete":
				await this.deleteNote(space, proposal.title, actor, note.revision);
				return;
		}
	}
}

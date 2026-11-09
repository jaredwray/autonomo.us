import { randomUUID } from "node:crypto";
import {
	type AppendSynapseNoteRequest,
	type CreateSynapseNoteRequest,
	type CreateSynapseProposalRequest,
	type DecideSynapseProposalRequest,
	SYNAPSE_GLOBAL_SPACE,
	SYNAPSE_SHARED_SPACE,
	SYNAPSE_SPACE_ID_PATTERN,
	type SynapseActor,
	type SynapseCategory,
	type SynapseDaily,
	type SynapseExport,
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
	type SynapseSpace,
	type SynapseSpaceId,
	type SynapseSpaceList,
	type SynapseTemplate,
	type SynapseUnresolvedLink,
	type UpdateSynapseNoteRequest,
} from "@autonomo.us/common";
import { SynapseError } from "./errors.js";
import {
	assertTitle,
	extractCategories,
	extractLinks,
	extractTags,
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
	SynapseRepository,
} from "./repository.js";
import { propertyKeyValue } from "./repository.js";
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
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;
const BACKLINK_LIMIT = 100;
const RELATED_LIMIT = 20;
const DAILY_LIMIT = 200;
const CATEGORY_MEMBER_LIMIT = 500;
const RELEVANCE_CANDIDATES = 1000;
const WRITE_ATTEMPTS = 5;
const UNRESOLVED_SOURCES = 5;
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
	const lines = body.split("\n");
	// Headings inside fenced code are text, not sections.
	// A block closes only on a bare fence of the same character, at least as
	// long as the opener (CommonMark), so ```ts inside a block stays content.
	const outside: boolean[] = [];
	let fence: { char: string; length: number } | null = null;
	for (const item of lines) {
		const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(item);
		outside.push(fence === null && !match);
		if (!match) continue;
		const [, marker, rest] = match;
		if (fence === null) fence = { char: marker[0], length: marker.length };
		else if (
			marker[0] === fence.char &&
			marker.length >= fence.length &&
			rest.trim() === ""
		)
			fence = null;
	}
	const heading = lines.findIndex(
		(item, index) => outside[index] && /^## Log\s*$/.test(item),
	);
	if (heading === -1) {
		const base = body.trimEnd();
		return `${base ? `${base}\n\n` : ""}## Log\n${line}`;
	}
	const next = lines.findIndex(
		(item, index) =>
			index > heading && outside[index] && /^#{1,2}\s/.test(item),
	);
	let end = next === -1 ? lines.length : next;
	while (end > heading + 1 && lines[end - 1].trim() === "") end--;
	// Blank lines before the next section stay; trailing ones go.
	lines.splice(end, next === -1 ? lines.length - end : 0, line);
	return lines.join("\n");
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
		snippet: snippet(note.body, terms),
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

export type SynapseServiceOptions = {
	/** IANA time zone deciding "today" for templates, daily notes, and the log. */
	timeZone: string;
	now?: () => number;
};

/** Synapse's behavior over a repository; see docs/SYNAPSE.md. */
export class SynapseService {
	readonly timeZone: string;
	private readonly clock: () => number;
	constructor(
		readonly repository: SynapseRepository,
		options: SynapseServiceOptions,
	) {
		this.timeZone = options.timeZone;
		this.clock = options.now ?? Date.now;
	}
	private now() {
		return new Date(this.clock()).toISOString();
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
	/** Titles a space defines itself; they override its parent's notes. */
	private async ownTitleKeys(space: SynapseSpaceId) {
		return (await this.repository.scanNotes(space)).map(
			(entry) => entry.titleKey,
		);
	}
	// Reads through inheritance: a space's own notes, then its parent's notes
	// whose titles it does not define. Writes always go to the space itself.
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
	private async readNotes(filter: NoteFilter, options: FindOptions) {
		const parent = this.parentOf(filter.space);
		if (!parent) return this.repository.findNotes(filter, options);
		const offset = options.offset ?? 0;
		const window = { sort: options.sort, limit: offset + options.limit };
		const [own, keys] = await Promise.all([
			this.repository.findNotes(filter, window),
			this.ownTitleKeys(filter.space),
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
	private async countVisible(filter: NoteFilter) {
		const parent = this.parentOf(filter.space);
		if (!parent) return this.repository.countNotes(filter);
		const [own, keys] = await Promise.all([
			this.repository.countNotes(filter),
			this.ownTitleKeys(filter.space),
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
			this.ownTitleKeys(space),
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
			await this.repository.insertNote(note);
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
				`Unknown template "${name}". See GET /v1/synapse/templates.`,
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
		await this.afterWrite(space, actor, note.categories);
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
		const [backlinks, members, index] = await Promise.all([
			this.readNotes(
				{ space, linkKey: note.titleKey },
				{ sort: { by: "updatedAt", direction: "desc" }, limit: BACKLINK_LIMIT },
			),
			this.readNotes(
				{ space, categoryKey: note.titleKey },
				{
					sort: { by: "titleKey", direction: "asc" },
					limit: CATEGORY_MEMBER_LIMIT,
				},
			),
			this.readIndex(space),
		]);
		const existing = new Set(index.map((entry) => entry.titleKey));
		return {
			note: publicNote(note),
			backlinks: backlinks.map((item) => summary(item)),
			outgoing: note.links.map((link) => ({
				title: link,
				exists: existing.has(titleKey(link)),
			})),
			related: await this.related(space, note, index),
			categoryMembers: members.map((item) => summary(item)),
			markdown: renderMarkdown(note.properties, note.body),
		};
	}

	/** Retries a compare-and-set change against a fresh copy of the note. */
	private async change(
		space: SynapseSpaceId,
		title: string,
		apply: (current: StoredNote) => StoredNote | Promise<StoredNote>,
	): Promise<StoredNote> {
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const current = await this.mustGet(space, title);
			this.assertOwn(space, current);
			const next = await apply(current);
			if (await this.repository.replaceNote(next, current.revision))
				return next;
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
		if (renamed) {
			await this.rewriteLinksTo(space, current.title, newTitle, actor);
			if (space === SYNAPSE_GLOBAL_SPACE)
				await this.rewriteInheritedLinks(current.title, newTitle, actor);
		}
		await this.afterWrite(space, actor, next.categories);
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
			const [old, taken] = await Promise.all([
				this.repository.getNote(space, titleKey(from)),
				this.repository.getNote(space, titleKey(to)),
			]);
			if (!old && !taken) await this.rewriteLinksTo(space, from, to, actor);
		}
	}

	/** Rewrites [[Old]] links note by note; not a transaction (docs/SYNAPSE.md §3). */
	private async rewriteLinksTo(
		space: SynapseSpaceId,
		from: string,
		to: string,
		actor: SynapseActor,
	) {
		const linked = await this.repository.findNotes(
			{ space, linkKey: titleKey(from) },
			{
				sort: { by: "updatedAt", direction: "asc" },
				limit: MAX_NOTES_PER_SPACE,
			},
		);
		for (const note of linked) {
			await this.change(space, note.title, (current) =>
				this.revise(
					current,
					current.title,
					rewritePropertyLinks(current.properties, from, to),
					rewriteLinks(current.body, from, to),
					actor,
				),
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
		await this.touchSpace(space, actor);
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
		const total = await this.countVisible(filter);
		let notes: StoredNote[];
		if (sort === "relevance") {
			const candidates = await this.readNotes(filter, {
				sort: { by: "updatedAt", direction: "desc" },
				limit: RELEVANCE_CANDIDATES,
			});
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
			notes = await this.readNotes(filter, {
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
			});
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
			this.readNote(space, date),
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
			count++;
			result.created.push(title);
			for (const category of note.categories) categories.add(category);
		}
		if (result.created.length || result.updated.length)
			await this.afterWrite(space, actor, [...categories]);
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

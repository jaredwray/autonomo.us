import { randomUUID } from "node:crypto";
import {
	type AppendBrainNoteRequest,
	BRAIN_SHARED_VAULT,
	BRAIN_VAULT_ID_PATTERN,
	type BrainActor,
	type BrainCategory,
	type BrainDaily,
	type BrainExport,
	type BrainImportRequest,
	type BrainImportResult,
	type BrainNote,
	type BrainNoteList,
	type BrainNoteSummary,
	type BrainNoteView,
	type BrainProperties,
	type BrainProposal,
	type BrainProposalAction,
	type BrainQuery,
	type BrainRelatedNote,
	type BrainTemplate,
	type BrainUnresolvedLink,
	type BrainVault,
	type BrainVaultId,
	type BrainVaultList,
	type CreateBrainNoteRequest,
	type CreateBrainProposalRequest,
	type DecideBrainProposalRequest,
	type UpdateBrainNoteRequest,
} from "@autonomo.us/common";
import { BrainError } from "./errors.js";
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
import type {
	BrainRepository,
	NoteFilter,
	NoteIndexEntry,
	PropertyIndexEntry,
	ProposalFilter,
	StoredNote,
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
export const MAX_NOTES_PER_VAULT = 10_000;
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
const PROPOSAL_ACTIONS: readonly BrainProposalAction[] = [
	"create",
	"update",
	"append",
	"delete",
];

export const SYSTEM_ACTOR: BrainActor = {
	kind: "system",
	id: "brain",
	name: "Brain",
};

const vaultPattern = new RegExp(BRAIN_VAULT_ID_PATTERN);

export function assertVaultId(id: string): BrainVaultId {
	if (!vaultPattern.test(id))
		throw new BrainError(
			'Vault IDs are "shared" or "agent-<agent token ID>".',
			400,
		);
	return id as BrainVaultId;
}

export const agentVaultId = (agentTokenId: string): BrainVaultId =>
	`agent-${agentTokenId}`;

const notFound = (title: string) =>
	new BrainError(`No note titled "${title}" in this vault.`, 404);
const titleTaken = (title: string) =>
	new BrainError(`A note titled "${title}" already exists.`, 409);
const changed = () =>
	new BrainError(
		"This note changed during your request. Reload it and try again.",
		409,
	);

function assertBody(body: unknown): string {
	if (typeof body !== "string")
		throw new BrainError("The body must be a string.");
	if (body.length > MAX_BODY_LENGTH)
		throw new BrainError(
			`Bodies are at most ${MAX_BODY_LENGTH.toLocaleString("en-US")} characters.`,
		);
	return body;
}

function assertAppendText(text: unknown): string {
	if (typeof text !== "string" || text.length === 0)
		throw new BrainError("Text to append is required.");
	if (text.length > MAX_APPEND_LENGTH)
		throw new BrainError(
			`An append adds at most ${MAX_APPEND_LENGTH.toLocaleString("en-US")} characters.`,
		);
	return text;
}

function assertReason(reason: unknown, what: string): string {
	if (typeof reason !== "string" || reason.trim().length === 0)
		throw new BrainError(`${what} needs a reason.`);
	if (reason.length > MAX_REASON_LENGTH)
		throw new BrainError(
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

function indexValues(properties: BrainProperties): PropertyIndexEntry[] {
	const out: PropertyIndexEntry[] = [];
	for (const [k, value] of Object.entries(properties)) {
		if (value === null) continue;
		if (Array.isArray(value))
			for (const item of value) out.push({ k, v: propertyKeyValue(item) });
		else out.push({ k, v: propertyKeyValue(value) });
	}
	return out;
}

function derive(title: string, properties: BrainProperties, body: string) {
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

export function publicNote(note: StoredNote): BrainNote {
	return {
		id: note.id,
		vault: note.vault,
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

function summary(note: StoredNote, terms: string[] = []): BrainNoteSummary {
	return {
		id: note.id,
		vault: note.vault,
		title: note.title,
		categories: note.categories,
		tags: note.tags,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
		revision: note.revision,
		snippet: snippet(note.body, terms),
	};
}

function occurrences(text: string, term: string) {
	let count = 0;
	let at = text.indexOf(term);
	while (at !== -1) {
		count++;
		at = text.indexOf(term, at + term.length);
	}
	return count;
}

/** Title matches first, then body hits, then recency; see docs/BRAIN.md §5. */
function relevance(note: StoredNote, terms: string[], text: string) {
	const title = note.titleKey;
	const body = note.body.toLowerCase();
	return {
		exact: title === text ? 1 : 0,
		title: terms.every((term) => title.includes(term)) ? 1 : 0,
		hits: terms.reduce((sum, term) => sum + occurrences(body, term), 0),
	};
}

export type BrainServiceOptions = {
	/** IANA time zone deciding "today" for templates, daily notes, and the log. */
	timeZone: string;
	now?: () => number;
};

/** The Brain's behavior over a repository; see docs/BRAIN.md. */
export class BrainService {
	readonly timeZone: string;
	private readonly clock: () => number;
	constructor(
		readonly repository: BrainRepository,
		options: BrainServiceOptions,
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

	templates(): BrainTemplate[] {
		return structuredClone(BUILTIN_TEMPLATES) as BrainTemplate[];
	}

	async listVaults(): Promise<BrainVaultList> {
		const [stats, records] = await Promise.all([
			this.repository.vaultStats(),
			this.repository.listVaultRecords(),
		]);
		const names = new Map(records.map((record) => [record.id, record.name]));
		const shared = stats.find((item) => item.vault === BRAIN_SHARED_VAULT);
		const vaults: BrainVault[] = [
			{
				id: BRAIN_SHARED_VAULT,
				kind: "shared",
				name: "Shared",
				noteCount: shared?.noteCount ?? 0,
				createdAt: shared?.createdAt ?? null,
				updatedAt: shared?.updatedAt ?? null,
			},
			...stats
				.filter(
					(item) => item.vault !== BRAIN_SHARED_VAULT && item.noteCount > 0,
				)
				.map(
					(item): BrainVault => ({
						id: item.vault,
						kind: "agent",
						name: names.get(item.vault) ?? item.vault,
						agentTokenId: item.vault.slice("agent-".length),
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
			vaults,
			persistence: this.repository.persistence,
			timeZone: this.timeZone,
		};
	}

	private newNote(
		vault: BrainVaultId,
		title: string,
		properties: BrainProperties,
		body: string,
		actor: BrainActor,
	): StoredNote {
		const at = this.now();
		return {
			id: randomUUID(),
			vault,
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
		properties: BrainProperties,
		body: string,
		actor: BrainActor,
	): StoredNote {
		return {
			...current,
			...derive(title, properties, body),
			updatedAt: this.now(),
			updatedBy: actor,
			revision: current.revision + 1,
		};
	}
	private async assertRoom(vault: BrainVaultId, adding = 1) {
		const count = await this.repository.countNotes({ vault });
		if (count + adding > MAX_NOTES_PER_VAULT)
			throw new BrainError(
				`A vault holds at most ${MAX_NOTES_PER_VAULT.toLocaleString("en-US")} notes.`,
			);
	}
	private async mustGet(vault: BrainVaultId, title: string) {
		const note = await this.repository.getNote(vault, titleKey(title));
		if (!note) throw notFound(title);
		return note;
	}
	private async touchVault(vault: BrainVaultId, actor: BrainActor) {
		const agent = vault !== BRAIN_SHARED_VAULT && actor.kind === "agent";
		await this.repository.upsertVaultRecord(
			vault,
			this.now(),
			agent ? actor.name : undefined,
			vault === BRAIN_SHARED_VAULT ? "Shared" : vault,
		);
	}
	/** Creates missing category notes, tagged `categories`, with the template's description. */
	private async ensureCategoryNotes(vault: BrainVaultId, categories: string[]) {
		for (const category of categories) {
			if (titleProblem(category)) continue;
			if (await this.repository.getNote(vault, titleKey(category))) continue;
			if ((await this.repository.countNotes({ vault })) >= MAX_NOTES_PER_VAULT)
				return;
			const template = templateForCategory(category);
			const note = this.newNote(
				vault,
				template?.category ?? category,
				{ tags: ["categories"] },
				template?.description ?? "",
				SYSTEM_ACTOR,
			);
			await this.repository.insertNote(note);
		}
	}
	private async afterWrite(
		vault: BrainVaultId,
		actor: BrainActor,
		categories: string[],
	) {
		await this.ensureCategoryNotes(vault, categories);
		await this.touchVault(vault, actor);
	}
	private templateFor(name: string | undefined) {
		if (name === undefined) return undefined;
		const template = findTemplate(name);
		if (!template)
			throw new BrainError(
				`Unknown template "${name}". See GET /v1/brain/templates.`,
			);
		return template;
	}

	async createNote(
		vault: BrainVaultId,
		request: CreateBrainNoteRequest,
		actor: BrainActor,
	): Promise<BrainNote> {
		const title = assertTitle(request.title);
		let properties: BrainProperties;
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
		await this.assertRoom(vault);
		const note = this.newNote(vault, title, properties, body, actor);
		if (!(await this.repository.insertNote(note))) throw titleTaken(title);
		await this.afterWrite(vault, actor, note.categories);
		return publicNote(note);
	}

	async getNote(vault: BrainVaultId, title: string): Promise<BrainNote> {
		return publicNote(await this.mustGet(vault, title));
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
		note: StoredNote,
		index: NoteIndexEntry[],
	): Promise<BrainRelatedNote[]> {
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
		const notes = await this.repository.findNotes(
			{
				vault: note.vault,
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

	async viewNote(vault: BrainVaultId, title: string): Promise<BrainNoteView> {
		const note = await this.mustGet(vault, title);
		const [backlinks, members, index] = await Promise.all([
			this.repository.findNotes(
				{ vault, linkKey: note.titleKey },
				{ sort: { by: "updatedAt", direction: "desc" }, limit: BACKLINK_LIMIT },
			),
			this.repository.findNotes(
				{ vault, categoryKey: note.titleKey },
				{
					sort: { by: "titleKey", direction: "asc" },
					limit: CATEGORY_MEMBER_LIMIT,
				},
			),
			this.repository.scanNotes(vault),
		]);
		const existing = new Set(index.map((entry) => entry.titleKey));
		return {
			note: publicNote(note),
			backlinks: backlinks.map((item) => summary(item)),
			outgoing: note.links.map((link) => ({
				title: link,
				exists: existing.has(titleKey(link)),
			})),
			related: await this.related(note, index),
			categoryMembers: members.map((item) => summary(item)),
			markdown: renderMarkdown(note.properties, note.body),
		};
	}

	/** Retries a compare-and-set change against a fresh copy of the note. */
	private async change(
		vault: BrainVaultId,
		title: string,
		apply: (current: StoredNote) => StoredNote | Promise<StoredNote>,
	): Promise<StoredNote> {
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const current = await this.mustGet(vault, title);
			const next = await apply(current);
			if (await this.repository.replaceNote(next, current.revision))
				return next;
		}
		throw changed();
	}

	async updateNote(
		vault: BrainVaultId,
		title: string,
		request: UpdateBrainNoteRequest,
		actor: BrainActor,
	): Promise<BrainNote> {
		const current = await this.mustGet(vault, title);
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
			if (await this.repository.getNote(vault, titleKey(newTitle)))
				throw titleTaken(newTitle);
			body = rewriteLinks(body, current.title, newTitle);
			properties = rewritePropertyLinks(properties, current.title, newTitle);
		}
		const next = this.revise(current, newTitle, properties, body, actor);
		if (!(await this.repository.replaceNote(next, current.revision)))
			throw renamed && (await this.repository.getNote(vault, next.titleKey))
				? titleTaken(newTitle)
				: changed();
		if (renamed)
			await this.rewriteLinksTo(vault, current.title, newTitle, actor);
		await this.afterWrite(vault, actor, next.categories);
		return publicNote(next);
	}

	/** Rewrites [[Old]] links note by note; not a transaction (docs/BRAIN.md §3). */
	private async rewriteLinksTo(
		vault: BrainVaultId,
		from: string,
		to: string,
		actor: BrainActor,
	) {
		const linked = await this.repository.findNotes(
			{ vault, linkKey: titleKey(from) },
			{
				sort: { by: "updatedAt", direction: "asc" },
				limit: MAX_NOTES_PER_VAULT,
			},
		);
		for (const note of linked) {
			await this.change(vault, note.title, (current) =>
				this.revise(
					current,
					current.title,
					rewritePropertyLinks(current.properties, from, to),
					rewriteLinks(current.body, from, to),
					actor,
				),
			).catch((error) => {
				if (!(error instanceof BrainError && error.statusCode === 404))
					throw error;
			});
		}
	}

	async appendNote(
		vault: BrainVaultId,
		title: string,
		request: AppendBrainNoteRequest,
		actor: BrainActor,
		/** Appends only to this revision; a missing or changed note is a conflict. */
		expectedRevision?: number,
	): Promise<{ note: BrainNote; created: boolean }> {
		assertTitle(title);
		const text = assertAppendText(request.text);
		const existing = await this.repository.getNote(vault, titleKey(title));
		if (!existing && expectedRevision !== undefined) throw notFound(title);
		if (!existing) {
			const template = this.templateFor(request.template);
			const note = await this.createUnlessRaced(
				vault,
				{
					title,
					template: template?.name,
					body: appendText(template?.body ?? "", text),
				},
				actor,
			);
			if (note) return { note, created: true };
		}
		const next = await this.change(vault, title, (current) => {
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
		await this.afterWrite(vault, actor, next.categories);
		return { note: publicNote(next), created: false };
	}

	async deleteNote(
		vault: BrainVaultId,
		title: string,
		actor: BrainActor,
		/** Deletes only this revision; a newer one is a conflict. */
		expectedRevision?: number,
	): Promise<void> {
		const note = await this.mustGet(vault, title);
		if (expectedRevision !== undefined && note.revision !== expectedRevision)
			throw changed();
		if (!(await this.repository.deleteNote(note.id, expectedRevision)))
			throw expectedRevision === undefined ? notFound(title) : changed();
		await this.touchVault(vault, actor);
	}

	async query(vault: BrainVaultId, query: BrainQuery): Promise<BrainNoteList> {
		const limit = Math.min(
			MAX_QUERY_LIMIT,
			Math.max(1, Math.floor(query.limit ?? DEFAULT_QUERY_LIMIT)),
		);
		const offset = Math.max(0, Math.floor(query.offset ?? 0));
		const text = (query.text ?? "").trim().toLowerCase();
		const terms = text.split(/\s+/).filter((term) => term.length > 0);
		const filter: NoteFilter = { vault };
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
		const total = await this.repository.countNotes(filter);
		let notes: StoredNote[];
		if (sort === "relevance") {
			const candidates = await this.repository.findNotes(filter, {
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
			notes = await this.repository.findNotes(filter, {
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
		vault: BrainVaultId,
		limit = 50,
	): Promise<BrainUnresolvedLink[]> {
		const index = await this.repository.scanNotes(vault);
		const existing = new Set(index.map((entry) => entry.titleKey));
		const targets = new Map<string, BrainUnresolvedLink>();
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

	async categories(vault: BrainVaultId): Promise<BrainCategory[]> {
		const index = await this.repository.scanNotes(vault);
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
			.map(([key, item]): BrainCategory => {
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

	async daily(vault: BrainVaultId, date: string): Promise<BrainDaily> {
		if (!validDate(date))
			throw new BrainError("Dates are written YYYY-MM-DD.", 400);
		const [note, entries] = await Promise.all([
			this.repository.getNote(vault, date),
			this.repository.findDailyNotes(
				vault,
				date,
				dayRange(date, this.timeZone),
				DAILY_LIMIT,
			),
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
		vault: BrainVaultId,
		request: CreateBrainNoteRequest,
		actor: BrainActor,
	): Promise<BrainNote | null> {
		try {
			return await this.createNote(vault, request, actor);
		} catch (error) {
			if (
				error instanceof BrainError &&
				error.statusCode === 409 &&
				(await this.repository.getNote(vault, titleKey(request.title)))
			)
				return null;
			throw error;
		}
	}

	async log(
		vault: BrainVaultId,
		text: string,
		actor: BrainActor,
	): Promise<BrainNote> {
		const clean = assertAppendText(text).trim();
		if (!clean) throw new BrainError("Text to log is required.");
		const line = `- ${localTime(this.clock(), this.timeZone)} ${clean}`;
		const today = this.today();
		const existing = await this.repository.getNote(vault, today);
		if (!existing) {
			const note = await this.createUnlessRaced(
				vault,
				{
					title: today,
					template: DAILY_TEMPLATE,
					body: appendLogLine("", line),
				},
				actor,
			);
			if (note) return note;
		}
		const next = await this.change(vault, today, (current) =>
			this.revise(
				current,
				current.title,
				current.properties,
				assertBody(appendLogLine(current.body, line)),
				actor,
			),
		);
		await this.afterWrite(vault, actor, next.categories);
		return publicNote(next);
	}

	async exportVault(vault: BrainVaultId): Promise<BrainExport> {
		const notes = await this.repository.findNotes(
			{ vault },
			{
				sort: { by: "titleKey", direction: "asc" },
				limit: MAX_NOTES_PER_VAULT,
			},
		);
		return {
			vault,
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

	async importVault(
		vault: BrainVaultId,
		request: BrainImportRequest,
		actor: BrainActor,
	): Promise<BrainImportResult> {
		const result: BrainImportResult = { created: [], updated: [], skipped: [] };
		const seen = new Set<string>();
		const categories = new Set<string>();
		let count = await this.repository.countNotes({ vault });
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
			let properties: BrainProperties;
			let body: string;
			try {
				const parsed = parseMarkdown(file.content);
				properties = validateProperties(parsed.properties);
				body = assertBody(parsed.body);
			} catch (error) {
				if (!(error instanceof BrainError)) throw error;
				skip(error.message);
				continue;
			}
			const existing = await this.repository.getNote(vault, key);
			if (existing) {
				if (!request.overwrite) {
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
				result.updated.push(existing.title);
				for (const category of next.categories) categories.add(category);
				continue;
			}
			if (count >= MAX_NOTES_PER_VAULT) {
				skip(
					`A vault holds at most ${MAX_NOTES_PER_VAULT.toLocaleString("en-US")} notes.`,
				);
				continue;
			}
			const note = this.newNote(vault, title, properties, body, actor);
			if (!(await this.repository.insertNote(note))) {
				skip("A note with this title already exists.");
				continue;
			}
			count++;
			result.created.push(title);
			for (const category of note.categories) categories.add(category);
		}
		if (result.created.length || result.updated.length)
			await this.afterWrite(vault, actor, [...categories]);
		return result;
	}

	async propose(
		author: BrainActor,
		request: CreateBrainProposalRequest,
	): Promise<BrainProposal> {
		if (!PROPOSAL_ACTIONS.includes(request.action))
			throw new BrainError(
				"Proposals create, update, append, or delete a note.",
			);
		const title = assertTitle(request.title);
		const reason = assertReason(request.reason, "A proposal");
		const pending = await this.repository.countProposals({
			authorId: author.id,
			status: "pending",
		});
		if (pending >= MAX_PENDING_PROPOSALS)
			throw new BrainError(
				`You have ${MAX_PENDING_PROPOSALS} pending proposals. Wait for a decision before proposing more.`,
			);
		const existing = await this.repository.getNote(
			BRAIN_SHARED_VAULT,
			titleKey(title),
		);
		const proposal: BrainProposal = {
			id: randomUUID(),
			vault: BRAIN_SHARED_VAULT,
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
					throw new BrainError(
						`"${existing.title}" already exists in the shared brain. Propose an update instead.`,
					);
				if (body === undefined && properties === undefined)
					throw new BrainError(
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
					throw new BrainError(
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
		return proposal;
	}

	async listProposals(filter: ProposalFilter): Promise<BrainProposal[]> {
		return this.repository.listProposals(filter);
	}

	/** Approval applies the change as the reviewer; see docs/BRAIN.md §7. */
	async decideProposal(
		id: string,
		request: DecideBrainProposalRequest,
		actor: BrainActor,
	): Promise<BrainProposal> {
		const proposal = await this.repository.getProposal(id);
		if (!proposal) throw new BrainError("Proposal not found.", 404);
		if (proposal.status !== "pending")
			throw new BrainError(
				`This proposal was already ${proposal.status}.`,
				409,
			);
		const busy = () =>
			new BrainError(
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
				// vault must not undo the decision, so failures here are swallowed.
				const vault = agentVaultId(proposal.author.id);
				await this.log(
					vault,
					`Proposal to ${proposal.action} [[${proposal.title}]] in the shared brain was rejected by ${actor.name}: ${reason}`,
					actor,
				)
					// The vault may not exist yet; it belongs to the author, not the reviewer.
					.then(() =>
						this.repository.upsertVaultRecord(
							vault,
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
				throw new BrainError(
					"The change was applied, but the approval outlasted its claim and was decided by someone else.",
					409,
				);
		}
		return (await this.repository.getProposal(id)) ?? proposal;
	}

	private async applyProposal(proposal: BrainProposal, actor: BrainActor) {
		const vault = BRAIN_SHARED_VAULT;
		const stale = (why: string) =>
			new BrainError(`${why} Reject the proposal or ask for a new one.`, 409);
		if (proposal.action === "create") {
			if (await this.repository.getNote(vault, titleKey(proposal.title)))
				throw stale(`"${proposal.title}" now exists in the shared brain.`);
			await this.createNote(
				vault,
				{
					title: proposal.title,
					body: proposal.body,
					properties: proposal.properties,
				},
				actor,
			);
			return;
		}
		const note = await this.repository.getNote(vault, titleKey(proposal.title));
		if (!note)
			throw stale(`"${proposal.title}" no longer exists in the shared brain.`);
		if (note.revision !== proposal.baseRevision)
			throw stale(`"${proposal.title}" changed since this was proposed.`);
		switch (proposal.action) {
			case "update":
				await this.updateNote(
					vault,
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
					vault,
					proposal.title,
					{ text: proposal.text ?? "" },
					actor,
					note.revision,
				);
				return;
			case "delete":
				await this.deleteNote(vault, proposal.title, actor, note.revision);
				return;
		}
	}
}

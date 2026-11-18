import type {
	SynapseActor,
	SynapseCaptureEntity,
	SynapseCaptureRequest,
	SynapseCaptureResult,
	SynapseCaptureUpdate,
	SynapseProperties,
	SynapseSpaceId,
} from "@autonomo.us/common";
import { SynapseError } from "./errors.js";
import {
	appendSectionLine,
	contentHash,
	evidenceLine,
	lineDiff,
	MENTIONS_HEADING,
	normalizeContent,
} from "./evidence.js";
import {
	assertTitle,
	DATE_PATTERN,
	PROPERTY_STRING_MAX_LENGTH,
	TITLE_MAX_LENGTH,
	titleKey,
	titleProblem,
} from "./markdown.js";
import type { NoteIndexEntry, StoredNote } from "./repository.js";
import { propertyKeyValue } from "./repository.js";
import {
	MAX_BODY_LENGTH,
	publicSpaceId,
	type SynapseService,
} from "./synapse.js";
import {
	findMentions,
	headingText,
	type Named,
	passageAround,
	STOP_WORDS,
	words,
} from "./text.js";

/** The most text one capture takes. Only the first `MAX_BODY_LENGTH` characters are kept. */
export const MAX_CAPTURE_LENGTH = 500_000;
/** Notes a capture reports as mentioned. */
export const MAX_CAPTURE_ENTITIES = 50;
/** Updates a capture prepares: one for each of the most-mentioned notes. */
export const MAX_CAPTURE_UPDATES = 20;
const SOURCES_KEY = "sources";
const TITLE_ATTEMPTS = 20;
const WRITE_ATTEMPTS = 3;
const DERIVED_TITLE_LENGTH = 120;

/** What is being captured, once the request is checked and any page is fetched. */
export type CaptureInput = {
	kind: "url" | "text" | "document";
	content: string;
	/** Where the content came from, without a fragment. */
	url: string | null;
	/** The title the caller asked for. */
	title?: string;
	/** A document's file name. */
	name?: string;
	apply: boolean;
};

/** The spaces a capture reads and writes besides the one it saves the source in. */
export type CaptureScope = {
	/** Spaces whose notes the source may mention too, such as the workspace's shared space. */
	read?: SynapseSpaceId[];
	/** With `apply`, updates to notes of this space are filed as proposals. */
	propose?: SynapseSpaceId;
};

/** The page address as it is stored and compared: http or https, no fragment. */
export function captureUrl(value: unknown): string {
	let url: URL;
	try {
		url = new URL(typeof value === "string" ? value.trim() : "");
	} catch {
		throw new SynapseError("The url must be a full http or https address.");
	}
	if (!/^https?:$/.test(url.protocol))
		throw new SynapseError("The url must be a full http or https address.");
	url.hash = "";
	if (url.href.length > PROPERTY_STRING_MAX_LENGTH)
		throw new SynapseError(
			`A url is at most ${PROPERTY_STRING_MAX_LENGTH.toLocaleString("en-US")} characters.`,
		);
	return url.href;
}

/** True when the request names a page and brings none of its text: someone has to fetch it. */
export const captureNeedsFetch = (request: SynapseCaptureRequest) =>
	request.url !== undefined &&
	request.text === undefined &&
	request.document === undefined;

/**
 * Checks a capture request and settles what it captures. `fetched` is the
 * page behind `url`, when the caller fetched it.
 */
export function captureInput(
	request: SynapseCaptureRequest,
	fetched?: { content: string; url: string },
): CaptureInput {
	const given = [request.text, request.document].filter(
		(item) => item !== undefined,
	).length;
	if (given > 1)
		throw new SynapseError(
			"Capture one thing at a time: a url, text, or a document.",
		);
	if (given === 0 && request.url === undefined)
		throw new SynapseError("Capture needs a url, text, or a document.");
	const title =
		request.title === undefined ? undefined : assertTitle(request.title);
	const apply = request.apply === true;
	const url = request.url === undefined ? null : captureUrl(request.url);
	if (request.document !== undefined) {
		const { name, content } = request.document as {
			name?: unknown;
			content?: unknown;
		};
		if (typeof name !== "string" || !name.trim() || name.length > 200)
			throw new SynapseError("A document needs a name of 1 to 200 characters.");
		if (typeof content !== "string")
			throw new SynapseError("A document needs its text in content.");
		return {
			kind: "document",
			content,
			url,
			name: name.trim(),
			apply,
			...(title ? { title } : {}),
		};
	}
	if (request.text !== undefined) {
		if (typeof request.text !== "string")
			throw new SynapseError("The text must be a string.");
		return {
			kind: url ? "url" : "text",
			content: request.text,
			url,
			apply,
			...(title ? { title } : {}),
		};
	}
	if (!fetched)
		throw new SynapseError(
			"This capture names a page but brings none of its text. Send the page's text along with the url.",
		);
	return {
		kind: "url",
		content: fetched.content,
		url: captureUrl(fetched.url),
		apply,
		...(title ? { title } : {}),
	};
}

/** Text made into a valid note title, or null when nothing usable is left. */
export function titleFrom(text: string): string | null {
	const cleaned = [
		...text
			.replace(/[\\/:*?"<>|#^[\]]/g, " ")
			.replace(/\p{Cc}/gu, " ")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/^\.+/, "")
			.trim(),
	]
		.slice(0, DERIVED_TITLE_LENGTH)
		.join("")
		.trim();
	return cleaned && !titleProblem(cleaned) ? cleaned : null;
}

const withoutExtension = (name: string) =>
	name.replace(/\.[A-Za-z0-9]{1,8}$/, "");

/** A title for content that came without one: its first heading, its address, or its first line. */
function deriveTitle(input: CaptureInput, body: string, today: string): string {
	const candidates: string[] = [];
	if (input.name) candidates.push(withoutExtension(input.name));
	if (input.kind !== "text")
		for (const line of body.slice(0, 4000).split("\n")) {
			const heading = headingText(line, 2);
			if (!heading) continue;
			candidates.push(heading);
			break;
		}
	if (input.url) {
		const url = new URL(input.url);
		candidates.push(`${url.hostname}${url.pathname.replace(/\/$/, "")}`);
	}
	candidates.push(body.split("\n").find((line) => line.trim()) ?? "");
	for (const candidate of candidates) {
		const title = titleFrom(candidate);
		if (title) return title;
	}
	return `Capture ${today}`;
}

const numbered = (title: string, attempt: number) => {
	if (attempt === 0) return title;
	const suffix = ` (${attempt + 1})`;
	return `${[...title].slice(0, TITLE_MAX_LENGTH - suffix.length).join("")}${suffix}`;
};

const isConflict = (error: unknown) =>
	error instanceof SynapseError && error.statusCode === 409;

/**
 * "Save to Synapse": keeps a page, some text, or a document as a source note,
 * finds the existing notes it mentions, and prepares a line for each. See
 * docs/SYNAPSE.md §14.
 */
export class SynapseCapture {
	constructor(private readonly synapse: SynapseService) {}

	async capture(
		space: SynapseSpaceId,
		input: CaptureInput,
		actor: SynapseActor,
		scope: CaptureScope = {},
	): Promise<SynapseCaptureResult> {
		const content = normalizeContent(input.content);
		if (!content) throw new SynapseError("There is nothing to capture.");
		if (content.length > MAX_CAPTURE_LENGTH)
			throw new SynapseError(
				`A capture is at most ${MAX_CAPTURE_LENGTH.toLocaleString("en-US")} characters. Capture a long document in sections.`,
			);
		const hash = contentHash(content);
		const truncated = content.length > MAX_BODY_LENGTH;
		const body = truncated ? content.slice(0, MAX_BODY_LENGTH) : content;
		const today = this.synapse.today();

		const indexes = await Promise.all(
			[space, ...(scope.read ?? [])].map((item) => this.synapse.index(item)),
		);
		const existing = await this.existing(space, input, hash);
		const mentioned = this.mentioned(body, indexes, existing?.titleKey);
		const topics = mentioned
			.slice(0, 30)
			.map((item) => `[[${item.entry.title}]]`);

		let source: StoredNote;
		let status: SynapseCaptureResult["source"]["status"];
		let diff: SynapseCaptureResult["source"]["diff"];
		if (existing && existing.properties.hash === hash) {
			source = existing;
			status = "unchanged";
		} else if (existing) {
			diff = lineDiff(existing.body, body);
			source = await this.rewrite(space, existing, actor, (current) => ({
				body,
				properties: {
					hash,
					recaptured: today,
					topics,
					...(truncated || current.properties.truncated !== undefined
						? { truncated }
						: {}),
				},
			}));
			status = "updated";
		} else {
			source = await this.create(
				space,
				input.title ?? deriveTitle(input, body, today),
				// An explicit title is the caller's choice: a clash is theirs to resolve.
				input.title === undefined,
				{
					kind: input.kind,
					...(input.url ? { url: input.url } : {}),
					...(input.name ? { file: input.name } : {}),
					hash,
					topics,
					...(truncated ? { truncated } : {}),
				},
				body,
				actor,
			);
			status = "created";
		}
		// Two captures of the same content can both find nothing and both
		// create. The earliest note for the content is the source; a capture
		// that made a later one takes it back, so the content is kept once.
		if (status === "created") {
			const [first] = await this.withHash(space, hash);
			if (first && first.id !== source.id) {
				await this.synapse
					.deleteNote(space, source.title, actor, source.revision)
					.catch(() => {});
				source = first;
				status = "unchanged";
			}
		}

		const entities = mentioned.slice(0, MAX_CAPTURE_ENTITIES).map(
			(item): SynapseCaptureEntity => ({
				title: item.entry.title,
				space: publicSpaceId(item.entry.space),
				categories: item.entry.categories,
				mentions: item.count,
				passage: item.passage,
			}),
		);
		const updates: SynapseCaptureUpdate[] = [];
		for (const item of mentioned.slice(0, MAX_CAPTURE_UPDATES))
			updates.push(
				await this.update(space, source, item, input.apply, actor, scope),
			);
		const proposalId =
			scope.propose &&
			source.space !== scope.propose &&
			updates.some((item) => item.state === "proposed")
				? await this.proposeSource(source, actor, scope.propose)
				: undefined;
		const captured =
			typeof source.properties.captured === "string" &&
			DATE_PATTERN.test(source.properties.captured)
				? source.properties.captured
				: null;
		const result: SynapseCaptureResult["source"] = {
			title: source.title,
			space: publicSpaceId(source.space),
			revision: source.revision,
			status,
			url:
				typeof source.properties.url === "string"
					? source.properties.url
					: null,
			hash,
			truncated,
			captured,
			...(diff ? { diff } : {}),
			...(proposalId ? { proposalId } : {}),
		};
		return {
			source: result,
			entities,
			updates,
			summary: summarize(result, entities.length, updates),
		};
	}

	/**
	 * The source note this capture is another version of: one with the same
	 * content, else the one for the same address, else the one with the title
	 * the caller named or the document's name.
	 */
	private async existing(
		space: SynapseSpaceId,
		input: CaptureInput,
		hash: string,
	): Promise<StoredNote | null> {
		const { repository } = this.synapse;
		const sources = (k: string, value: string) => this.sources(space, k, value);
		const [same] = await this.withHash(space, hash);
		if (same) return same;
		if (input.url) {
			// `where` compares without case; an address is the same only exactly.
			const at = (await sources("url", input.url)).find(
				(note) => note.properties.url === input.url,
			);
			if (at) return at;
		}
		const named =
			input.title ??
			(input.name ? titleFrom(withoutExtension(input.name)) : null);
		if (!named) return null;
		const note = await repository.getNote(space, titleKey(named));
		if (!note) return null;
		if (!note.categoryKeys.includes(SOURCES_KEY)) {
			if (input.title === undefined) return null;
			throw new SynapseError(
				`"${note.title}" already exists and is not a captured source. Capture under another title.`,
				409,
			);
		}
		return note;
	}

	/** The space's own source notes with a property value, the earliest first. */
	private sources(space: SynapseSpaceId, k: string, value: string) {
		return this.synapse.repository.findNotes(
			{
				space,
				categoryKey: SOURCES_KEY,
				where: [{ k, v: propertyKeyValue(value) }],
			},
			{ sort: { by: "createdAt", direction: "asc" }, limit: 20 },
		);
	}
	private withHash(space: SynapseSpaceId, hash: string) {
		return this.sources(space, "hash", hash);
	}

	/**
	 * Proposes the source itself for the shared space. An agent's source lives
	 * in its own space, which the shared space cannot see: without this, a
	 * line approved into a shared note would cite a note nobody there can open.
	 */
	private async proposeSource(
		source: StoredNote,
		actor: SynapseActor,
		shared: SynapseSpaceId,
	): Promise<string | undefined> {
		try {
			// A note with this title there already answers the link, or is in its way.
			if (await this.synapse.repository.getNote(shared, source.titleKey))
				return undefined;
			const mine = (
				await this.synapse.listProposals({
					authorId: actor.id,
					status: "pending",
				})
			).filter(
				(proposal) =>
					proposal.action === "create" &&
					titleKey(proposal.title) === source.titleKey,
			);
			const pending = mine.find((proposal) => proposal.body === source.body);
			// One filed for an earlier version does not hold what the lines
			// proposed now quote. It is taken back, so a reviewer cannot
			// approve the old text under lines that cite the new one.
			for (const stale of mine)
				if (stale !== pending)
					await this.synapse.withdrawProposal(
						stale.id,
						actor,
						"Withdrawn: the source was captured again and has changed. A newer proposal replaces this one.",
					);
			if (pending) return pending.id;
			return (
				await this.synapse.propose(
					actor,
					{
						action: "create",
						title: source.title,
						body: source.body,
						properties: source.properties,
						reason:
							"The source of the lines proposed for the notes it mentions, so they can be followed from the shared space.",
					},
					shared,
				)
			).id;
		} catch (error) {
			if (!(error instanceof SynapseError)) throw error;
			return undefined;
		}
	}

	private async create(
		space: SynapseSpaceId,
		title: string,
		renumber: boolean,
		properties: SynapseProperties,
		body: string,
		actor: SynapseActor,
	): Promise<StoredNote> {
		for (let attempt = 0; attempt < TITLE_ATTEMPTS; attempt++) {
			const candidate = numbered(title, attempt);
			// A title Global holds is taken here too: it would hide that note.
			if (renumber && (await this.synapse.findNote(space, candidate))) continue;
			try {
				await this.synapse.createNote(
					space,
					{ title: candidate, template: "Sources", properties, body },
					actor,
				);
			} catch (error) {
				if (renumber && isConflict(error)) continue;
				throw error;
			}
			const created = await this.synapse.repository.getNote(
				space,
				titleKey(candidate),
			);
			if (created) return created;
		}
		throw new SynapseError(
			`Too many sources are titled "${title}". Capture under another title.`,
			409,
		);
	}

	/**
	 * Changes a note against the revision read, working the change out again
	 * when someone else wrote first. `change` returns null when the note needs
	 * nothing, and the note is returned as it is.
	 */
	private async rewrite(
		space: SynapseSpaceId,
		note: StoredNote,
		actor: SynapseActor,
		change: (
			current: StoredNote,
		) => { body: string; properties?: SynapseProperties } | null,
	): Promise<StoredNote> {
		let current = note;
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const next = change(current);
			if (!next) return current;
			let written = true;
			try {
				await this.synapse.updateNote(
					space,
					current.title,
					{ ...next, revision: current.revision },
					actor,
				);
			} catch (error) {
				if (!isConflict(error)) throw error;
				written = false;
			}
			const stored = await this.synapse.repository.getNote(
				space,
				current.titleKey,
			);
			if (!stored)
				throw new SynapseError(
					`"${current.title}" was deleted during the capture.`,
					409,
				);
			if (written) return stored;
			current = stored;
		}
		throw new SynapseError(
			`"${current.title}" kept changing during the capture. Try again.`,
			409,
		);
	}

	/** The notes a text names, most-mentioned first, each with the text around its first mention. */
	private mentioned(
		body: string,
		indexes: NoteIndexEntry[][],
		sourceKey?: string,
	) {
		const names: Named<NoteIndexEntry>[] = [];
		const seen = new Set<string>();
		for (const index of indexes)
			for (const entry of index) {
				// The first space that has a title is the one the capturer means.
				if (seen.has(entry.titleKey)) continue;
				seen.add(entry.titleKey);
				if (
					entry.titleKey === sourceKey ||
					DATE_PATTERN.test(entry.title) ||
					entry.tagKeys.includes("categories") ||
					entry.tagKeys.includes("daily") ||
					entry.categoryKeys.includes(SOURCES_KEY)
				)
					continue;
				for (const name of [entry.titleKey, ...(entry.aliasKeys ?? [])])
					if (nameable(name)) names.push({ name, value: entry });
			}
		return findMentions(body, names)
			.sort(
				(a, b) =>
					b.count - a.count || a.value.titleKey.localeCompare(b.value.titleKey),
			)
			.map((mention) => ({
				entry: mention.value,
				count: mention.count,
				passage: passageAround(body, mention.start, mention.end),
			}));
	}

	/** Prepares the line a mentioned note gets, and writes or proposes it when asked. */
	private async update(
		space: SynapseSpaceId,
		source: StoredNote,
		item: { entry: NoteIndexEntry; passage: string },
		apply: boolean,
		actor: SynapseActor,
		scope: CaptureScope,
	): Promise<SynapseCaptureUpdate> {
		const { entry } = item;
		const line = evidenceLine({
			source: source.title,
			revision: source.revision,
			date: this.synapse.today(),
			passage: item.passage,
		});
		const update = (
			state: SynapseCaptureUpdate["state"],
			extra: Partial<SynapseCaptureUpdate> = {},
		): SynapseCaptureUpdate => ({
			title: entry.title,
			space: publicSpaceId(entry.space),
			text: line,
			state,
			...extra,
		});
		if (entry.linkKeys.includes(source.titleKey))
			return update("skipped", { detail: "It already links to this source." });
		if (!apply) return update("prepared");
		const withLine = (current: StoredNote) =>
			current.linkKeys.includes(source.titleKey)
				? null
				: { body: appendSectionLine(current.body, MENTIONS_HEADING, line) };
		try {
			const note = await this.synapse.repository.getNote(
				entry.space,
				entry.titleKey,
			);
			const change = note ? withLine(note) : null;
			if (!note || !change)
				return update("skipped", { detail: "It changed during the capture." });
			if (entry.space === space) {
				await this.rewrite(space, note, actor, withLine);
				return update("applied");
			}
			if (entry.space !== scope.propose)
				return update("skipped", {
					detail:
						entry.space === "global"
							? "It is inherited from the global Synapse, which this capture cannot change."
							: "It is in a space this capture cannot change.",
				});
			// The same line proposed before and not yet decided is not filed again.
			const reason = `The source [[${source.title}]] mentions this note.`;
			const lines = (
				await this.synapse.listProposals({
					authorId: actor.id,
					status: "pending",
				})
			).filter(
				(pending) =>
					pending.action === "update" &&
					titleKey(pending.title) === note.titleKey &&
					pending.reason === reason,
			);
			const waiting = lines.find((pending) => pending.body === change.body);
			// A line proposed for an earlier version of the source is taken back.
			for (const stale of lines)
				if (stale !== waiting)
					await this.synapse.withdrawProposal(
						stale.id,
						actor,
						"Withdrawn: the source was captured again and has changed. A newer proposal replaces this one.",
					);
			const proposal =
				waiting ??
				(await this.synapse.propose(
					actor,
					{
						action: "update",
						title: note.title,
						body: change.body,
						reason,
					},
					scope.propose,
				));
			return update("proposed", { proposalId: proposal.id });
		} catch (error) {
			if (!(error instanceof SynapseError)) throw error;
			// One note that cannot take its line does not undo the capture.
			return update("prepared", { detail: error.message });
		}
	}
}

/** Names worth looking for: not one short or ordinary word. */
function nameable(name: string): boolean {
	const parts = words(name);
	if (parts.length === 0) return false;
	if (parts.length > 1) return true;
	return parts[0].word.length >= 3 && !STOP_WORDS.has(parts[0].word);
}

function summarize(
	source: SynapseCaptureResult["source"],
	entities: number,
	updates: SynapseCaptureUpdate[],
): string {
	const count = (state: SynapseCaptureUpdate["state"]) =>
		updates.filter((item) => item.state === state).length;
	const plural = (total: number, one: string, many = `${one}s`) =>
		`${total} ${total === 1 ? one : many}`;
	const parts: string[] = [];
	if (source.status === "created")
		parts.push(`Saved "${source.title}" as a new source.`);
	else if (source.status === "updated")
		parts.push(
			`"${source.title}" changed since it was captured: ${plural(source.diff?.added ?? 0, "line")} added, ${source.diff?.removed ?? 0} removed. It is now revision ${source.revision}; its history keeps the version before.`,
		);
	else
		parts.push(
			`"${source.title}" was captured before${source.captured ? ` (${source.captured})` : ""} and has not changed, so nothing was saved again.`,
		);
	if (source.truncated)
		parts.push(
			`Only the first ${MAX_BODY_LENGTH.toLocaleString("en-US")} characters were kept.`,
		);
	parts.push(
		entities
			? `It mentions ${plural(entities, "existing note")}.`
			: "It mentions no existing notes.",
	);
	const states = (
		[
			["applied", "applied"],
			["proposed", "proposed for the shared space"],
			["prepared", "prepared"],
			["skipped", "skipped"],
		] as const
	)
		.filter(([state]) => count(state))
		.map(([state, label]) => `${count(state)} ${label}`);
	if (states.length) parts.push(`Updates: ${states.join(", ")}.`);
	if (source.proposalId)
		parts.push(
			"The source is proposed for the shared space too, so those lines can be followed there.",
		);
	return parts.join(" ");
}

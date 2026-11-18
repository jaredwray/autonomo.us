import type {
	SaveSynapseAnswerRequest,
	SynapseActor,
	SynapseNote,
	SynapsePassage,
	SynapsePassageStanding,
	SynapseRetrieval,
	SynapseRetrieveRequest,
	SynapseSpaceId,
} from "@autonomo.us/common";
import { titleFrom } from "./capture.js";
import { SynapseError } from "./errors.js";
import {
	cleanPassage,
	EVIDENCE_HEADING,
	evidenceLine,
	evidenceState,
	QUOTING_SECTIONS,
	standingOf,
} from "./evidence.js";
import {
	assertTitle,
	DATE_PATTERN,
	extractLinks,
	titleKey,
} from "./markdown.js";
import type { NoteIndexEntry, StoredNote } from "./repository.js";
import {
	MAX_BODY_LENGTH,
	publicSpaceId,
	type SynapseService,
} from "./synapse.js";
import { headingText, root, STOP_WORDS, stem, words } from "./text.js";
import { localDate, validDate } from "./time.js";

export const DEFAULT_PASSAGES = 8;
export const MAX_PASSAGES = 30;
export const MAX_QUESTION_LENGTH = 1000;
export const MAX_ANSWER_EVIDENCE = 20;
/** Words of a question that are matched; a longer question's later words are ignored. */
const MAX_TERMS = 24;
/** Notes read from each space for one question, the most recently changed first. */
const CANDIDATES = 300;
/** Passages from one note in an answer, so one long note does not crowd out the rest. */
const PER_NOTE = 2;
/** About how long a passage is; a longer paragraph is cut at a sentence. */
const PASSAGE_LENGTH = 600;
/** The best-matching notes whose links are followed. */
const EXPAND_FROM = 5;
/** What a note reached through a link scores, against the note it was reached from. */
const LINK_WEIGHT = 0.35;
const BM25_K = 1.2;
const BM25_B = 0.75;
const TITLE_WEIGHT = 1.5;
/** Dates a note may carry, in the order they are preferred. */
const DATE_PROPERTIES = ["date", "published", "start", "created"];

type Term = { word: string; stem: string; root: string };
type Piece = { heading: string | null; text: string };

/** The question's meaningful words, each once. */
export function questionTerms(question: string): Term[] {
	const seen = new Set<string>();
	const terms: Term[] = [];
	for (const { word } of words(question)) {
		if (STOP_WORDS.has(word) || word.length < 2) continue;
		const stemmed = stem(word);
		if (seen.has(stemmed)) continue;
		seen.add(stemmed);
		terms.push({ word, stem: stemmed, root: root(word) });
		if (terms.length === MAX_TERMS) break;
	}
	return terms;
}

/** A body as passages: its paragraphs, each under the heading it sits below. */
export function passagesOf(body: string): Piece[] {
	const pieces: Piece[] = [];
	let heading: string | null = null;
	let paragraph: string[] = [];
	let fenced = false;
	const flush = () => {
		const text = paragraph.join("\n").trim();
		paragraph = [];
		if (!text) return;
		// A long paragraph is cut where a sentence or a line ends.
		let rest = text;
		while (rest.length > PASSAGE_LENGTH * 1.5) {
			const window = rest.slice(0, PASSAGE_LENGTH);
			const cut = Math.max(
				window.lastIndexOf("\n"),
				window.lastIndexOf(". "),
				window.lastIndexOf("? "),
				window.lastIndexOf("! "),
			);
			const at = cut > PASSAGE_LENGTH / 3 ? cut + 1 : PASSAGE_LENGTH;
			pieces.push({ heading, text: rest.slice(0, at).trim() });
			rest = rest.slice(at).trim();
		}
		if (rest) pieces.push({ heading, text: rest });
	};
	for (const line of body.split("\n")) {
		if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
			fenced = !fenced;
			paragraph.push(line);
			continue;
		}
		if (fenced) {
			paragraph.push(line);
			continue;
		}
		const title = headingText(line);
		if (title !== null) {
			flush();
			heading = title || null;
			continue;
		}
		if (line.trim() === "") flush();
		else paragraph.push(line);
	}
	flush();
	return pieces;
}

const datesIn = (text: string) => [
	...new Set((text.match(/\d{4}-\d{2}-\d{2}/g) ?? []).filter(validDate)),
];

/** How far a note can be trusted, from its status and the space it lives in. */
export function passageStanding(
	note: Pick<StoredNote, "space" | "properties" | "categoryKeys">,
): SynapsePassageStanding {
	// Keeping a page in the team's canon does not make what it says the team's.
	if (note.categoryKeys.some((key) => key === "sources" || key === "clippings"))
		return "source";
	const standing = standingOf(note.properties);
	if (standing.status === "superseded") return "superseded";
	if (standing.status === "disputed") return "disputed";
	if (standing.draft) return "draft";
	return note.space.startsWith("agent-") ? "unreviewed" : "approved";
}

/** A superseded decision still answers "what did we used to think", so it ranks low instead of vanishing. */
const STANDING_WEIGHT: Record<SynapsePassageStanding, number> = {
	approved: 1,
	unreviewed: 1,
	source: 1,
	disputed: 0.8,
	draft: 0.6,
	superseded: 0.3,
};

type Scored = {
	note: StoredNote;
	piece: Piece;
	score: number;
	matched: Set<string>;
};

/**
 * Finds the passages that bear on a question and saves the answers built
 * from them. Matching is by word stems and aliases, ranked like BM25, and
 * widened through the notes' links; see docs/SYNAPSE.md §16.
 */
export class SynapseRetriever {
	constructor(private readonly synapse: SynapseService) {}

	/** Cited passages for a question from the given spaces, best first. */
	async retrieve(
		spaces: SynapseSpaceId[],
		request: SynapseRetrieveRequest,
		/** Each space's own titles, when the caller has read them already. */
		shown?: Map<SynapseSpaceId, string[] | null>,
	): Promise<SynapseRetrieval> {
		const question =
			typeof request.question === "string" ? request.question.trim() : "";
		if (!question) throw new SynapseError("A question is required.");
		if (question.length > MAX_QUESTION_LENGTH)
			throw new SynapseError(
				`A question is at most ${MAX_QUESTION_LENGTH.toLocaleString("en-US")} characters.`,
			);
		const terms = questionTerms(question);
		if (!terms.length)
			throw new SynapseError(
				"Ask with at least one word that says what the question is about.",
			);
		const limit = Math.min(
			MAX_PASSAGES,
			Math.max(1, Math.floor(request.limit ?? DEFAULT_PASSAGES)),
		);
		const anyTerms = [...new Set(terms.map((term) => term.root))];
		const notes = (
			await Promise.all(
				spaces.map((space) =>
					this.synapse.find(
						{ space, anyTerms },
						{
							sort: { by: "updatedAt", direction: "desc" },
							limit: CANDIDATES,
						},
						shown?.get(space),
					),
				),
			)
		).flat();

		const scored = this.score(notes, terms);
		const matchedStems = new Set(scored.flatMap((item) => [...item.matched]));
		const direct: Scored[] = [];
		const perNote = new Map<string, number>();
		for (const item of scored) {
			const taken = perNote.get(item.note.id) ?? 0;
			if (taken >= PER_NOTE) continue;
			perNote.set(item.note.id, taken + 1);
			direct.push(item);
			if (direct.length === limit) break;
		}

		// Follow the best notes' links: the project a matching decision is
		// about answers part of the question without sharing its words.
		const linked = await this.linked(spaces, direct, notes);
		// Linked passages take up to a quarter of the answer, and never all of it.
		const room = Math.min(
			linked.passages.length,
			Math.ceil(limit / 4),
			limit - 1,
		);
		const kept = [
			...direct.slice(0, limit - room).map((item) => this.passage(item, terms)),
			...linked.passages.slice(0, room),
		].sort((a, b) => b.score - a.score);
		return {
			question,
			passages: kept,
			missing: terms
				.filter((term) => !matchedStems.has(term.stem))
				.map((term) => term.word),
			unresolved: linked.unresolved,
			searched: notes.length,
		};
	}

	/** Every matching passage of the candidate notes, best first. */
	private score(notes: StoredNote[], terms: Term[]): Scored[] {
		const stems = new Map(terms.map((term) => [term.stem, term]));
		const pieces = notes.flatMap((note) => {
			const parts = passagesOf(note.body);
			// A note that matches only by its title or properties is still an answer.
			return (parts.length ? parts : [{ heading: null, text: "" }]).map(
				(piece) => {
					const counts = new Map<string, number>();
					let length = 0;
					for (const { word } of words(piece.text)) {
						length++;
						const stemmed = stem(word);
						if (stems.has(stemmed))
							counts.set(stemmed, (counts.get(stemmed) ?? 0) + 1);
					}
					return { note, piece, counts, length };
				},
			);
		});
		const named = new Map(
			notes.map((note) => [
				note.id,
				new Set(
					words([note.title, ...(note.aliasKeys ?? [])].join(" ")).map(
						({ word }) => stem(word),
					),
				),
			]),
		);
		const total = pieces.length || 1;
		const average =
			pieces.reduce((sum, item) => sum + item.length, 0) / total || 1;
		const idf = new Map(
			terms.map((term) => {
				const containing = pieces.filter(
					(item) =>
						item.counts.has(term.stem) ||
						named.get(item.note.id)?.has(term.stem),
				).length;
				return [
					term.stem,
					Math.log(1 + (total - containing + 0.5) / (containing + 0.5)),
				];
			}),
		);
		const first = new Set<string>();
		const scored: Scored[] = [];
		for (const item of pieces) {
			const matched = new Set<string>();
			let score = 0;
			for (const [stemmed, count] of item.counts) {
				matched.add(stemmed);
				score +=
					((idf.get(stemmed) ?? 0) * (count * (BM25_K + 1))) /
					(count + BM25_K * (1 - BM25_B + (BM25_B * item.length) / average));
			}
			// A note named after what was asked is about it: its opening passage
			// carries the title's weight, and so does any passage that matched.
			const opening = !first.has(item.note.id);
			first.add(item.note.id);
			if (opening || matched.size)
				for (const stemmed of named.get(item.note.id) ?? [])
					if (stems.has(stemmed)) {
						matched.add(stemmed);
						score += TITLE_WEIGHT * (idf.get(stemmed) ?? 0);
					}
			if (!matched.size) continue;
			scored.push({
				note: item.note,
				piece: item.piece,
				// A passage that covers more of the question beats one that repeats a word.
				score:
					score *
					(1 + (0.5 * matched.size) / terms.length) *
					STANDING_WEIGHT[passageStanding(item.note)],
				matched,
			});
		}
		return scored.sort(
			(a, b) =>
				b.score - a.score ||
				b.note.updatedAt.localeCompare(a.note.updatedAt) ||
				a.note.titleKey.localeCompare(b.note.titleKey),
		);
	}

	private passage(item: Scored, terms: Term[]): SynapsePassage {
		return {
			...this.cited(item.note, item.piece),
			score: Math.round(item.score * 1000) / 1000,
			matched: terms
				.filter((term) => item.matched.has(term.stem))
				.map((term) => term.word),
			via: "text",
		};
	}

	private cited(
		note: StoredNote,
		piece: Piece,
	): Omit<SynapsePassage, "score" | "matched" | "via"> {
		const own = DATE_PROPERTIES.map((key) => note.properties[key]).find(
			(value): value is string =>
				typeof value === "string" && DATE_PATTERN.test(value),
		);
		return {
			title: note.title,
			space: publicSpaceId(note.space),
			heading: piece.heading,
			text: piece.text,
			categories: note.categories,
			date: own ?? localDate(Date.parse(note.updatedAt), this.synapse.timeZone),
			dates: datesIn(piece.text),
			// What a note quotes from a source is the source's words, not the note's.
			standing: QUOTING_SECTIONS.includes(piece.heading ?? "")
				? "source"
				: passageStanding(note),
			revision: note.revision,
			updatedAt: note.updatedAt,
		};
	}

	/**
	 * The notes the best matches link to or are linked from, and the links
	 * among those matches that lead to no note yet.
	 */
	private async linked(
		spaces: SynapseSpaceId[],
		direct: Scored[],
		candidates: StoredNote[],
	): Promise<{ passages: SynapsePassage[]; unresolved: string[] }> {
		const top: Scored[] = [];
		for (const item of direct) {
			if (top.some((seen) => seen.note.id === item.note.id)) continue;
			top.push(item);
			if (top.length === EXPAND_FROM) break;
		}
		if (!top.length) return { passages: [], unresolved: [] };
		const indexes = new Map<SynapseSpaceId, NoteIndexEntry[]>();
		for (const space of spaces)
			if (top.some((item) => this.shownIn(space, item.note)))
				indexes.set(space, await this.synapse.index(space));
		const have = new Set(candidates.map((note) => note.id));
		const wanted = new Map<
			string,
			{ space: SynapseSpaceId; entry: NoteIndexEntry; from: Scored }
		>();
		const unresolved = new Map<string, string>();
		for (const item of top)
			for (const [space, index] of indexes) {
				if (!this.shownIn(space, item.note)) continue;
				const byKey = new Map(index.map((entry) => [entry.titleKey, entry]));
				const neighbours: NoteIndexEntry[] = [];
				// Links written in the body are things someone meant to describe;
				// a property's `[[Active]]` or `[[Draft]]` is a value, not a gap.
				const written = new Set(extractLinks([item.note.body]).map(titleKey));
				item.note.links.forEach((link, position) => {
					const key = item.note.linkKeys[position];
					const entry = byKey.get(key);
					if (entry) neighbours.push(entry);
					else if (written.has(key) && !unresolved.has(key))
						unresolved.set(key, link);
				});
				for (const entry of index)
					if (entry.linkKeys.includes(item.note.titleKey))
						neighbours.push(entry);
				for (const entry of neighbours)
					if (
						!have.has(entry.id) &&
						!wanted.has(entry.id) &&
						!entry.tagKeys.includes("categories") &&
						!entry.tagKeys.includes("daily")
					)
						wanted.set(entry.id, { space, entry, from: item });
			}
		const passages: SynapsePassage[] = [];
		const bySpace = new Map<SynapseSpaceId, string[]>();
		for (const { space, entry } of wanted.values())
			bySpace.set(space, [...(bySpace.get(space) ?? []), entry.titleKey]);
		for (const [space, titleKeys] of bySpace) {
			const notes = await this.synapse.find(
				{ space, titleKeys: titleKeys.slice(0, MAX_PASSAGES) },
				{ sort: { by: "updatedAt", direction: "desc" }, limit: MAX_PASSAGES },
			);
			for (const note of notes) {
				const from = wanted.get(note.id)?.from;
				const piece = passagesOf(note.body)[0];
				if (!from || !piece) continue;
				passages.push({
					...this.cited(note, piece),
					score:
						Math.round(
							from.score *
								LINK_WEIGHT *
								STANDING_WEIGHT[passageStanding(note)] *
								1000,
						) / 1000,
					matched: [],
					via: "link",
					from: from.note.title,
				});
			}
		}
		return {
			passages: passages.sort((a, b) => b.score - a.score),
			unresolved: [...unresolved.values()].slice(0, 20),
		};
	}

	/** Whether a space shows this note: its own, or one it inherits from Global. */
	private shownIn(space: SynapseSpaceId, note: StoredNote) {
		return (
			note.space === space ||
			(note.space === "global" && !space.startsWith("agent-"))
		);
	}

	/**
	 * Saves an answer as a draft in the Answers category. Each piece of
	 * evidence must quote a source note of the same space; the answer's
	 * `## Evidence` section links them, so the sources list it as a backlink.
	 */
	async saveAnswer(
		space: SynapseSpaceId,
		request: SaveSynapseAnswerRequest,
		actor: SynapseActor,
	): Promise<SynapseNote> {
		const question =
			typeof request.question === "string"
				? request.question.replace(/\s+/g, " ").trim()
				: "";
		if (!question) throw new SynapseError("An answer needs its question.");
		if (question.length > MAX_QUESTION_LENGTH)
			throw new SynapseError(
				`A question is at most ${MAX_QUESTION_LENGTH.toLocaleString("en-US")} characters.`,
			);
		const answer =
			typeof request.answer === "string" ? request.answer.trim() : "";
		if (!answer) throw new SynapseError("An answer is required.");
		const evidence = Array.isArray(request.evidence) ? request.evidence : [];
		if (!evidence.length)
			throw new SynapseError(
				"An answer needs evidence: at least one source note and the words it relies on.",
			);
		if (evidence.length > MAX_ANSWER_EVIDENCE)
			throw new SynapseError(
				`An answer cites at most ${MAX_ANSWER_EVIDENCE} passages.`,
			);
		const title =
			request.title === undefined
				? titleFrom(question)
				: assertTitle(request.title);
		if (!title)
			throw new SynapseError(
				"Give the answer a title: the question cannot be made into one.",
			);
		const today = this.synapse.today();
		const lines: string[] = [];
		const sources: string[] = [];
		for (const item of evidence) {
			const source = await this.synapse.findNote(
				space,
				assertTitle(item?.source),
			);
			if (!source)
				throw new SynapseError(
					`No note titled "${item.source}" in this space to cite.`,
					404,
				);
			const passage = cleanPassage(
				typeof item.passage === "string" ? item.passage : "",
			);
			if (evidenceState(passage, source.body) !== "verified")
				throw new SynapseError(
					passage
						? `"${source.title}" does not contain the passage cited from it. Quote its words exactly.`
						: `Quote the words of "${source.title}" the answer relies on.`,
				);
			lines.push(
				evidenceLine({
					source: source.title,
					revision: source.revision,
					date: today,
					passage,
				}),
			);
			if (!sources.some((seen) => titleKey(seen) === source.titleKey))
				sources.push(source.title);
		}
		const body = `${answer}\n\n## ${EVIDENCE_HEADING}\n${lines.join("\n")}`;
		if (body.length > MAX_BODY_LENGTH)
			throw new SynapseError(
				`An answer with its evidence is at most ${MAX_BODY_LENGTH.toLocaleString("en-US")} characters.`,
			);
		return this.synapse.createNote(
			space,
			{
				title,
				template: "Answers",
				body,
				properties: {
					question: question.slice(0, 2000),
					sources: sources.map((source) => `[[${source}]]`),
				},
			},
			actor,
		);
	}

	/**
	 * A person approves a draft answer: its status becomes `[[Approved]]`,
	 * with who approved it and when.
	 */
	async approveAnswer(
		space: SynapseSpaceId,
		title: string,
		actor: SynapseActor,
	): Promise<SynapseNote> {
		const note = await this.synapse.findNote(space, title);
		if (!note)
			throw new SynapseError(`No note titled "${title}" in this space.`, 404);
		if (!note.categoryKeys.includes("answers"))
			throw new SynapseError(
				`"${note.title}" is not an answer: only notes in the Answers category are approved this way.`,
			);
		return this.synapse.updateNote(
			space,
			note.title,
			{
				properties: {
					status: ["[[Approved]]"],
					approved: this.synapse.today(),
					approved_by: actor.name.slice(0, 200),
				},
				revision: note.revision,
			},
			actor,
		);
	}
}

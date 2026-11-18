/**
 * Words, stems, and names in text: what capture uses to find the notes a
 * source mentions and retrieval uses to match a question to passages. All of
 * it is plain string work, so it runs the same in Node and in a Worker.
 */

/** A word keeps inner apostrophes, periods, and hyphens: "Node.js", "O'Brien", "follow-up". */
const WORD = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;

export type Word = { word: string; start: number; end: number };

/** The words of `text`, lowercased, with where each one sits. */
export function words(text: string): Word[] {
	const out: Word[] = [];
	for (const match of text.matchAll(WORD))
		out.push({
			word: match[0].toLowerCase(),
			start: match.index,
			end: match.index + match[0].length,
		});
	return out;
}

/** Words that say nothing about what a question or a note is about. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
	[
		"a an and are as at be been but by can could did do does for from had has have",
		"he her his how i if in into is it its me my no not of on or our she should so",
		"than that the their them then there these they this those to was we were what",
		"when where which who whom why will with would you your about after all also",
		"any because before both each more most other some such up out over under again",
		"am being during here just now only own same too very s t don",
	]
		.join(" ")
		.split(" "),
);

const undouble = (word: string) =>
	/([^aeiouylsz])\1$/.test(word) ? word.slice(0, -1) : word;

/**
 * A light English stemmer: plurals, -ing, -ed, -ly, and a final e or y. It
 * is deliberately small. "pricing", "prices", and "priced" share the stem
 * "pric"; it does not relate "decide" to "decision".
 */
export function stem(word: string): string {
	let stemmed = word;
	if (stemmed.length <= 3 || /\d/.test(stemmed)) return stemmed;
	if (stemmed.endsWith("ies") && stemmed.length > 4)
		stemmed = `${stemmed.slice(0, -3)}y`;
	else if (stemmed.endsWith("sses")) stemmed = stemmed.slice(0, -2);
	else if (stemmed.endsWith("s") && !/(ss|us|is)$/.test(stemmed))
		stemmed = stemmed.slice(0, -1);
	if (stemmed.endsWith("ing") && stemmed.length > 5)
		stemmed = undouble(stemmed.slice(0, -3));
	else if (stemmed.endsWith("ed") && stemmed.length > 4)
		stemmed = undouble(stemmed.slice(0, -2));
	else if (stemmed.endsWith("ly") && stemmed.length > 4)
		stemmed = stemmed.slice(0, -2);
	if (stemmed.length > 3 && stemmed.endsWith("e"))
		stemmed = stemmed.slice(0, -1);
	if (stemmed.length > 3 && stemmed.endsWith("y"))
		stemmed = `${stemmed.slice(0, -1)}i`;
	return stemmed;
}

/**
 * The letters a word shares with its stem, at least three: a substring that
 * every form of the word contains, for narrowing a search in storage.
 */
export function root(word: string): string {
	let stemmed = stem(word);
	// The stem writes a final y as i ("policy", "polici"); neither form has the other's last letter.
	if (stemmed.length > 3 && stemmed.endsWith("i"))
		stemmed = stemmed.slice(0, -1);
	let shared = 0;
	while (
		shared < word.length &&
		shared < stemmed.length &&
		word[shared] === stemmed[shared]
	)
		shared++;
	return word.slice(0, Math.max(shared, Math.min(3, word.length)));
}

/** A note that text may mention, by its title or one of its aliases. */
export type Named<T> = { name: string; value: T };

export type Mention<T> = {
	value: T;
	/** Times the text names it. */
	count: number;
	/** Where the first mention starts and ends. */
	start: number;
	end: number;
};

/**
 * Finds which of `names` a text mentions, whole words only and whatever the
 * case. Where two names start at the same word, the longer one wins, so
 * "Ada Lovelace" is not also counted as "Ada". One pass over the text.
 */
export function findMentions<T>(text: string, names: Named<T>[]): Mention<T>[] {
	const byFirst = new Map<string, Array<{ words: string[]; value: T }>>();
	for (const { name, value } of names) {
		const parts = words(name).map((item) => item.word);
		if (!parts.length) continue;
		const list = byFirst.get(parts[0]);
		if (list) list.push({ words: parts, value });
		else byFirst.set(parts[0], [{ words: parts, value }]);
	}
	for (const list of byFirst.values())
		list.sort((a, b) => b.words.length - a.words.length);
	const found = new Map<T, Mention<T>>();
	const tokens = words(text);
	for (let index = 0; index < tokens.length; index++) {
		const candidates = byFirst.get(tokens[index].word);
		if (!candidates) continue;
		const match = candidates.find(
			(candidate) =>
				index + candidate.words.length <= tokens.length &&
				candidate.words.every(
					(word, offset) => tokens[index + offset].word === word,
				),
		);
		if (!match) continue;
		const last = tokens[index + match.words.length - 1];
		const mention = found.get(match.value);
		if (mention) mention.count++;
		else
			found.set(match.value, {
				value: match.value,
				count: 1,
				start: tokens[index].start,
				end: last.end,
			});
		index += match.words.length - 1;
	}
	return [...found.values()];
}

/** The line around a position, cut to about `length` characters centred on it. */
export function passageAround(
	text: string,
	start: number,
	end: number,
	length = 240,
): string {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const lineEnd = text.indexOf("\n", end);
	const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
	if (line.length <= length) return line.trim();
	const at = start - lineStart;
	const from = Math.max(
		0,
		Math.min(at - Math.floor(length / 3), line.length - length),
	);
	return line.slice(from, from + length).trim();
}

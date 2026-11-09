import {
	SYNAPSE_ATTACHMENT_EXTENSIONS,
	type SynapseProperties,
	type SynapsePropertyValue,
} from "@autonomo.us/common";
import { SynapseError } from "./errors.js";

export const TITLE_MAX_LENGTH = 200;
/** `__proto__` would replace a plain object's prototype instead of becoming a key. */
export const PROPERTY_KEY_PATTERN =
	/^(?!__proto__$)[A-Za-z0-9_][A-Za-z0-9_ .-]*$/;
export const PROPERTY_KEY_MAX_LENGTH = 64;
export const MAX_PROPERTIES = 50;
export const PROPERTY_STRING_MAX_LENGTH = 2000;
export const PROPERTY_LIST_MAX_ITEMS = 100;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Obsidian's file name and link restrictions. */
const FORBIDDEN_TITLE_CHARS = /[\\/:*?"<>|#^[\]]/;
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * Link targets with these extensions are attachments, not notes. Only known
 * attachment formats count so titles like "Node.js" still link.
 */
const ATTACHMENT_EXTENSIONS = new Set(SYNAPSE_ATTACHMENT_EXTENSIONS);

/** Returns why `title` is not a valid note title, or null when it is. */
export function titleProblem(title: unknown): string | null {
	if (typeof title !== "string" || title.length === 0)
		return "A title is required.";
	if ([...title].length > TITLE_MAX_LENGTH)
		return `Titles are at most ${TITLE_MAX_LENGTH} characters.`;
	if (title !== title.trim())
		return "Titles cannot start or end with whitespace.";
	if (title.startsWith(".")) return "Titles cannot start with a period.";
	if (FORBIDDEN_TITLE_CHARS.test(title))
		return 'Titles cannot contain \\ / : * ? " < > | # ^ [ or ].';
	if (CONTROL_CHARS.test(title))
		return "Titles cannot contain control characters.";
	return null;
}

export function assertTitle(title: unknown): string {
	const problem = titleProblem(title);
	if (problem) throw new SynapseError(problem);
	return title as string;
}

export const titleKey = (title: string) => title.toLowerCase();

type Segment = { text: string; code: boolean };

/**
 * Splits Markdown into prose and code (fenced blocks and inline spans), so
 * links and tags inside code are never read as links and tags.
 */
export function segments(text: string): Segment[] {
	const out: Segment[] = [];
	const lines = text.split("\n");
	let prose: string[] = [];
	let fence: { char: string; length: number } | null = null;
	let code: string[] = [];
	const flushProse = () => {
		if (prose.length) out.push(...inlineSegments(prose.join("")));
		prose = [];
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const suffix = index < lines.length - 1 ? "\n" : "";
		if (fence) {
			code.push(line + suffix);
			const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
			if (
				close &&
				close[1][0] === fence.char &&
				close[1].length >= fence.length
			) {
				out.push({ text: code.join(""), code: true });
				code = [];
				fence = null;
			}
			continue;
		}
		const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (
			open &&
			(open[1][0] === "~" || !line.slice(open[0].length).includes("`"))
		) {
			flushProse();
			fence = { char: open[1][0], length: open[1].length };
			code.push(line + suffix);
			continue;
		}
		prose.push(line + suffix);
	}
	flushProse();
	if (code.length) out.push({ text: code.join(""), code: true });
	return out;
}

function inlineSegments(text: string): Segment[] {
	const out: Segment[] = [];
	let cursor = 0;
	const opener = /`+/g;
	let match = opener.exec(text);
	while (match) {
		const run = match[0];
		const start = match.index;
		const closeAt = findBacktickRun(text, run.length, start + run.length);
		if (closeAt === -1) {
			opener.lastIndex = start + run.length;
			match = opener.exec(text);
			continue;
		}
		if (start > cursor)
			out.push({ text: text.slice(cursor, start), code: false });
		cursor = closeAt + run.length;
		out.push({ text: text.slice(start, cursor), code: true });
		opener.lastIndex = cursor;
		match = opener.exec(text);
	}
	if (cursor < text.length) out.push({ text: text.slice(cursor), code: false });
	return out;
}

/** Index of the next backtick run of exactly `length`, or -1. */
function findBacktickRun(text: string, length: number, from: number) {
	const runs = /`+/g;
	runs.lastIndex = from;
	let match = runs.exec(text);
	while (match) {
		if (match[0].length === length) return match.index;
		match = runs.exec(text);
	}
	return -1;
}

const LINK = /(!?)\[\[([^[\]\n]*)\]\]/g;

/** The note a wikilink's inner text points at, or null for attachments and empty targets. */
export function linkTarget(inner: string): string | null {
	// In a table, Obsidian writes [[Note\\|alias]]; the backslash escapes the pipe.
	let target = inner.split("|")[0].replace(/\\$/, "").split("#")[0].trim();
	// Obsidian links may carry a folder path; titles never contain "/".
	target = target.split("/").filter(Boolean).at(-1) ?? "";
	target = target.replace(/\.md$/i, "").trim();
	if (!target) return null;
	const extension = /\.([A-Za-z0-9]{1,8})$/.exec(target)?.[1].toLowerCase();
	if (extension && ATTACHMENT_EXTENSIONS.has(extension)) return null;
	return target;
}

function proseOf(text: string) {
	return segments(text)
		.filter((segment) => !segment.code)
		.map((segment) => segment.text);
}

/** Link targets in first-seen spelling, deduplicated case-insensitively. */
export function extractLinks(texts: string[]): string[] {
	const seen = new Map<string, string>();
	for (const text of texts)
		for (const prose of proseOf(text))
			for (const match of prose.matchAll(LINK)) {
				const target = linkTarget(match[2]);
				if (target && !seen.has(titleKey(target)))
					seen.set(titleKey(target), target);
			}
	return [...seen.values()];
}

const TAG_CHARS = "[\\p{L}\\p{N}_\\-/\\p{Extended_Pictographic}\\u200d\\ufe0f]";
const INLINE_TAG = new RegExp(`(?<=^|\\s)#(${TAG_CHARS}+)`, "gmu");

/** Tags from the `tags` property and inline #tags, lowercased and deduplicated. */
export function extractTags(
	body: string,
	properties: SynapseProperties,
): string[] {
	const tags = new Set<string>();
	const declared = properties.tags;
	const fromProperty =
		typeof declared === "string"
			? [declared]
			: Array.isArray(declared)
				? declared
				: [];
	for (const tag of fromProperty) {
		const clean = tag.trim().replace(/^#/, "").toLowerCase();
		if (clean) tags.add(clean);
	}
	for (const prose of proseOf(body))
		for (const match of prose.matchAll(INLINE_TAG)) {
			const tag = match[1];
			if (/[^\p{N}]/u.test(tag)) tags.add(tag.toLowerCase());
		}
	return [...tags];
}

/** Link targets of the `categories` property, in order. */
export function extractCategories(properties: SynapseProperties): string[] {
	const value = properties.categories;
	const texts =
		typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	return extractLinks(texts);
}

/** Every string a property holds, for link extraction and search. */
export function propertyStrings(properties: SynapseProperties): string[] {
	const out: string[] = [];
	for (const value of Object.values(properties)) {
		if (typeof value === "string") out.push(value);
		else if (Array.isArray(value)) out.push(...value);
	}
	return out;
}

/**
 * Rewrites every [[Old…]] link (any casing of Old) to [[New…]], keeping the
 * embed `!`, `#heading`, and `|alias`. Code is left alone, as links there
 * were never links.
 */
export function rewriteLinks(text: string, from: string, to: string): string {
	const fromKey = titleKey(from);
	return segments(text)
		.map((segment) =>
			segment.code
				? segment.text
				: segment.text.replace(LINK, (whole, embed: string, inner: string) => {
						const target = linkTarget(inner);
						if (!target || titleKey(target) !== fromKey) return whole;
						const split = inner.search(/\\\||[#|]/);
						return `${embed}[[${to}${split === -1 ? "" : inner.slice(split)}]]`;
					}),
		)
		.join("");
}

export function rewritePropertyLinks(
	properties: SynapseProperties,
	from: string,
	to: string,
): SynapseProperties {
	const out: SynapseProperties = {};
	for (const [key, value] of Object.entries(properties)) {
		if (typeof value === "string") out[key] = rewriteLinks(value, from, to);
		else if (Array.isArray(value))
			out[key] = value.map((item) => rewriteLinks(item, from, to));
		else out[key] = value;
	}
	return out;
}

/** Validates property keys and values; returns a copy with the stored shape. */
export function validateProperties(input: unknown): SynapseProperties {
	if (input === null || typeof input !== "object" || Array.isArray(input))
		throw new SynapseError("Properties must be an object.");
	const entries = Object.entries(input as Record<string, unknown>);
	if (entries.length > MAX_PROPERTIES)
		throw new SynapseError(`Notes have at most ${MAX_PROPERTIES} properties.`);
	const out: SynapseProperties = {};
	for (const [key, value] of entries) {
		if (key.length > PROPERTY_KEY_MAX_LENGTH || !PROPERTY_KEY_PATTERN.test(key))
			throw new SynapseError(
				`Property key "${key.slice(0, 40)}" must be 1–${PROPERTY_KEY_MAX_LENGTH} characters of letters, digits, spaces, "_", ".", or "-", and start with a letter, digit, or "_".`,
			);
		out[key] = validatePropertyValue(key, value);
	}
	return out;
}

function validatePropertyValue(
	key: string,
	value: unknown,
): SynapsePropertyValue {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new SynapseError(`Property "${key}" must be a finite number.`);
		return value;
	}
	if (typeof value === "string") {
		if (value.length > PROPERTY_STRING_MAX_LENGTH)
			throw new SynapseError(
				`Property "${key}" is longer than ${PROPERTY_STRING_MAX_LENGTH} characters.`,
			);
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > PROPERTY_LIST_MAX_ITEMS)
			throw new SynapseError(
				`Property "${key}" has more than ${PROPERTY_LIST_MAX_ITEMS} items.`,
			);
		return value.map((item) => {
			if (typeof item !== "string")
				throw new SynapseError(`Property "${key}" must be a list of strings.`);
			if (item.length > PROPERTY_STRING_MAX_LENGTH)
				throw new SynapseError(
					`An item of property "${key}" is longer than ${PROPERTY_STRING_MAX_LENGTH} characters.`,
				);
			return item;
		});
	}
	throw new SynapseError(
		`Property "${key}" must be a string, number, boolean, null, or list of strings.`,
	);
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const PLAIN_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** Whether YAML reads `value` back as the same string when written bare. */
function plainScalar(value: string) {
	if (DATE_PATTERN.test(value)) return true;
	if (!value || value !== value.trim()) return false;
	if (PLAIN_START.test(value)) return false;
	if (value.includes(": ") || value.includes(" #")) return false;
	if (/[\n\r\t]/.test(value)) return false;
	if (["true", "false", "null", "~"].includes(value)) return false;
	if (NUMBER.test(value)) return false;
	return true;
}

function renderScalar(
	value: string | number | boolean | null,
	raw?: Set<string>,
) {
	if (value === null) return "";
	if (typeof value !== "string") return String(value);
	if (raw?.has(value) || plainScalar(value)) return value;
	return JSON.stringify(value);
}

/**
 * YAML frontmatter for `properties` in stored order, or "" when there are
 * none. Strings in `raw` are written bare (templates keep `{{date}}` as is).
 */
export function renderFrontmatter(
	properties: SynapseProperties,
	raw?: Set<string>,
): string {
	const keys = Object.keys(properties);
	if (keys.length === 0) return "";
	const lines = ["---"];
	for (const key of keys) {
		const value = properties[key];
		if (Array.isArray(value)) {
			if (value.length === 0) lines.push(`${key}: []`);
			else {
				lines.push(`${key}:`);
				for (const item of value) lines.push(`  - ${renderScalar(item, raw)}`);
			}
		} else {
			const scalar = renderScalar(value, raw);
			lines.push(scalar ? `${key}: ${scalar}` : `${key}:`);
		}
	}
	lines.push("---");
	return `${lines.join("\n")}\n`;
}

export function renderMarkdown(
	properties: SynapseProperties,
	body: string,
	raw?: Set<string>,
): string {
	const frontmatter = renderFrontmatter(properties, raw);
	// An empty block keeps a body that opens with a rule from reading as frontmatter.
	if (!frontmatter && /^\uFEFF?---[ \t]*(?:\r\n?|\n|$)/.test(body))
		return `---\n---\n${body}`;
	return frontmatter + body;
}

export class FrontmatterError extends SynapseError {
	constructor(message: string, line: number) {
		super(`${message} (frontmatter line ${line})`, 400);
	}
}

type Scalar = string | number | boolean | null;

function parseQuoted(text: string, line: number): string {
	if (text.startsWith('"')) {
		if (text.length < 2 || !text.endsWith('"'))
			throw new FrontmatterError("Unterminated double-quoted string", line);
		try {
			return JSON.parse(text) as string;
		} catch {
			throw new FrontmatterError(
				"Invalid escape in double-quoted string",
				line,
			);
		}
	}
	if (text.length < 2 || !text.endsWith("'"))
		throw new FrontmatterError("Unterminated single-quoted string", line);
	const inner = text.slice(1, -1);
	if (/(^|[^'])'([^']|$)/.test(inner))
		throw new FrontmatterError("Unterminated single-quoted string", line);
	return inner.replaceAll("''", "'");
}

function stripComment(text: string) {
	const at = text.indexOf(" #");
	return (at === -1 ? text : text.slice(0, at)).trim();
}

function parseScalar(text: string, line: number): Scalar {
	const value = text.trim();
	if (value === "") return null;
	if (value.startsWith('"') || value.startsWith("'"))
		return parseQuoted(value, line);
	if (value.startsWith("|") || value.startsWith(">"))
		throw new FrontmatterError(
			"Block scalars (| and >) are not supported",
			line,
		);
	if (value.startsWith("&") || value.startsWith("*"))
		throw new FrontmatterError("Anchors and aliases are not supported", line);
	if (value.startsWith("!"))
		throw new FrontmatterError("YAML tags are not supported", line);
	if (value.startsWith("{") && value !== "{{date}}")
		throw new FrontmatterError("Nested mappings are not supported", line);
	const bare = stripComment(value);
	if (bare === "true") return true;
	if (bare === "false") return false;
	if (bare === "null" || bare === "~") return null;
	if (NUMBER.test(bare)) return Number(bare);
	return bare;
}

/** List items keep their written text; non-strings become their string form. */
function listItem(text: string, line: number): string {
	const value = parseScalar(text, line);
	if (typeof value === "string") return value;
	if (value === null) return stripComment(text.trim());
	return String(value);
}

function splitFlow(text: string, line: number): string[] {
	const items: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			current += char;
			if (char === "\\" && quote === '"' && index + 1 < text.length)
				current += text[++index];
			else if (char === quote) quote = null;
		} else if (char === '"' || char === "'") {
			quote = char;
			current += char;
		} else if (char === ",") {
			items.push(current);
			current = "";
		} else if (char === "[" || char === "{")
			throw new FrontmatterError("Nested collections are not supported", line);
		else current += char;
	}
	if (quote) throw new FrontmatterError("Unterminated quoted string", line);
	items.push(current);
	return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Splits an Obsidian file into properties and body. The frontmatter block
 * starts with `---` on the first line and ends at the next line that is
 * exactly `---`; see docs/SYNAPSE.md §8 for the supported YAML subset.
 */
export function parseMarkdown(markdown: string): {
	properties: SynapseProperties;
	body: string;
} {
	const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	const fence = (line: string) => line.trimEnd() === "---";
	if (!fence(lines[0])) return { properties: {}, body: text };
	const end = lines.findIndex((line, index) => index > 0 && fence(line));
	if (end === -1)
		throw new FrontmatterError("Frontmatter block is never closed", 1);
	const properties: SynapseProperties = {};
	let pending: { key: string; line: number } | null = null;
	for (let index = 1; index < end; index++) {
		const line = lines[index];
		const number = index + 1;
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const item =
			/^\s+-(?:\s+(.*)|\s*)$/.exec(line) ?? /^-(?:\s+(.*)|\s*)$/.exec(line);
		if (item) {
			if (!pending)
				throw new FrontmatterError("List item without a property", number);
			const current = properties[pending.key];
			const list = Array.isArray(current) ? current : [];
			list.push(listItem(item[1] ?? "", number));
			properties[pending.key] = list;
			continue;
		}
		if (/^\s/.test(line))
			throw new FrontmatterError("Nested mappings are not supported", number);
		// A scan, not a regex: a lazy key plus \s* backtracks quadratically on
		// a long line without a colon, which import would let anyone send.
		const colon = line.indexOf(":");
		const after = colon === -1 ? "" : line.slice(colon + 1);
		if (colon <= 0 || (after !== "" && !/^\s/.test(after)))
			throw new FrontmatterError("Expected `key: value`", number);
		const key = line.slice(0, colon).trim();
		if (
			key.length === 0 ||
			key.length > PROPERTY_KEY_MAX_LENGTH ||
			!PROPERTY_KEY_PATTERN.test(key)
		)
			throw new FrontmatterError(
				`Invalid property key "${key.slice(0, 40)}"`,
				number,
			);
		if (Object.hasOwn(properties, key))
			throw new FrontmatterError(`Duplicate property "${key}"`, number);
		const rest = after.trim();
		pending = null;
		if (rest === "") {
			properties[key] = null;
			pending = { key, line: number };
		} else if (/^\[\[[^[\]]+\]\]$/.test(rest)) {
			// Older spaces write `categories: [[People]]`, which means a link.
			properties[key] = [rest];
		} else if (rest.startsWith("[")) {
			if (!rest.endsWith("]"))
				throw new FrontmatterError("Unterminated flow list", number);
			properties[key] = splitFlow(rest.slice(1, -1), number).map((part) =>
				listItem(part, number),
			);
		} else properties[key] = parseScalar(rest, number);
	}
	return { properties, body: lines.slice(end + 1).join("\n") };
}

/** Markdown reduced to readable text: links show their alias or target, heading markers go. */
export function plainText(markdown: string): string {
	return segments(markdown)
		.map((segment) =>
			segment.code
				? segment.text
						.replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, "")
						.replaceAll("`", "")
				: segment.text
						.replace(LINK, (_whole, _embed, inner: string) => {
							const [target, alias] = inner.split("|");
							return (alias ?? target.split("#")[0]).trim();
						})
						.replace(/^ {0,3}#{1,6}\s+/gm, ""),
		)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

export const SNIPPET_LENGTH = 160;

/** About 160 characters around the first match of any term, or the start of the body. */
export function snippet(body: string, terms: string[] = []): string {
	const text = plainText(body);
	const lower = text.toLowerCase();
	let at = -1;
	for (const term of terms) {
		const found = lower.indexOf(term.toLowerCase());
		if (found !== -1 && (at === -1 || found < at)) at = found;
	}
	if (at === -1) {
		return text.length > SNIPPET_LENGTH
			? `${text.slice(0, SNIPPET_LENGTH).trimEnd()}…`
			: text;
	}
	const start = Math.max(0, Math.min(at - 60, text.length - SNIPPET_LENGTH));
	const end = Math.min(text.length, start + SNIPPET_LENGTH);
	return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * HTML to Markdown for pages the gateway fetched itself. Providers return
 * Markdown on their own; this covers plain requests. A hand-written tokenizer
 * walks the page once: every search moves forward from where the last one
 * ended, so a hostile page cannot make it slow.
 */

/** Elements whose content is never part of the text. */
const DROPPED = new Set([
	"head",
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"math",
	"iframe",
	"object",
	"embed",
	"canvas",
	"nav",
	"footer",
	"aside",
	"select",
	"button",
	"dialog",
]);
/** Elements whose content is raw text: no tags inside until the closing tag. */
const RAW_TEXT = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"textarea",
	"title",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
]);
const VOID = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
/** Block elements that start and end a paragraph. */
const PARAGRAPH = new Set([
	"p",
	"blockquote",
	"pre",
	"table",
	"figure",
	"dl",
	"address",
	"details",
	"fieldset",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
]);
/** Block elements that start and end a line. */
const LINE = new Set([
	"div",
	"section",
	"article",
	"main",
	"header",
	"summary",
	"figcaption",
	"dt",
	"dd",
	"caption",
	"center",
	"hgroup",
	"li",
	"tr",
]);
/** What may sit in `<head>`; anything else closes it, as browsers do. */
const HEAD_CONTENT = new Set([
	"title",
	"meta",
	"link",
	"style",
	"script",
	"base",
	"noscript",
	"template",
]);
/** How far back an implied close looks for its element. */
const IMPLIED_CLOSE_DEPTH = 50;

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	sbquo: "‚",
	ldquo: "“",
	rdquo: "”",
	bdquo: "„",
	laquo: "«",
	raquo: "»",
	lsaquo: "‹",
	rsaquo: "›",
	bull: "•",
	middot: "·",
	deg: "°",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	sect: "§",
	para: "¶",
	times: "×",
	divide: "÷",
	plusmn: "±",
	minus: "−",
	frac12: "½",
	frac14: "¼",
	frac34: "¾",
	sup2: "²",
	sup3: "³",
	iexcl: "¡",
	iquest: "¿",
	shy: "\u00ad",
	zwj: "\u200d",
	zwnj: "\u200c",
	thinsp: "\u2009",
	ensp: "\u2002",
	emsp: "\u2003",
	larr: "←",
	rarr: "→",
	uarr: "↑",
	darr: "↓",
	harr: "↔",
	check: "✓",
	hearts: "♥",
	star: "☆",
	dagger: "†",
	Dagger: "‡",
	prime: "′",
	Prime: "″",
	auml: "ä",
	ouml: "ö",
	uuml: "ü",
	Auml: "Ä",
	Ouml: "Ö",
	Uuml: "Ü",
	szlig: "ß",
	eacute: "é",
	egrave: "è",
	ecirc: "ê",
	aacute: "á",
	agrave: "à",
	acirc: "â",
	iacute: "í",
	oacute: "ó",
	uacute: "ú",
	ntilde: "ñ",
	ccedil: "ç",
	Eacute: "É",
};
/** Legacy entities browsers accept without a semicolon. */
const BARE_ENTITIES = new Set(["amp", "lt", "gt", "quot", "nbsp"]);

/** Decodes HTML character references in one pass. */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	let out = "";
	let i = 0;
	while (i < text.length) {
		const amp = text.indexOf("&", i);
		if (amp === -1) {
			out += text.slice(i);
			break;
		}
		out += text.slice(i, amp);
		let end = amp + 1;
		while (
			end < text.length &&
			end - amp <= 32 &&
			/[#a-zA-Z0-9]/.test(text[end])
		)
			end++;
		const name = text.slice(amp + 1, end);
		const semicolon = text[end] === ";";
		let decoded: string | undefined;
		if (name.startsWith("#")) {
			const hex = name[1] === "x" || name[1] === "X";
			const digits = name.slice(hex ? 2 : 1);
			const code =
				digits && (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)
					? Number.parseInt(digits, hex ? 16 : 10)
					: Number.NaN;
			if (Number.isFinite(code))
				decoded =
					code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
						? String.fromCodePoint(code)
						: "�";
		} else if (semicolon || BARE_ENTITIES.has(name)) {
			decoded = Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : undefined;
		}
		if (decoded === undefined) {
			out += "&";
			i = amp + 1;
		} else {
			out += decoded;
			i = semicolon ? end + 1 : end;
		}
	}
	return out;
}

type Tag = {
	name: string;
	end: boolean;
	selfClosing: boolean;
	attrs: Record<string, string>;
	/** Index just past the closing `>`. */
	next: number;
};

/** Attributes the converter uses; the rest are skipped while scanning. */
const WANTED_ATTRS = new Set(["href", "src", "alt"]);

/**
 * Reads the tag starting at `start` (a `<`), honouring quoted attribute
 * values that contain `>`. Null when the tag never closes.
 */
function readTag(html: string, start: number): Tag | null {
	let i = start + 1;
	const end = html[i] === "/";
	if (end) i++;
	const nameStart = i;
	while (i < html.length && /[a-zA-Z0-9:-]/.test(html[i])) i++;
	const name = html.slice(nameStart, i).toLowerCase();
	const attrs: Record<string, string> = {};
	let selfClosing = false;
	while (i < html.length) {
		const ch = html[i];
		if (ch === ">") return { name, end, selfClosing, attrs, next: i + 1 };
		if (ch === "/") {
			selfClosing = html[i + 1] === ">";
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const keyStart = i;
		while (i < html.length && !/[\s=>/]/.test(html[i])) i++;
		const key = html.slice(keyStart, i).toLowerCase();
		while (i < html.length && /\s/.test(html[i])) i++;
		let value = "";
		if (html[i] === "=") {
			i++;
			while (i < html.length && /\s/.test(html[i])) i++;
			const quote = html[i];
			if (quote === '"' || quote === "'") {
				const close = html.indexOf(quote, i + 1);
				if (close === -1) return null;
				value = html.slice(i + 1, close);
				i = close + 1;
			} else {
				const valueStart = i;
				while (i < html.length && !/[\s>]/.test(html[i])) i++;
				value = html.slice(valueStart, i);
			}
		}
		if (WANTED_ATTRS.has(key) && !(key in attrs))
			attrs[key] = decodeEntities(value);
	}
	return null;
}

/** Collects Markdown with paragraph and line breaks requested lazily. */
class Writer {
	readonly parts: string[] = [];
	/** Non-whitespace characters written so far, to tell empty wrappers. */
	written = 0;
	private pendingBreak = 0;
	private pendingSpace = false;
	private atLineStart = true;
	/** Nothing has been written since an opening marker, so a space would land inside it. */
	private afterOpen = false;
	/** Nothing has been written since a list bullet, so a break would leave it empty. */
	private afterBullet = false;
	quoteDepth = 0;
	listDepth = 0;
	inCell = false;

	/** Asks for `count` newlines before the next text: 1 a line, 2 a paragraph. */
	requestBreak(count: number) {
		if (this.inCell) {
			this.pendingSpace = true;
			return;
		}
		if (this.afterBullet) return;
		if (this.parts.length)
			this.pendingBreak = Math.max(this.pendingBreak, count);
	}

	space() {
		this.pendingSpace = true;
	}

	private prefix(): string {
		return "> ".repeat(this.quoteDepth) + "  ".repeat(this.listDepth);
	}

	private flush(linePrefix?: string) {
		if (this.pendingBreak) {
			// A blank line inside a quote keeps its marker, or the quote ends there.
			const marker = "> ".repeat(this.quoteDepth).trimEnd();
			this.parts.push(`${`\n${marker}`.repeat(this.pendingBreak - 1)}\n`);
			this.pendingBreak = 0;
			this.atLineStart = true;
		}
		if (this.atLineStart) {
			this.parts.push(linePrefix ?? this.prefix());
			this.pendingSpace = false;
			this.atLineStart = false;
		} else if (this.pendingSpace) {
			if (!this.afterOpen) this.parts.push(" ");
			this.pendingSpace = false;
		}
	}

	/** Text with whitespace already collapsed. */
	text(value: string) {
		if (!value) return;
		this.flush();
		this.parts.push(value);
		this.written += value.length;
		this.afterOpen = false;
		this.afterBullet = false;
	}

	/** Markup that is not text, such as a table's `|`. */
	markup(value: string) {
		this.flush();
		this.parts.push(value);
		this.afterBullet = false;
	}

	/** An opening marker such as `**` or `# `. Returns its index, to drop it if nothing follows. */
	open(value: string): number {
		this.flush();
		this.parts.push(value);
		this.afterOpen = true;
		this.afterBullet = false;
		return this.parts.length - 1;
	}

	/** A closing marker, kept against the text before it; a pending space stays after it. */
	close(value: string) {
		this.parts.push(value);
	}

	/**
	 * Starts a list item line with its bullet. Items after the first follow
	 * on the next line, whatever their content asked for, so the list stays tight.
	 */
	bullet(marker: string, first: boolean) {
		this.afterBullet = false;
		if (first || this.inCell) this.requestBreak(1);
		else if (this.parts.length) this.pendingBreak = 1;
		const indent = "  ".repeat(Math.max(0, this.listDepth - 1));
		this.flush(`${"> ".repeat(this.quoteDepth)}${indent}${marker} `);
		this.afterBullet = true;
	}

	/** Preformatted text, as it is, with the quote prefix after each newline. */
	raw(value: string) {
		if (!value) return;
		this.flush();
		const prefix = "> ".repeat(this.quoteDepth);
		this.parts.push(prefix ? value.replaceAll("\n", `\n${prefix}`) : value);
		this.written += value.trim().length;
		this.afterOpen = false;
		this.afterBullet = false;
	}

	/** Ends the current line inside preformatted text. */
	newline() {
		this.parts.push(`\n${"> ".repeat(this.quoteDepth)}`);
	}

	/** Whether the last thing written ends a line. */
	endsLine(): boolean {
		const last = this.parts[this.parts.length - 1] ?? "";
		let end = last.length;
		while (end >= 2 && last.slice(end - 2, end) === "> ") end -= 2;
		return last[end - 1] === "\n";
	}
}

type Wrapper = { name: string; index: number; written: number; close: string };

/**
 * Converts a page to Markdown, resolving links against `baseUrl`. Prefers the
 * page's `<main>` or `<article>` when it has one, and puts the title first
 * when the page has no top-level heading.
 */
export function htmlToMarkdown(html: string, baseUrl: string): string {
	const lower = html.toLowerCase();
	const title = extractTitle(html, lower);
	const [from, to] = mainRange(lower);
	const source = html.slice(from, to);
	const sourceLower = lower.slice(from, to);
	const writer = new Writer();
	const stack: string[] = [];
	const open = new Map<string, number>();
	const lists: Array<{ ordered: boolean; index: number }> = [];
	const wrappers: Wrapper[] = [];
	let dropDepth = 0;
	let preDepth = 0;
	/** The next preformatted text starts right after `<pre>`, whose first newline browsers drop. */
	let preStart = false;
	let sawH1 = false;
	let tableRow: { cells: number; header: boolean } | null = null;
	let tableRows = 0;

	const push = (name: string) => {
		stack.push(name);
		open.set(name, (open.get(name) ?? 0) + 1);
	};
	const pop = () => {
		const name = stack.pop();
		if (name === undefined) return;
		open.set(name, (open.get(name) ?? 1) - 1);
		closeElement(name);
	};
	/** Closes `name` and everything opened inside it, if it is open. */
	const closeTo = (name: string) => {
		if (!open.get(name)) return;
		while (stack.length) {
			const top = stack[stack.length - 1];
			pop();
			if (top === name) return;
		}
	};
	/** Closes `name` when it is open near the top, as HTML's implied end tags do. */
	const impliedClose = (name: string, stopAt: readonly string[] = []) => {
		if (!open.get(name)) return;
		for (
			let i = stack.length - 1;
			i >= 0 && i >= stack.length - IMPLIED_CLOSE_DEPTH;
			i--
		) {
			if (stopAt.includes(stack[i])) return;
			if (stack[i] === name) {
				closeTo(name);
				return;
			}
		}
	};

	const resolve = (href: string): string | null => {
		const value = href.trim();
		if (!value || value.startsWith("#")) return null;
		try {
			const url = new URL(value, baseUrl);
			return url.protocol === "http:" ||
				url.protocol === "https:" ||
				url.protocol === "mailto:"
				? url.href
				: null;
		} catch {
			return null;
		}
	};

	function openElement(tag: Tag) {
		const { name } = tag;
		if (name !== "head" && !HEAD_CONTENT.has(name)) closeTo("head");
		if (DROPPED.has(name)) {
			dropDepth++;
			return;
		}
		if (dropDepth) return;
		if (PARAGRAPH.has(name)) impliedClose("p");
		if (PARAGRAPH.has(name) && name !== "ul" && name !== "ol")
			writer.requestBreak(2);
		switch (name) {
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6": {
				if (name === "h1") sawH1 = true;
				writer.requestBreak(2);
				writer.open(`${"#".repeat(Number(name[1]))} `);
				return;
			}
			case "ul":
			case "ol":
				writer.requestBreak(lists.length ? 1 : 2);
				lists.push({ ordered: name === "ol", index: 0 });
				writer.listDepth = lists.length;
				return;
			case "li": {
				impliedClose("li", ["ul", "ol"]);
				const list = lists[lists.length - 1];
				if (list) list.index++;
				writer.bullet(
					list?.ordered ? `${list.index}.` : "-",
					!list || list.index === 1,
				);
				return;
			}
			case "blockquote":
				writer.requestBreak(2);
				writer.quoteDepth++;
				return;
			case "pre":
				writer.requestBreak(2);
				if (!preDepth) {
					writer.markup("```");
					writer.newline();
					preStart = true;
				}
				preDepth++;
				return;
			case "br":
				if (preDepth) writer.newline();
				else writer.requestBreak(1);
				return;
			case "hr":
				writer.requestBreak(2);
				writer.markup("---");
				writer.requestBreak(2);
				return;
			case "table":
				writer.requestBreak(2);
				tableRows = 0;
				return;
			case "tr":
				impliedClose("tr", ["table"]);
				writer.inCell = false;
				writer.requestBreak(1);
				writer.markup("|");
				tableRow = { cells: 0, header: false };
				return;
			case "td":
			case "th":
				impliedClose("td", ["tr", "table"]);
				impliedClose("th", ["tr", "table"]);
				writer.inCell = true;
				writer.space();
				if (tableRow) {
					tableRow.cells++;
					if (name === "th") tableRow.header = true;
				}
				return;
			case "img": {
				const alt = tag.attrs.alt?.replace(/\s+/g, " ").trim();
				const src = tag.attrs.src ? resolve(tag.attrs.src) : null;
				if (alt && src && !src.startsWith("mailto:")) {
					writer.space();
					writer.text(`![${alt}](${src})`);
					writer.space();
				}
				return;
			}
			case "a": {
				closeTo("a");
				const href = tag.attrs.href ? resolve(tag.attrs.href) : null;
				wrappers.push({
					name,
					index: href ? writer.open("[") : -1,
					written: writer.written,
					close: href ? `](${href})` : "",
				});
				return;
			}
			case "strong":
			case "b":
				wrappers.push(wrap(name, "**"));
				return;
			case "em":
			case "i":
				wrappers.push(wrap(name, "*"));
				return;
			case "code":
				if (!preDepth) wrappers.push(wrap(name, "`"));
				return;
		}
		if (LINE.has(name)) writer.requestBreak(1);
	}

	function wrap(name: string, marker: string): Wrapper {
		return {
			name,
			index: writer.open(marker),
			written: writer.written,
			close: marker,
		};
	}

	function closeElement(name: string) {
		if (DROPPED.has(name)) {
			if (dropDepth) dropDepth--;
			return;
		}
		if (dropDepth) return;
		switch (name) {
			case "ul":
			case "ol":
				lists.pop();
				writer.listDepth = lists.length;
				writer.requestBreak(lists.length ? 1 : 2);
				return;
			case "blockquote":
				if (writer.quoteDepth) writer.quoteDepth--;
				writer.requestBreak(2);
				return;
			case "pre":
				if (preDepth) preDepth--;
				if (!preDepth) {
					if (!writer.endsLine()) writer.newline();
					writer.close("```");
					writer.requestBreak(2);
				}
				return;
			case "td":
			case "th":
				writer.inCell = false;
				writer.close(" |");
				return;
			case "tr":
				writer.inCell = false;
				if (tableRow && tableRows === 0 && tableRow.cells > 0) {
					writer.requestBreak(1);
					writer.markup(`|${" --- |".repeat(tableRow.cells)}`);
				}
				tableRows++;
				tableRow = null;
				writer.requestBreak(1);
				return;
			case "table":
				writer.inCell = false;
				writer.requestBreak(2);
				return;
		}
		const wrapper = wrappers.length ? wrappers[wrappers.length - 1] : undefined;
		if (wrapper && wrapper.name === name) {
			wrappers.pop();
			if (wrapper.index >= 0) {
				if (writer.written === wrapper.written)
					writer.parts[wrapper.index] = "";
				else if (wrapper.close) writer.close(wrapper.close);
			}
			return;
		}
		if (PARAGRAPH.has(name)) writer.requestBreak(2);
		else if (LINE.has(name)) writer.requestBreak(1);
	}

	let i = 0;
	while (i < source.length) {
		const lt = source.indexOf("<", i);
		const textEnd = lt === -1 ? source.length : lt;
		if (textEnd > i && !dropDepth) writeText(source.slice(i, textEnd));
		if (lt === -1) break;
		const next = source[lt + 1];
		if (source.startsWith("<!--", lt)) {
			const close = source.indexOf("-->", lt + 4);
			if (close === -1) break;
			i = close + 3;
			continue;
		}
		if (next === "!" || next === "?") {
			const close = source.indexOf(">", lt + 2);
			if (close === -1) break;
			i = close + 1;
			continue;
		}
		const isTag =
			next !== undefined &&
			(/[a-zA-Z]/.test(next) ||
				(next === "/" && /[a-zA-Z]/.test(source[lt + 2] ?? "")));
		if (!isTag) {
			if (!dropDepth) writeText("<");
			i = lt + 1;
			continue;
		}
		const tag = readTag(source, lt);
		if (!tag) {
			// A tag that never closes: the rest is not markup a browser would show.
			break;
		}
		i = tag.next;
		if (tag.end && tag.name !== "br") {
			closeTo(tag.name);
			continue;
		}
		openElement(tag);
		if (RAW_TEXT.has(tag.name) && !tag.selfClosing) {
			const close = sourceLower.indexOf(`</${tag.name}`, i);
			const end = close === -1 ? source.length : close;
			if (tag.name === "textarea" && !dropDepth)
				writeText(source.slice(i, end));
			if (DROPPED.has(tag.name)) dropDepth = Math.max(0, dropDepth - 1);
			i =
				close === -1
					? source.length
					: source.indexOf(">", close) + 1 || source.length;
			continue;
		}
		if (!VOID.has(tag.name) && !tag.selfClosing) push(tag.name);
		else if (DROPPED.has(tag.name)) dropDepth = Math.max(0, dropDepth - 1);
	}
	while (stack.length) pop();

	function writeText(raw: string) {
		let text = decodeEntities(raw);
		if (preDepth) {
			if (preStart) text = text.replace(/^\r?\n/, "");
			preStart = false;
			writer.raw(text);
			return;
		}
		let start = 0;
		let word = "";
		const flushWord = () => {
			if (word) writer.text(word);
			word = "";
		};
		for (let k = 0; k < text.length; k++) {
			const code = text.charCodeAt(k);
			if (
				code === 32 ||
				code === 9 ||
				code === 10 ||
				code === 13 ||
				code === 12 ||
				code === 160
			) {
				word += text.slice(start, k);
				flushWord();
				writer.space();
				start = k + 1;
			}
		}
		word += text.slice(start);
		flushWord();
	}

	let markdown = tidy(writer.parts.join(""));
	if (title && !sawH1)
		markdown = markdown ? `# ${title}\n\n${markdown}` : `# ${title}`;
	return markdown;
}

/** The page's `<title>`, decoded and collapsed. */
function extractTitle(html: string, lower: string): string {
	const start = lower.indexOf("<title");
	if (start === -1) return "";
	const open = lower.indexOf(">", start);
	if (open === -1) return "";
	const close = lower.indexOf("</title", open);
	if (close === -1) return "";
	return decodeEntities(html.slice(open + 1, close))
		.replace(/\s+/g, " ")
		.trim();
}

/** The `<main>` or `<article>` part of the page, or all of it. */
function mainRange(lower: string): [number, number] {
	for (const name of ["main", "article"]) {
		let start = lower.indexOf(`<${name}`);
		while (
			start !== -1 &&
			/[a-z0-9-]/.test(lower[start + name.length + 1] ?? "")
		)
			start = lower.indexOf(`<${name}`, start + 1);
		const end = lower.lastIndexOf(`</${name}`);
		if (start !== -1 && end > start) {
			const close = lower.indexOf(">", end);
			return [start, close === -1 ? lower.length : close + 1];
		}
	}
	return [0, lower.length];
}

/** Trims line ends and keeps at most one blank line in a row. */
function tidy(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let blank = 0;
	for (const line of lines) {
		const trimmed = line.trimEnd();
		const isBlank = trimmed.replace(/^(> )+/, "").trim() === "";
		if (isBlank) {
			blank++;
			if (blank > 1 || !out.length) continue;
			out.push("");
			continue;
		}
		blank = 0;
		out.push(trimmed);
	}
	while (out.length && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}

/**
 * Cuts text to `maxChars`, at the last paragraph break, line break, or space
 * in the final fifth of the window when there is one.
 */
export function truncateText(
	text: string,
	maxChars: number,
): { content: string; truncated: boolean } {
	if (text.length <= maxChars) return { content: text, truncated: false };
	const window = text.slice(0, maxChars);
	const floor = Math.floor(maxChars * 0.8);
	let cut = -1;
	for (const separator of ["\n\n", "\n", " "]) {
		const at = window.lastIndexOf(separator);
		if (at >= floor) {
			cut = at;
			break;
		}
	}
	if (cut === -1) {
		cut = maxChars;
		const code = text.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut--;
	}
	return { content: text.slice(0, cut).trimEnd(), truncated: true };
}

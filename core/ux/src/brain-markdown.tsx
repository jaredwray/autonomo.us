import { BRAIN_ATTACHMENT_EXTENSIONS } from "@autonomo.us/common";
import type { ReactNode } from "react";

/**
 * A small, safe Markdown renderer for Brain notes. It builds React elements
 * only (never HTML strings), so note content can't inject markup. It covers
 * what agents and Obsidian write: headings, paragraphs, lists (nested, with
 * task boxes), blockquotes, fenced code, pipe tables, inline code, emphasis,
 * external links (http(s) and mailto only) and [[wikilinks]] with aliases,
 * headings, and embeds.
 */

export type WikilinkTarget = {
	/** The note title linked to, without `#heading`, `|alias`, or `.md`. */
	title: string;
	/** `#Heading` or `#^block`, when given. */
	fragment: string;
	/** What the reader sees. */
	label: string;
	embed: boolean;
};

const ATTACHMENTS = new Set(BRAIN_ATTACHMENT_EXTENSIONS);
/** Parses the inside of `[[…]]` as the server does; `null` for attachments such as `photo.jpg`. */
export function parseWikilink(
	inner: string,
	embed = false,
): WikilinkTarget | null {
	const pipe = inner.indexOf("|");
	const path = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
	const alias = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
	const hash = path.indexOf("#");
	const fragment = hash === -1 ? "" : path.slice(hash);
	// Obsidian links may carry a folder path; titles never contain "/".
	const file =
		(hash === -1 ? path : path.slice(0, hash))
			.split("/")
			.filter(Boolean)
			.at(-1) ?? "";
	const title = file.replace(/\.md$/i, "").trim();
	const extension = /\.([A-Za-z0-9]{1,8})$/.exec(title)?.[1].toLowerCase();
	if (!title || (extension && ATTACHMENTS.has(extension))) return null;
	return { title, fragment, label: alias || path, embed };
}

export type InlineOptions = {
	/** Lowercased title → whether a note exists. Unknown titles render as resolved. */
	resolved?: ReadonlyMap<string, boolean>;
	/** Hash link for a wikilink target. */
	hrefFor(title: string): string;
	onNavigate(title: string): void;
};

const INLINE =
	/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|(!?)\[\[([^[\]]+?)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])|~~([^~]+?)~~|<?(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])>?/g;

function safeHref(url: string): string | null {
	const trimmed = url.trim();
	return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

export function renderInline(
	text: string,
	options: InlineOptions,
): ReactNode[] {
	const nodes: ReactNode[] = [];
	let last = 0;
	let key = 0;
	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > last) nodes.push(text.slice(last, index));
		last = index + match[0].length;
		const [
			,
			,
			code,
			bang,
			wiki,
			linkText,
			linkUrl,
			bold,
			bold2,
			italic,
			italic2,
			strike,
			url,
		] = match;
		key++;
		if (code !== undefined) nodes.push(<code key={key}>{code.trim()}</code>);
		else if (wiki !== undefined) {
			const target = parseWikilink(wiki, bang === "!");
			if (!target) nodes.push(match[0]);
			else nodes.push(<Wikilink key={key} target={target} options={options} />);
		} else if (linkText !== undefined) {
			const href = linkUrl ? safeHref(linkUrl) : null;
			if (href)
				nodes.push(
					<a key={key} href={href} rel="noreferrer" target="_blank">
						{renderInline(linkText, options)}
					</a>,
				);
			else nodes.push(renderInline(linkText, options));
		} else if (bold !== undefined || bold2 !== undefined)
			nodes.push(
				<strong key={key}>{renderInline(bold ?? bold2, options)}</strong>,
			);
		else if (italic !== undefined || italic2 !== undefined)
			nodes.push(<em key={key}>{renderInline(italic ?? italic2, options)}</em>);
		else if (strike !== undefined)
			nodes.push(<s key={key}>{renderInline(strike, options)}</s>);
		else if (url !== undefined)
			nodes.push(
				<a key={key} href={url} rel="noreferrer" target="_blank">
					{url}
				</a>,
			);
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

function Wikilink({
	target,
	options,
}: {
	target: WikilinkTarget;
	options: InlineOptions;
}) {
	const exists = options.resolved?.get(target.title.toLowerCase()) ?? true;
	return (
		<a
			className={`wikilink${exists ? "" : " unresolved"}${target.embed ? " embed" : ""}`}
			href={options.hrefFor(target.title)}
			title={exists ? undefined : `No note titled “${target.title}” yet`}
			data-unresolved={exists ? undefined : "true"}
			onClick={(event) => {
				event.preventDefault();
				options.onNavigate(target.title);
			}}
		>
			{target.label}
		</a>
	);
}

/** Lines of a block, with soft line breaks rendered like Obsidian does. */
function renderLines(lines: string[], options: InlineOptions): ReactNode[] {
	const out: ReactNode[] = [];
	lines.forEach((line, index) => {
		// biome-ignore lint/suspicious/noArrayIndexKey: parsed Markdown is rebuilt from scratch and never reorders
		if (index > 0) out.push(<br key={`br${index}`} />);
		out.push(...renderInline(line, options));
	});
	return out;
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*(\S*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

type ListItem = { text: string[]; children: ListNode[] };
type ListNode = { ordered: boolean; start: number; items: ListItem[] };

const indentOf = (line: string) => /^\s*/.exec(line)?.[0].length ?? 0;
const isBlank = (line: string) => line.trim() === "";
const startsBlock = (line: string) =>
	FENCE.test(line) ||
	HEADING.test(line) ||
	RULE.test(line) ||
	QUOTE.test(line) ||
	LIST_ITEM.test(line);

/**
 * Quotes and lists nest by recursion. Deeper levels render as plain text, so a
 * note with thousands of `>` markers or indents cannot overflow the stack.
 */
export const MAX_NESTING = 16;

function parseList(
	lines: string[],
	start: number,
	depth = 0,
): { node: ListNode; end: number } {
	const first = LIST_ITEM.exec(lines[start]);
	if (!first) throw new Error("not a list");
	const base = first[1].length;
	const node: ListNode = {
		ordered: /\d/.test(first[2]),
		start: Number.parseInt(first[2], 10) || 1,
		items: [],
	};
	// A sibling item continues this list only when it uses the same kind of marker.
	const continues = (line: string) => {
		const item = LIST_ITEM.exec(line);
		if (!item) return false;
		const indent = item[1].length;
		return (
			indent > base || (indent === base && /\d/.test(item[2]) === node.ordered)
		);
	};
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (isBlank(line)) {
			const next = lines[i + 1];
			if (next !== undefined && continues(next)) {
				i++;
				continue;
			}
			break;
		}
		const item = LIST_ITEM.exec(line);
		const indent = indentOf(line);
		const last = node.items.at(-1);
		if (item && indent <= base) {
			if (indent < base || !continues(line)) break;
			node.items.push({ text: [item[3]], children: [] });
			i++;
		} else if (item && last && depth + 1 >= MAX_NESTING) {
			last.text.push(line.trim());
			i++;
		} else if (item && last) {
			const nested = parseList(lines, i, depth + 1);
			last.children.push(nested.node);
			i = nested.end;
		} else if (indent > base && last) {
			last.text.push(line.trim());
			i++;
		} else break;
	}
	return { node, end: i };
}

function renderList(
	node: ListNode,
	options: InlineOptions,
	key: number,
): ReactNode {
	const items = node.items.map((item, index) => {
		const task = TASK.exec(item.text[0]);
		const lines = task ? [task[2], ...item.text.slice(1)] : item.text;
		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: parsed Markdown is rebuilt from scratch and never reorders
			<li key={index} className={task ? "task" : undefined}>
				{task && (
					<input
						type="checkbox"
						checked={task[1] !== " "}
						readOnly
						disabled
						aria-label={task[1] === " " ? "Open task" : "Done task"}
					/>
				)}
				{renderLines(lines, options)}
				{item.children.map((child, childIndex) =>
					renderList(child, options, childIndex),
				)}
			</li>
		);
	});
	return node.ordered ? (
		<ol key={key} start={node.start}>
			{items}
		</ol>
	) : (
		<ul key={key}>{items}</ul>
	);
}

function splitRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let current = "";
	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (char === "\\" && trimmed[i + 1] === "|") {
			current += "|";
			i++;
		} else if (char === "|") {
			cells.push(current.trim());
			current = "";
		} else current += char;
	}
	cells.push(current.trim());
	return cells;
}

export function renderMarkdown(
	source: string,
	options: InlineOptions,
	depth = 0,
): ReactNode[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const blocks: ReactNode[] = [];
	let i = 0;
	let key = 0;
	while (i < lines.length) {
		const line = lines[i];
		key++;
		if (isBlank(line)) {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const marker = fence[2];
			const code: string[] = [];
			i++;
			while (i < lines.length) {
				const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
				if (
					close &&
					close[1][0] === marker[0] &&
					close[1].length >= marker.length
				)
					break;
				code.push(lines[i]);
				i++;
			}
			i++;
			blocks.push(
				<pre key={key} data-language={fence[3] || undefined}>
					<code>{code.join("\n")}</code>
				</pre>,
			);
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			// The note title is the page's heading, so body headings start one level down.
			const level = Math.min(heading[1].length + 1, 6);
			const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
			blocks.push(<Tag key={key}>{renderInline(heading[2], options)}</Tag>);
			i++;
			continue;
		}
		if (RULE.test(line)) {
			blocks.push(<hr key={key} />);
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length) {
				const quoted = QUOTE.exec(lines[i]);
				if (quoted) inner.push(quoted[1]);
				else if (!isBlank(lines[i]) && !startsBlock(lines[i]) && inner.length)
					inner.push(lines[i]);
				else break;
				i++;
			}
			blocks.push(
				<blockquote key={key}>
					{depth + 1 < MAX_NESTING ? (
						renderMarkdown(inner.join("\n"), options, depth + 1)
					) : (
						<p>{renderLines(inner, options)}</p>
					)}
				</blockquote>,
			);
			continue;
		}
		if (LIST_ITEM.test(line)) {
			const { node, end } = parseList(lines, i);
			blocks.push(renderList(node, options, key));
			i = end;
			continue;
		}
		if (
			line.includes("|") &&
			lines[i + 1] !== undefined &&
			TABLE_SEPARATOR.test(lines[i + 1]) &&
			lines[i + 1].includes("|")
		) {
			const header = splitRow(line);
			const rows: string[][] = [];
			i += 2;
			while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
				rows.push(splitRow(lines[i]));
				i++;
			}
			blocks.push(
				<table key={key}>
					<thead>
						<tr>
							{header.map((cell, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
								<th key={index}>{renderInline(cell, options)}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rowIndex) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional
							<tr key={rowIndex}>
								{header.map((_, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
									<td key={index}>{renderInline(row[index] ?? "", options)}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>,
			);
			continue;
		}
		const paragraph: string[] = [line];
		i++;
		while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
			paragraph.push(lines[i]);
			i++;
		}
		blocks.push(<p key={key}>{renderLines(paragraph, options)}</p>);
	}
	return blocks;
}

export function Markdown({
	source,
	...options
}: { source: string } & InlineOptions) {
	return (
		<div className="brain-markdown">{renderMarkdown(source, options)}</div>
	);
}

import { createHash } from "node:crypto";
import type {
	SynapseDecisionStatus,
	SynapseEvidence,
	SynapseProperties,
	SynapsePropertyValue,
	SynapseStanding,
} from "@autonomo.us/common";
import { DATE_PATTERN, linkTarget } from "./markdown.js";

/** Where a note keeps the sources of its claims. */
export const EVIDENCE_HEADING = "Evidence";
/** Where a mentioned note records the sources that mention it. */
export const MENTIONS_HEADING = "Mentions";
/**
 * Sections whose lines quote sources. What a source said is somebody
 * else's words wherever it is copied to, so these are kept out of
 * briefings and snippets and are labelled as source material in retrieval.
 */
export const QUOTING_SECTIONS: readonly string[] = [
	MENTIONS_HEADING,
	EVIDENCE_HEADING,
];
export const MAX_PASSAGE_LENGTH = 1000;
/** Evidence lines read from one note. */
export const MAX_EVIDENCE_LINES = 100;

/**
 * Which lines of a body are outside fenced code. A block closes only on a
 * bare fence of the same character, at least as long as the opener
 * (CommonMark), so ```ts inside a block stays content.
 */
function outsideCode(lines: string[]): boolean[] {
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
	return outside;
}

const escapeRegex = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The lines of a `## <heading>` section and where it sits, or null without one. */
function section(lines: string[], heading: string) {
	const outside = outsideCode(lines);
	const title = new RegExp(`^## ${escapeRegex(heading)}\\s*$`);
	const start = lines.findIndex(
		(item, index) => outside[index] && title.test(item),
	);
	if (start === -1) return null;
	const next = lines.findIndex(
		(item, index) => index > start && outside[index] && /^#{1,2}\s/.test(item),
	);
	return { start, next, outside };
}

/**
 * Adds `line` to the `## <heading>` section, creating the heading at the end
 * of the body when it is missing. Headings inside fenced code are text.
 */
export function appendSectionLine(
	body: string,
	heading: string,
	line: string,
): string {
	const lines = body.split("\n");
	const found = section(lines, heading);
	if (!found) {
		const base = body.trimEnd();
		return `${base ? `${base}\n\n` : ""}## ${heading}\n${line}`;
	}
	let end = found.next === -1 ? lines.length : found.next;
	while (end > found.start + 1 && lines[end - 1].trim() === "") end--;
	// Blank lines before the next section stay; trailing ones go.
	lines.splice(end, found.next === -1 ? lines.length - end : 0, line);
	return lines.join("\n");
}

/** The lines under `## <heading>`, up to the next heading of its level or above. */
export function sectionLines(body: string, heading: string): string[] {
	const lines = body.split("\n");
	const found = section(lines, heading);
	if (!found) return [];
	return lines
		.slice(found.start + 1, found.next === -1 ? lines.length : found.next)
		.filter((_line, index) => found.outside[found.start + 1 + index]);
}

/** A body without its `## <heading>` sections, each up to the next heading of its level or above. */
export function withoutSections(
	body: string,
	headings: readonly string[],
): string {
	let lines = body.split("\n");
	for (const heading of headings)
		for (;;) {
			const found = section(lines, heading);
			if (!found) break;
			lines = [
				...lines.slice(0, found.start),
				...(found.next === -1 ? [] : lines.slice(found.next)),
			];
		}
	return lines.join("\n");
}

/** Text as it is compared: case and the kind and amount of whitespace do not matter. */
export const comparable = (text: string) =>
	text.replace(/\s+/g, " ").trim().toLowerCase();

/** A passage as it is written into an evidence line: one line, bounded. */
export function cleanPassage(passage: string): string {
	return passage.replace(/\s+/g, " ").trim().slice(0, MAX_PASSAGE_LENGTH);
}

/** `- [[Source]] (r3, 2026-11-18): "the passage"`. */
export function evidenceLine(cited: {
	source: string;
	revision: number;
	date: string;
	passage: string;
}): string {
	return `- [[${cited.source}]] (r${cited.revision}, ${cited.date}): "${cleanPassage(cited.passage)}"`;
}

const EVIDENCE_LINE =
	/^\s*[-*+]\s+!?\[\[([^[\]\n]*)\]\](?:\s*\(([^()\n]*)\))?\s*(?::\s*(.*))?$/;

export type CitedEvidence = Omit<SynapseEvidence, "state">;

/** The evidence a note cites: the bullets of its `## Evidence` section that start with a link. */
export function parseEvidence(body: string): CitedEvidence[] {
	const out: CitedEvidence[] = [];
	for (const line of sectionLines(body, EVIDENCE_HEADING)) {
		const match = EVIDENCE_LINE.exec(line);
		if (!match) continue;
		const source = linkTarget(match[1]);
		if (!source) continue;
		const meta = match[2] ?? "";
		const revision = /(?:^|[\s,])r(\d{1,9})(?=$|[\s,])/.exec(meta)?.[1];
		const date = /\d{4}-\d{2}-\d{2}/.exec(meta)?.[0] ?? null;
		const passage = (match[3] ?? "")
			.trim()
			.replace(/^["“](.*)["”]$/s, "$1")
			.trim();
		out.push({
			source,
			revision: revision === undefined ? null : Number(revision),
			date,
			passage,
		});
		if (out.length === MAX_EVIDENCE_LINES) break;
	}
	return out;
}

/** Whether `passage` still appears in `sourceBody`. */
export function evidenceState(
	passage: string,
	sourceBody: string | null,
): SynapseEvidence["state"] {
	if (sourceBody === null) return "missing";
	if (!passage) return "unquoted";
	return comparable(sourceBody).includes(comparable(passage))
		? "verified"
		: "changed";
}

/** The strings of one property value, with `[[ ]]` and aliases removed. */
export function propertyTargets(
	value: SynapsePropertyValue | undefined,
): string[] {
	const items =
		typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	return items.flatMap((item) => {
		const linked = /^\s*!?\[\[([^[\]\n]*)\]\]\s*$/.exec(item);
		const target = linked ? linkTarget(linked[1]) : item.trim();
		return target ? [target] : [];
	});
}

const statusOf = (properties: SynapseProperties) =>
	propertyTargets(properties.status).map((item) => item.toLowerCase());

const dateOf = (value: SynapsePropertyValue | undefined) =>
	typeof value === "string" && DATE_PATTERN.test(value) ? value : null;

/** "Is it still current?", read from a note's properties. */
export function standingOf(properties: SynapseProperties): SynapseStanding {
	const values = statusOf(properties);
	// The strongest status wins when a note lists more than one.
	const status =
		(["superseded", "disputed", "active"] as SynapseDecisionStatus[]).find(
			(item) => values.includes(item),
		) ?? null;
	return {
		status,
		supersededBy: propertyTargets(properties.superseded_by),
		supersedes: propertyTargets(properties.supersedes),
		reviewed: dateOf(properties.reviewed) ?? dateOf(properties.date),
		draft: values.includes("draft"),
		current: status !== "superseded",
	};
}

/** Content as it is compared between captures: line endings and trailing space do not matter. */
export function normalizeContent(text: string): string {
	return text
		.replace(/^﻿/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

export function contentHash(text: string): string {
	return createHash("sha256").update(normalizeContent(text)).digest("hex");
}

const SAMPLE_LINES = 6;
const SAMPLE_LINE_LENGTH = 160;

/**
 * How two versions of a text differ, by line: how many lines the new one
 * has that the old one lacks and the reverse, with the first few of each.
 * Order is ignored, which keeps it linear for a 100,000-character note.
 */
export function lineDiff(
	before: string,
	after: string,
): { added: number; removed: number; sample: string[] } {
	const count = (text: string) => {
		const lines = new Map<string, number>();
		for (const line of text.split("\n")) {
			const key = line.trim();
			if (key) lines.set(key, (lines.get(key) ?? 0) + 1);
		}
		return lines;
	};
	const old = count(before);
	const next = count(after);
	const only = (from: Map<string, number>, other: Map<string, number>) => {
		const lines: string[] = [];
		let total = 0;
		for (const [line, times] of from) {
			const extra = times - (other.get(line) ?? 0);
			if (extra <= 0) continue;
			total += extra;
			lines.push(line);
		}
		return { total, lines };
	};
	const added = only(next, old);
	const removed = only(old, next);
	const show = (sign: string, lines: string[]) =>
		lines
			.slice(0, SAMPLE_LINES / 2)
			.map(
				(line) =>
					`${sign} ${line.length > SAMPLE_LINE_LENGTH ? `${line.slice(0, SAMPLE_LINE_LENGTH)}…` : line}`,
			);
	return {
		added: added.total,
		removed: removed.total,
		sample: [...show("+", added.lines), ...show("-", removed.lines)],
	};
}

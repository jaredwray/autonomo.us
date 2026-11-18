import type {
	SynapseCommitment,
	SynapseContext,
	SynapseContextItem,
	SynapseContextRequest,
	SynapsePassage,
	SynapseSpaceId,
} from "@autonomo.us/common";
import { MENTIONS_HEADING } from "./capture.js";
import {
	byUrgency,
	COMMITMENTS_KEY,
	commitmentOf,
	MAX_COMMITMENTS,
} from "./commitments.js";
import { SynapseError } from "./errors.js";
import {
	EVIDENCE_HEADING,
	propertyTargets,
	standingOf,
	withoutSections,
} from "./evidence.js";
import { DATE_PATTERN, plainText, titleKey } from "./markdown.js";
import type { StoredNote } from "./repository.js";
import { questionTerms, type SynapseRetriever } from "./retrieval.js";
import { publicSpaceId, type SynapseService } from "./synapse.js";
import { findMentions, type Named } from "./text.js";

/** The most a briefing's text holds, so it fits beside a prompt. */
export const MAX_CONTEXT_LENGTH = 6000;
export const MAX_TASK_LENGTH = 2000;
const ITEM_LENGTH = 220;
const REMIT_LENGTH = 600;
/** Notes read from each category of each space. */
const CATEGORY_NOTES = 200;
const LIMITS = {
	rules: 12,
	goals: 3,
	decisions: 8,
	evidence: 5,
	questions: 6,
	commitments: 8,
};
/** Sources and clippings hold other people's words: a briefing cites notes about them, not them. */
const OUTSIDE_MATERIAL = new Set(["sources", "clippings"]);
/**
 * Sections that quote sources. What a source said does not belong in a
 * briefing either, wherever it was copied to.
 */
const QUOTING_SECTIONS = [MENTIONS_HEADING, EVIDENCE_HEADING];
/** A note's own words: its body without the sections that quote sources. */
const ownWords = (body: string) =>
	plainText(withoutSections(body, QUOTING_SECTIONS));
/** `applies_to` values that mean every agent. */
const EVERYONE = new Set(["everyone", "all", "all agents", "agents"]);

/** Who a briefing is for. */
export type BriefingScope = {
	/** The agent's own space, when it has one. */
	own?: SynapseSpaceId;
	/** Its workspace's shared space, which shows Global's notes too. */
	shared: SynapseSpaceId;
	/** The agent's name, for rules and commitments addressed to it. */
	agentName?: string;
	/** What the agent is for, from its own record. */
	remit?: string | null;
};

const cut = (text: string, length = ITEM_LENGTH) =>
	text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;

const dateOf = (note: StoredNote) =>
	["date", "asked", "start", "created"]
		.map((key) => note.properties[key])
		.find(
			(value): value is string =>
				typeof value === "string" && DATE_PATTERN.test(value),
		) ?? null;

/**
 * A compact briefing for a task: the rules that apply, what the agent is
 * for, the goals of the projects involved, decisions in force, passages
 * that bear on the task, open questions, and commitments that are late or
 * stuck. See docs/SYNAPSE.md §15.
 */
export class SynapseBriefing {
	constructor(
		private readonly synapse: SynapseService,
		private readonly retriever: SynapseRetriever,
	) {}

	private spaces(scope: BriefingScope): SynapseSpaceId[] {
		return [...(scope.own ? [scope.own] : []), scope.shared];
	}

	/** A category's notes across the agent's spaces; its own note wins a shared title. */
	private async category(
		scope: BriefingScope,
		key: string,
		shown: Map<SynapseSpaceId, string[] | null>,
	) {
		const seen = new Set<string>();
		const notes: StoredNote[] = [];
		for (const space of this.spaces(scope))
			for (const note of await this.synapse.find(
				{ space, categoryKey: key },
				{
					sort: { by: "updatedAt", direction: "desc" },
					limit: key === COMMITMENTS_KEY ? MAX_COMMITMENTS : CATEGORY_NOTES,
				},
				shown.get(space),
			)) {
				if (seen.has(note.titleKey)) continue;
				seen.add(note.titleKey);
				notes.push(note);
			}
		return notes;
	}

	private item(note: StoredNote, text?: string): SynapseContextItem {
		const status = standingOf(note.properties).status;
		return {
			title: note.title,
			space: publicSpaceId(note.space),
			text: cut(text ?? ownWords(note.body)),
			date: dateOf(note),
			...(status ? { status } : {}),
		};
	}

	async brief(
		scope: BriefingScope,
		request: SynapseContextRequest = {},
	): Promise<SynapseContext> {
		const task =
			typeof request.task === "string" && request.task.trim()
				? request.task.trim()
				: null;
		if (task && task.length > MAX_TASK_LENGTH)
			throw new SynapseError(
				`A task is at most ${MAX_TASK_LENGTH.toLocaleString("en-US")} characters.`,
			);
		const terms = task ? questionTerms(task) : [];
		const agentKey = scope.agentName ? titleKey(scope.agentName) : null;
		// Each space's own titles are read once for every read below.
		const shown = new Map(
			await Promise.all(
				this.spaces(scope).map(
					async (space) =>
						[space, await this.synapse.ownTitles(space)] as const,
				),
			),
		);
		const [rules, projects, decisions, questions, commitments, remitNote] =
			await Promise.all([
				this.category(scope, "rules", shown),
				this.category(scope, "projects", shown),
				this.category(scope, "decisions", shown),
				this.category(scope, "questions", shown),
				this.category(scope, COMMITMENTS_KEY, shown),
				scope.own
					? this.synapse.repository.getNote(scope.own, "remit")
					: Promise.resolve(null),
			]);

		// The projects the task is about: the one named, and any it mentions.
		const projectKeys = new Set<string>();
		if (typeof request.project === "string" && request.project.trim())
			projectKeys.add(titleKey(request.project.trim()));
		if (task) {
			const names: Named<string>[] = projects.flatMap((note) =>
				[note.titleKey, ...(note.aliasKeys ?? [])].map((name) => ({
					name,
					value: note.titleKey,
				})),
			);
			for (const mention of findMentions(task, names))
				projectKeys.add(mention.value);
		}
		/** How much a note has to do with the task: its projects, then its words. */
		const relevance = (note: StoredNote) =>
			(projectKeys.has(note.titleKey) ? 4 : 0) +
			(note.linkKeys.some((key) => projectKeys.has(key)) ? 3 : 0) +
			terms.filter((term) => note.searchText.includes(term.root)).length;
		/** The notes that bear on the task, or the latest when nothing says which do. */
		const pick = (notes: StoredNote[], limit: number) => {
			const ranked = notes
				.map((note) => ({ note, score: relevance(note) }))
				.sort(
					(a, b) =>
						b.score - a.score ||
						(dateOf(b.note) ?? b.note.updatedAt).localeCompare(
							dateOf(a.note) ?? a.note.updatedAt,
						),
				);
			const relevant = ranked.filter((item) => item.score > 0);
			return (relevant.length ? relevant : ranked)
				.slice(0, limit)
				.map((item) => item.note);
		};
		const current = (note: StoredNote) => {
			const standing = standingOf(note.properties);
			return standing.current && !standing.draft;
		};

		const applies = (note: StoredNote) => {
			const to = propertyTargets(note.properties.applies_to).map(titleKey);
			return (
				to.length === 0 ||
				to.some(
					(item) =>
						EVERYONE.has(item) || item === agentKey || projectKeys.has(item),
				)
			);
		};
		const today = this.synapse.today();
		const owed = commitments
			.map((note) => commitmentOf(note, today))
			.filter(
				(item) =>
					item.overdue ||
					item.status === "blocked" ||
					(item.status === "open" &&
						(item.owner.some((owner) => titleKey(owner) === agentKey) ||
							item.project.some((project) =>
								projectKeys.has(titleKey(project)),
							))),
			)
			.sort(byUrgency)
			.slice(0, LIMITS.commitments);

		let evidence: SynapsePassage[] = [];
		if (task && terms.length)
			evidence = (
				await this.retriever
					.retrieve(
						this.spaces(scope),
						{ question: task, limit: LIMITS.evidence * 3 },
						shown,
					)
					// A briefing without passages is still a briefing.
					.catch(() => ({ passages: [] as SynapsePassage[] }))
			).passages
				.filter(
					(passage) =>
						passage.standing !== "superseded" &&
						!QUOTING_SECTIONS.includes(passage.heading ?? "") &&
						!passage.categories.some((category) =>
							OUTSIDE_MATERIAL.has(titleKey(category)),
						),
				)
				.slice(0, LIMITS.evidence);

		const remit =
			[scope.remit?.trim(), remitNote ? ownWords(remitNote.body) : ""]
				.filter(Boolean)
				.map((text) => cut(text as string, REMIT_LENGTH))
				.join("\n") || null;
		const goalOf = (note: StoredNote) =>
			typeof note.properties.goal === "string" && note.properties.goal.trim()
				? note.properties.goal.trim()
				: ownWords(note.body);
		const active = projects.filter((note) => {
			const status = propertyTargets(note.properties.status).map(titleKey);
			return !status.some((item) =>
				["done", "cancelled", "archived", "complete", "completed"].includes(
					item,
				),
			);
		});
		const context: Omit<SynapseContext, "text" | "truncated"> = {
			generatedAt: new Date(this.synapse.nowMs()).toISOString(),
			task,
			remit,
			rules: rules
				.filter((note) => current(note) && applies(note))
				.slice(0, LIMITS.rules)
				.map((note) => this.item(note)),
			goals: (projectKeys.size
				? projects.filter((note) => projectKeys.has(note.titleKey))
				: pick(active, LIMITS.goals)
			)
				.slice(0, LIMITS.goals)
				.map((note) => this.item(note, goalOf(note))),
			decisions: pick(decisions.filter(current), LIMITS.decisions).map((note) =>
				this.item(note),
			),
			evidence,
			questions: pick(
				questions.filter((note) => {
					const status = propertyTargets(note.properties.status).map(titleKey);
					return status.length === 0 || status.includes("open");
				}),
				LIMITS.questions,
			).map((note) => this.item(note)),
			commitments: owed,
		};
		return { ...context, ...render(context) };
	}
}

const commitmentLine = (item: SynapseCommitment) =>
	`- [[${item.title}]] (${[
		item.overdue ? "OVERDUE" : item.status,
		item.due ? `due ${item.due}` : "no due date",
		item.owner.length ? `owner ${item.owner.join(", ")}` : "no owner",
	].join("; ")})`;

/** The briefing as Markdown. Sections come in order of what an agent must not miss. */
export function render(context: Omit<SynapseContext, "text" | "truncated">): {
	text: string;
	truncated: boolean;
} {
	const line = (item: SynapseContextItem) =>
		`- [[${item.title}]]${
			item.date || item.status
				? ` (${[item.date, item.status === "disputed" ? "DISPUTED" : null].filter(Boolean).join("; ")})`
				: ""
		}${item.text ? `: ${item.text}` : ""}`;
	const sections: Array<[string, string[]]> = [
		["Your remit", context.remit ? [context.remit] : []],
		["Standing rules", context.rules.map(line)],
		[
			"Commitments that need attention",
			context.commitments.map(commitmentLine),
		],
		["Project goals", context.goals.map(line)],
		["Decisions in force", context.decisions.map(line)],
		["Open questions", context.questions.map(line)],
		[
			"Relevant evidence",
			context.evidence.map(
				(passage) =>
					`- [[${passage.title}]] (${[passage.date, passage.standing].filter(Boolean).join("; ")}): ${cut(passage.text.replace(/\s+/g, " "), ITEM_LENGTH)}`,
			),
		],
	];
	const head = `# Briefing${context.task ? `: ${cut(context.task, 160)}` : ""}`;
	const out = [head];
	let length = head.length;
	let truncated = false;
	for (const [title, lines] of sections) {
		if (!lines.length) continue;
		const kept: string[] = [];
		for (const item of lines) {
			if (length + item.length + title.length + 8 > MAX_CONTEXT_LENGTH) {
				truncated = true;
				break;
			}
			kept.push(item);
			length += item.length + 1;
		}
		if (!kept.length) continue;
		out.push(`## ${title}\n${kept.join("\n")}`);
		length += title.length + 5;
	}
	if (out.length === 1)
		out.push(
			"Synapse holds nothing for this task yet: no rules, decisions, or open questions apply.",
		);
	return { text: out.join("\n\n"), truncated };
}

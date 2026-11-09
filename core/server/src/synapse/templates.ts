import type {
	SynapseProperties,
	SynapsePropertyValue,
	SynapseTemplate,
} from "@autonomo.us/common";
import { renderMarkdown, titleKey } from "./markdown.js";

export const DATE_TOKEN = "{{date}}";
/** Export folder for notes tagged `categories`. */
export const CATEGORIES_FOLDER = "Categories";
export const DAILY_TEMPLATE = "Daily";

const link = (title: string) => `[[${title}]]`;

function template(
	name: string,
	folder: string,
	description: string,
	properties: SynapseProperties,
	body = "",
): SynapseTemplate {
	return {
		name,
		category: name,
		description,
		folder,
		properties: { categories: [link(name)], ...properties },
		body,
	};
}

/** Adapted from kepano's templates for an agent team; see docs/SYNAPSE.md §4. */
export const BUILTIN_TEMPLATES: readonly SynapseTemplate[] = [
	template(
		"People",
		"References",
		"People the team works with or learns from. Link them from meetings, projects, and clippings.",
		{ org: [], role: null, email: null, url: null, created: DATE_TOKEN },
	),
	template(
		"Companies",
		"References",
		"Companies, teams, and other organizations the team deals with, with the people who work there.",
		{ type: [], people: [], url: null, created: DATE_TOKEN },
	),
	template(
		"Projects",
		"",
		"Pieces of work with a goal and an end, linking the people and decisions involved.",
		{
			type: [],
			org: [],
			start: null,
			end: null,
			status: [],
			url: null,
			created: DATE_TOKEN,
		},
	),
	template(
		"Meetings",
		"",
		"Conversations with people, with who attended, what was discussed, and what was decided.",
		{ type: [], date: DATE_TOKEN, org: [], people: [], topics: [] },
	),
	template(
		"Decisions",
		"",
		"Standing decisions and the reasoning behind them, so agents stop re-deciding them.",
		{ date: DATE_TOKEN, status: [link("Active")], owner: [], topics: [] },
	),
	template(
		"Evergreen",
		"",
		"Durable ideas, one per note, titled as a statement and refined over time.",
		{ created: DATE_TOKEN, topics: [] },
	),
	template(
		"Clippings",
		"Clippings",
		"Articles and other outside material worth keeping, with its source and why it matters.",
		{
			author: [],
			url: null,
			published: null,
			topics: [],
			created: DATE_TOKEN,
			tags: ["clippings"],
		},
	),
	template(
		"Posts",
		"",
		"Writing the team publishes, from draft to published, with its channel and status.",
		{
			author: [],
			url: null,
			published: null,
			status: [],
			topics: [],
			created: DATE_TOKEN,
		},
	),
	template(
		"Events",
		"",
		"Things that happen at a time and place: launches, conferences, deadlines, incidents.",
		{
			type: [],
			start: null,
			end: null,
			loc: null,
			people: [],
			created: DATE_TOKEN,
		},
	),
	template(
		"Products",
		"References",
		"Products and tools the team uses, evaluates, or competes with, and who makes them.",
		{ type: [], maker: [], url: null, price: null, created: DATE_TOKEN },
	),
	template(
		"Places",
		"References",
		"Places the team works from, visits, or refers to, linked from events and people.",
		{ type: [], loc: [], url: null, created: DATE_TOKEN },
	),
	template(
		"Journal",
		"",
		"Reflections and longer-form notes on how work is going, as opposed to the factual daily log.",
		{ created: DATE_TOKEN, tags: ["journal"] },
	),
	{
		name: DAILY_TEMPLATE,
		category: null,
		description:
			"One note per day, titled YYYY-MM-DD, holding the day's log and collecting everything linked to it.",
		folder: "Daily",
		properties: { tags: ["daily"] },
		body: "",
	},
];

export function findTemplate(name: string): SynapseTemplate | undefined {
	const key = titleKey(name.trim());
	return BUILTIN_TEMPLATES.find((item) => titleKey(item.name) === key);
}

export function templateForCategory(
	category: string,
): SynapseTemplate | undefined {
	const key = titleKey(category);
	return BUILTIN_TEMPLATES.find(
		(item) => item.category !== null && titleKey(item.category) === key,
	);
}

/** Template properties with `{{date}}` replaced by `date` (YYYY-MM-DD). */
export function fillTemplate(
	template: SynapseTemplate,
	date: string,
): SynapseProperties {
	const fill = (value: SynapsePropertyValue): SynapsePropertyValue =>
		value === DATE_TOKEN
			? date
			: Array.isArray(value)
				? value.map((item) => (item === DATE_TOKEN ? date : item))
				: value;
	return Object.fromEntries(
		Object.entries(template.properties).map(([key, value]) => [
			key,
			fill(value),
		]),
	);
}

/** The template as an Obsidian file, with `{{date}}` left in place. */
export function templateMarkdown(template: SynapseTemplate): string {
	return renderMarkdown(
		template.properties,
		template.body,
		new Set([DATE_TOKEN]),
	);
}

export const templateFileName = (template: SynapseTemplate) =>
	`Templates/${template.name} Template.md`;

/**
 * Export folder for a note: `Categories/` for category notes, `Daily/` for
 * daily notes, else the folder of the first category with a built-in template.
 */
export function exportFolder(note: {
	title: string;
	tags: string[];
	categories: string[];
}): string {
	if (note.tags.includes("categories")) return CATEGORIES_FOLDER;
	if (note.tags.includes("daily") && /^\d{4}-\d{2}-\d{2}$/.test(note.title))
		return "Daily";
	for (const category of note.categories) {
		const template = templateForCategory(category);
		if (template?.folder) return template.folder;
	}
	return "";
}

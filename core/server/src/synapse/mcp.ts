import type {
	CreateSynapseProposalRequest,
	SynapseNoteView,
	SynapseProperties,
	SynapseProposalStatus,
	SynapseSpaceId,
} from "@autonomo.us/common";
import {
	type McpAgent,
	type McpArgs,
	type McpToolDefinition,
	type McpToolSet,
	type PropertySchema,
	schema,
} from "../mcp/server.js";
import { agentSpaceId, type SynapseService, sharedSpaceId } from "./synapse.js";

const SEARCH_LIMIT = 50;

export const MCP_INSTRUCTIONS = [
	"Synapse is your long-term memory: a space of linked Markdown notes that outlives this session.",
	"Search before you write (synapse_search); update or append to an existing note instead of creating a duplicate.",
	"Keep one note per thing: a person, company, project, or idea, titled with its name. Write evergreen ideas as one note per idea, titled as a statement.",
	"Always link the first mention of a person, project, company, or idea with [[Title]], even when no note exists yet; unresolved links are breadcrumbs for future notes (synapse_unresolved).",
	"Classify notes with the categories property by creating them from a template (synapse_templates); category and template names are plural, like People or Projects.",
	"Write dates as YYYY-MM-DD. Record what you did and decided with synapse_log; it goes into today's daily note, so link the notes involved.",
	'Your space is private to you. The shared space is your workspace\'s team canon, including notes inherited from the global Synapse: read it with space "shared", and change it only through synapse_propose, which a person reviews. Inherited notes can be overridden by proposing a note with the same title.',
].join("\n");

const title = (description: string): PropertySchema => ({
	type: "string",
	description,
	minLength: 1,
	maxLength: 200,
});
const space: PropertySchema = {
	type: "string",
	description:
		'"agent" (default) is your own private space; "shared" is the team canon.',
	enum: ["agent", "shared"],
};
const body: PropertySchema = {
	type: "string",
	description:
		"Markdown body without frontmatter. Link first mentions with [[Title]].",
};
const properties: PropertySchema = {
	type: "object",
	description:
		"Flat properties: strings, numbers, booleans, null, or lists of strings. Lists over text; dates as YYYY-MM-DD.",
};
const template: PropertySchema = {
	type: "string",
	description: "Built-in template name from synapse_templates, e.g. People.",
};

export const MCP_TOOLS: McpToolDefinition[] = [
	{
		name: "synapse_search",
		description:
			"Finds notes by words, category, tag, or backlinks. Every filter must match; results carry a snippet.",
		inputSchema: schema({
			query: {
				type: "string",
				description:
					"Words that must all appear in the title, body, or properties.",
				maxLength: 500,
			},
			category: title("Only notes in this category, e.g. People."),
			tag: {
				type: "string",
				description: "Only notes with this tag or a nested tag below it.",
				maxLength: 200,
			},
			linksTo: title("Only notes that link to this title (its backlinks)."),
			space,
			limit: {
				type: "integer",
				description: `Maximum results, default 10, at most ${SEARCH_LIMIT}.`,
				minimum: 1,
				maximum: SEARCH_LIMIT,
			},
		}),
	},
	{
		name: "synapse_read",
		description:
			"Reads a note with its backlinks, outgoing links, related notes, and category members.",
		inputSchema: schema({ title: title("Exact note title."), space }, [
			"title",
		]),
	},
	{
		name: "synapse_create",
		description:
			"Creates a note in your space, optionally from a template whose properties come first.",
		inputSchema: schema(
			{
				title: title("Unique title; also the file name."),
				template,
				body,
				properties,
			},
			["title"],
		),
	},
	{
		name: "synapse_update",
		description:
			"Changes a note in your space: rename (rewriting links to it), replace the body, or merge properties. Pass the revision you read to avoid overwriting a concurrent change.",
		inputSchema: schema(
			{
				title: title("Current title."),
				newTitle: title("New title; [[links]] to the old title are rewritten."),
				body,
				properties,
				revision: {
					type: "integer",
					description: "Revision you read; mismatches fail.",
					minimum: 1,
				},
			},
			["title"],
		),
	},
	{
		name: "synapse_append",
		description:
			"Adds text to the end of a note in your space, creating it (from a template if given) when it is missing.",
		inputSchema: schema(
			{
				title: title("Note title."),
				text: {
					type: "string",
					description: "Markdown to append.",
					minLength: 1,
				},
				template,
			},
			["title", "text"],
		),
	},
	{
		name: "synapse_delete",
		description:
			"Deletes a note from your space. Links to it become unresolved. Pass the revision you read to avoid deleting a newer change.",
		inputSchema: schema(
			{
				title: title("Note title."),
				revision: {
					type: "integer",
					description: "Revision you read; mismatches fail.",
					minimum: 1,
				},
			},
			["title"],
		),
	},
	{
		name: "synapse_log",
		description:
			"Records what you did or decided as a timestamped line in today's daily note. Link the notes involved.",
		inputSchema: schema(
			{ text: { type: "string", description: "One log line.", minLength: 1 } },
			["text"],
		),
	},
	{
		name: "synapse_daily",
		description:
			"Shows a day: its daily note and the notes created on, dated, or linking to that day.",
		inputSchema: schema({
			date: {
				type: "string",
				description: "YYYY-MM-DD; default today.",
				pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			},
			space,
		}),
	},
	{
		name: "synapse_unresolved",
		description:
			"Lists link targets with no note yet, most linked first: candidates for new notes.",
		inputSchema: schema({
			space,
			limit: {
				type: "integer",
				description: "Maximum results, default 50.",
				minimum: 1,
				maximum: 1000,
			},
		}),
	},
	{
		name: "synapse_templates",
		description:
			"Lists the built-in templates with their category, description, and default properties.",
		inputSchema: schema({}),
	},
	{
		name: "synapse_propose",
		description:
			"Proposes a change to the shared space for a person to approve: create, update, append, or delete a note, with a reason.",
		inputSchema: schema(
			{
				action: {
					type: "string",
					description: "What to do with the shared note.",
					enum: ["create", "update", "append", "delete"],
				},
				title: title("Shared note title."),
				newTitle: title("update: rename to this title."),
				body: { ...body, description: "create/update: the proposed body." },
				properties: {
					...properties,
					description: "create/update: properties merged into the note.",
				},
				text: {
					type: "string",
					description: "append: text to add.",
					minLength: 1,
				},
				reason: {
					type: "string",
					description: "Why the team canon should change.",
					minLength: 1,
					maxLength: 2000,
				},
			},
			["action", "title", "reason"],
		),
	},
	{
		name: "synapse_proposals",
		description: "Lists your proposals, newest first, optionally by status.",
		inputSchema: schema({
			status: {
				type: "string",
				description: "pending, approved, or rejected.",
				enum: ["pending", "approved", "rejected"],
			},
		}),
	},
];

/** The text form of synapse_read: the file plus its graph neighbourhood. */
export function noteViewText(view: SynapseNoteView): string {
	const list = (titles: string[]) =>
		titles.length ? titles.map((item) => `- [[${item}]]`).join("\n") : "(none)";
	return [
		view.markdown.trimEnd(),
		`## Backlinks\n${list(view.backlinks.map((note) => note.title))}`,
		`## Related\n${list(view.related.map((note) => note.title))}`,
		`## Unresolved links\n${list(
			view.outgoing.filter((link) => !link.exists).map((link) => link.title),
		)}`,
	].join("\n\n");
}

/** Shapes checked by the service's validateProperties, not here. */
const asProperties = (value: unknown) => value as SynapseProperties | undefined;

/** Synapse for agents: their own space, and their workspace's shared space. */
export function synapseToolSet(synapse: SynapseService): McpToolSet {
	const own = (agent: McpAgent) => agentSpaceId(agent.token.id);
	/** The shared space of the agent's workspace, which inherits global. */
	const shared = (agent: McpAgent) => sharedSpaceId(agent.workspace);
	const spaceOf = (agent: McpAgent, args: McpArgs): SynapseSpaceId =>
		args.space === "shared" ? shared(agent) : own(agent);
	return {
		instructions: MCP_INSTRUCTIONS,
		tools: MCP_TOOLS,
		text: (name, result) =>
			name === "synapse_read"
				? noteViewText(result as SynapseNoteView)
				: undefined,
		handlers: {
			synapse_search: (agent, args) =>
				synapse.query(spaceOf(agent, args), {
					text: args.query as string | undefined,
					category: args.category as string | undefined,
					tag: args.tag as string | undefined,
					linksTo: args.linksTo as string | undefined,
					limit: Math.min(
						SEARCH_LIMIT,
						(args.limit as number | undefined) ?? 10,
					),
				}),
			synapse_read: (agent, args) =>
				synapse.viewNote(spaceOf(agent, args), args.title as string),
			synapse_create: (agent, args) =>
				synapse.createNote(
					own(agent),
					{
						title: args.title as string,
						template: args.template as string | undefined,
						body: args.body as string | undefined,
						properties: asProperties(args.properties),
					},
					agent.actor,
				),
			synapse_update: (agent, args) =>
				synapse.updateNote(
					own(agent),
					args.title as string,
					{
						title: args.newTitle as string | undefined,
						body: args.body as string | undefined,
						properties: asProperties(args.properties),
						revision: args.revision as number | undefined,
					},
					agent.actor,
				),
			synapse_append: async (agent, args) =>
				(
					await synapse.appendNote(
						own(agent),
						args.title as string,
						{
							text: args.text as string,
							template: args.template as string | undefined,
						},
						agent.actor,
					)
				).note,
			synapse_delete: async (agent, args) => {
				await synapse.deleteNote(
					own(agent),
					args.title as string,
					agent.actor,
					args.revision as number | undefined,
				);
				return { deleted: args.title };
			},
			synapse_log: (agent, args) =>
				synapse.log(own(agent), args.text as string, agent.actor),
			synapse_daily: (agent, args) =>
				synapse.daily(
					spaceOf(agent, args),
					(args.date as string) ?? synapse.today(),
				),
			synapse_unresolved: async (agent, args) => ({
				links: await synapse.unresolved(
					spaceOf(agent, args),
					(args.limit as number | undefined) ?? 50,
				),
			}),
			synapse_templates: async () => ({ templates: synapse.templates() }),
			synapse_propose: (agent, args) =>
				synapse.propose(
					agent.actor,
					args as unknown as CreateSynapseProposalRequest,
					shared(agent),
				),
			synapse_proposals: async (agent, args) => ({
				proposals: await synapse.listProposals({
					authorId: agent.token.id,
					status: args.status as SynapseProposalStatus | undefined,
				}),
			}),
		},
	};
}

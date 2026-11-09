/**
 * Synapse: a built-in knowledge graph of linked Markdown notes for agents
 * and the team, modelled on Steph Ango's (kepano) Obsidian vault. Notes are
 * plain Markdown with properties (frontmatter), connected by [[wikilinks]],
 * classified with a `categories` property, and exportable as an Obsidian
 * space. See docs/SYNAPSE.md.
 */

/** Values a property may hold. Lists default over text when several values fit. */
export type SynapsePropertyValue = string | number | boolean | null | string[];
export type SynapseProperties = Record<string, SynapsePropertyValue>;

/**
 * `global` is the gateway-wide canon, above every workspace. Each workspace's
 * `shared` space is its team canon and inherits `global`: it shows the global
 * notes it does not override. Agents read `shared` and change it only through
 * reviewed proposals. `agent-<agentTokenId>` is one agent's private space,
 * keyed by its agent token ID, which survives token rolls.
 *
 * In storage, the default workspace's shared space is `shared` and another
 * workspace's is `shared-<workspaceId>`; requests always say `shared`.
 */
export type SynapseSpaceId =
	| "global"
	| "shared"
	| `shared-${string}`
	| `agent-${string}`;
export const SYNAPSE_SHARED_SPACE = "shared" as const;
export const SYNAPSE_GLOBAL_SPACE = "global" as const;
/** Space IDs in requests; workspace-qualified storage keys never appear in a path. */
export const SYNAPSE_SPACE_ID_PATTERN =
	"^(shared|global|agent-[A-Za-z0-9_-]{1,64})$";

/**
 * A [[link]] whose target ends in one of these extensions points at an
 * attachment, not a note. Only known formats count, so "Node.js" can be a note.
 */
export const SYNAPSE_ATTACHMENT_EXTENSIONS: readonly string[] = [
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"svg",
	"webp",
	"avif",
	"mp3",
	"wav",
	"m4a",
	"ogg",
	"3gp",
	"flac",
	"mp4",
	"webm",
	"ogv",
	"mov",
	"mkv",
	"pdf",
	"canvas",
	"base",
];

export type SynapseActor = {
	kind: "user" | "api-token" | "agent" | "system";
	id: string;
	name: string;
};

export type SynapseSpace = {
	id: SynapseSpaceId;
	kind: "global" | "shared" | "agent";
	/** "Global", "Shared", or the agent token's name when the space was last written. */
	name: string;
	/** Agent spaces only. */
	agentTokenId?: string;
	noteCount: number;
	createdAt: string | null;
	updatedAt: string | null;
};

export type SynapseSpaceList = {
	spaces: SynapseSpace[];
	persistence: "mongodb" | "memory";
	/** IANA time zone used for `{{date}}`, daily notes, and the log. */
	timeZone: string;
};

export type SynapseNote = {
	id: string;
	space: SynapseSpaceId;
	/** Unique per space, case-insensitively. Doubles as the file name. */
	title: string;
	properties: SynapseProperties;
	/** Markdown without frontmatter. */
	body: string;
	/** Outgoing [[link]] targets from the body and properties, deduped case-insensitively, in first-seen order. */
	links: string[];
	/** Tags from the `tags` property and inline #tags, without `#`, lowercased, deduped. */
	tags: string[];
	/** Link targets in the `categories` property, e.g. "People". */
	categories: string[];
	createdAt: string;
	updatedAt: string;
	createdBy: SynapseActor;
	updatedBy: SynapseActor;
	/** Starts at 1 and increments on every change, including link rewrites from renames. */
	revision: number;
};

export type SynapseNoteSummary = Pick<
	SynapseNote,
	| "id"
	| "space"
	| "title"
	| "categories"
	| "tags"
	| "createdAt"
	| "updatedAt"
	| "revision"
> & {
	/** Plain-text excerpt around the first search match, or the start of the body. */
	snippet: string;
};

export type SynapseOutgoingLink = { title: string; exists: boolean };

export type SynapseRelatedNote = SynapseNoteSummary & {
	/** Outgoing links this note shares with the viewed note. */
	sharedLinks: string[];
	sharedTags: string[];
	/** Either note links to the other. */
	direct: boolean;
};

/** Everything the dashboard and `synapse_read` show for one note. */
export type SynapseNoteView = {
	note: SynapseNote;
	/** Notes that link to this one, newest first. */
	backlinks: SynapseNoteSummary[];
	/** Outgoing links with whether each target note exists yet. */
	outgoing: SynapseOutgoingLink[];
	/** Notes related by link overlap (kepano's Related base), best first. */
	related: SynapseRelatedNote[];
	/** Notes whose `categories` include this note, when any do (category notes). */
	categoryMembers: SynapseNoteSummary[];
	/** The note as an Obsidian file: YAML frontmatter plus body. */
	markdown: string;
};

export type SynapseNoteSort = "updated" | "created" | "title" | "relevance";

export type SynapseQuery = {
	/** Every whitespace-separated term must appear in the title, body, or a property value (case-insensitive). */
	text?: string;
	/** Notes whose `categories` include this category title. */
	category?: string;
	/** Notes with this tag or a nested tag below it (`projects` matches `projects/active`). */
	tag?: string;
	/** Notes that link to this title (backlinks). */
	linksTo?: string;
	/** Property equality. List properties match when any item matches. Strings compare case-insensitively with [[ ]] stripped. */
	where?: Record<string, string | number | boolean>;
	/** Defaults to `relevance` with `text`, otherwise `updated`. */
	sort?: SynapseNoteSort;
	direction?: "asc" | "desc";
	/** Default 50, maximum 200. */
	limit?: number;
	offset?: number;
};

export type SynapseNoteList = { notes: SynapseNoteSummary[]; total: number };

export type CreateSynapseNoteRequest = {
	title: string;
	/** Template name from GET /v1/synapse/templates; its properties are filled first. */
	template?: string;
	body?: string;
	/** Merged over the template's properties. */
	properties?: SynapseProperties;
	/** A whole Obsidian file (frontmatter plus body). Replaces `body` and `properties` when present. */
	markdown?: string;
};

export type UpdateSynapseNoteRequest = {
	/** Renaming rewrites [[Old title]] links across the space, like Obsidian. */
	title?: string;
	body?: string;
	/** Merged into existing properties; a `null` value is stored as an empty property. Use `replaceProperties` to drop keys. */
	properties?: SynapseProperties;
	/** When true, `properties` replaces the whole property set. */
	replaceProperties?: boolean;
	/** A whole Obsidian file. Replaces `body` and all properties when present. */
	markdown?: string;
	/** Optimistic concurrency: rejected with 409 when the note has moved on. */
	revision?: number;
};

export type AppendSynapseNoteRequest = {
	text: string;
	/** Template for the note when it does not exist yet. */
	template?: string;
};

export type SynapseUnresolvedLink = {
	/** A link target with no note yet: a breadcrumb for a future note. */
	title: string;
	/** How many notes link to it. */
	count: number;
	/** Up to five titles of notes that link to it. */
	sources: string[];
};

export type SynapseCategory = {
	title: string;
	count: number;
	/** From the built-in template, when there is one. */
	description?: string;
	/** True when a note with this title exists. */
	exists: boolean;
};

/** What happened on one day, like kepano's Daily base. */
export type SynapseDaily = {
	/** YYYY-MM-DD. */
	date: string;
	/** The note titled with the date, when it exists. */
	note: SynapseNote | null;
	/** Other notes created that day, titled with the date, with a date property for that day, or linking to it. */
	entries: SynapseNoteSummary[];
};

export type SynapseTemplate = {
	/** Pluralized, like the category it creates: "People", "Projects". */
	name: string;
	/** Category title the template adds to `categories`; `null` for Daily. */
	category: string | null;
	description: string;
	/** Export folder: "References", "Clippings", "Daily", or "" for the vault root. */
	folder: string;
	/** Default properties. The string "{{date}}" becomes today's YYYY-MM-DD. */
	properties: SynapseProperties;
	/** Default body. */
	body: string;
};

export type SynapseFile = {
	/** Space-relative path with forward slashes, e.g. "References/Ada Lovelace.md". */
	path: string;
	content: string;
};

export type SynapseExport = { space: SynapseSpaceId; files: SynapseFile[] };

export type SynapseImportRequest = {
	files: SynapseFile[];
	/** Replace notes whose titles already exist. Otherwise they are skipped. */
	overwrite?: boolean;
};

export type SynapseImportResult = {
	created: string[];
	updated: string[];
	skipped: Array<{ path: string; reason: string }>;
};

export type SynapseProposalAction = "create" | "update" | "append" | "delete";
export type SynapseProposalStatus = "pending" | "approved" | "rejected";

/** An agent's request to change its workspace's shared space, decided by a workspace admin. */
export type SynapseProposal = {
	id: string;
	/** Always `shared` in responses: the shared space of the workspace it was filed in. */
	space: SynapseSpaceId;
	action: SynapseProposalAction;
	title: string;
	/** update: rename to this title. */
	newTitle?: string;
	/** create and update: the proposed body. */
	body?: string;
	/** create and update: properties merged into the note. */
	properties?: SynapseProperties;
	/** append: text added to the end of the note. */
	text?: string;
	/** Why the agent wants this change. */
	reason: string;
	status: SynapseProposalStatus;
	author: SynapseActor;
	createdAt: string;
	/** Revision of the shared note when proposed; approval fails with 409 if the note changed since. */
	baseRevision: number | null;
	decidedAt?: string;
	decidedBy?: SynapseActor;
	decisionReason?: string;
};

export type CreateSynapseProposalRequest = Pick<
	SynapseProposal,
	"action" | "title" | "newTitle" | "body" | "properties" | "text" | "reason"
>;

export type DecideSynapseProposalRequest = {
	decision: "approve" | "reject";
	/** Required to reject; written into the author agent's daily note. */
	reason?: string;
};

export type SynapseProposalList = { proposals: SynapseProposal[] };

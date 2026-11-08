/**
 * The Brain: a built-in knowledge graph of linked Markdown notes for agents
 * and the team, modelled on Steph Ango's (kepano) Obsidian vault. Notes are
 * plain Markdown with properties (frontmatter), connected by [[wikilinks]],
 * classified with a `categories` property, and exportable as an Obsidian
 * vault. See docs/BRAIN.md.
 */

/** Values a property may hold. Lists default over text when several values fit. */
export type BrainPropertyValue = string | number | boolean | null | string[];
export type BrainProperties = Record<string, BrainPropertyValue>;

/**
 * `shared` is the team canon: every agent can read it, and agents change it
 * only through reviewed proposals. `agent-<agentTokenId>` is one agent's
 * private vault, keyed by its agent token ID, which survives token rolls.
 */
export type BrainVaultId = "shared" | `agent-${string}`;
export const BRAIN_SHARED_VAULT = "shared" as const;
export const BRAIN_VAULT_ID_PATTERN = "^(shared|agent-[A-Za-z0-9_-]{1,64})$";

export type BrainActor = {
	kind: "user" | "api-token" | "agent" | "system";
	id: string;
	name: string;
};

export type BrainVault = {
	id: BrainVaultId;
	kind: "shared" | "agent";
	/** "Shared" or the agent token's name when the vault was last written. */
	name: string;
	/** Agent vaults only. */
	agentTokenId?: string;
	noteCount: number;
	createdAt: string | null;
	updatedAt: string | null;
};

export type BrainVaultList = {
	vaults: BrainVault[];
	persistence: "mongodb" | "memory";
	/** IANA time zone used for `{{date}}`, daily notes, and the log. */
	timeZone: string;
};

export type BrainNote = {
	id: string;
	vault: BrainVaultId;
	/** Unique per vault, case-insensitively. Doubles as the file name. */
	title: string;
	properties: BrainProperties;
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
	createdBy: BrainActor;
	updatedBy: BrainActor;
	/** Starts at 1 and increments on every change, including link rewrites from renames. */
	revision: number;
};

export type BrainNoteSummary = Pick<
	BrainNote,
	| "id"
	| "vault"
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

export type BrainOutgoingLink = { title: string; exists: boolean };

export type BrainRelatedNote = BrainNoteSummary & {
	/** Outgoing links this note shares with the viewed note. */
	sharedLinks: string[];
	sharedTags: string[];
	/** Either note links to the other. */
	direct: boolean;
};

/** Everything the dashboard and `brain_read` show for one note. */
export type BrainNoteView = {
	note: BrainNote;
	/** Notes that link to this one, newest first. */
	backlinks: BrainNoteSummary[];
	/** Outgoing links with whether each target note exists yet. */
	outgoing: BrainOutgoingLink[];
	/** Notes related by link overlap (kepano's Related base), best first. */
	related: BrainRelatedNote[];
	/** Notes whose `categories` include this note, when any do (category notes). */
	categoryMembers: BrainNoteSummary[];
	/** The note as an Obsidian file: YAML frontmatter plus body. */
	markdown: string;
};

export type BrainNoteSort = "updated" | "created" | "title" | "relevance";

export type BrainQuery = {
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
	sort?: BrainNoteSort;
	direction?: "asc" | "desc";
	/** Default 50, maximum 200. */
	limit?: number;
	offset?: number;
};

export type BrainNoteList = { notes: BrainNoteSummary[]; total: number };

export type CreateBrainNoteRequest = {
	title: string;
	/** Template name from GET /v1/brain/templates; its properties are filled first. */
	template?: string;
	body?: string;
	/** Merged over the template's properties. */
	properties?: BrainProperties;
	/** A whole Obsidian file (frontmatter plus body). Replaces `body` and `properties` when present. */
	markdown?: string;
};

export type UpdateBrainNoteRequest = {
	/** Renaming rewrites [[Old title]] links across the vault, like Obsidian. */
	title?: string;
	body?: string;
	/** Merged into existing properties; a `null` value is stored as an empty property. Use `replaceProperties` to drop keys. */
	properties?: BrainProperties;
	/** When true, `properties` replaces the whole property set. */
	replaceProperties?: boolean;
	/** A whole Obsidian file. Replaces `body` and all properties when present. */
	markdown?: string;
	/** Optimistic concurrency: rejected with 409 when the note has moved on. */
	revision?: number;
};

export type AppendBrainNoteRequest = {
	text: string;
	/** Template for the note when it does not exist yet. */
	template?: string;
};

export type BrainUnresolvedLink = {
	/** A link target with no note yet: a breadcrumb for a future note. */
	title: string;
	/** How many notes link to it. */
	count: number;
	/** Up to five titles of notes that link to it. */
	sources: string[];
};

export type BrainCategory = {
	title: string;
	count: number;
	/** From the built-in template, when there is one. */
	description?: string;
	/** True when a note with this title exists. */
	exists: boolean;
};

/** What happened on one day, like kepano's Daily base. */
export type BrainDaily = {
	/** YYYY-MM-DD. */
	date: string;
	/** The note titled with the date, when it exists. */
	note: BrainNote | null;
	/** Other notes created that day, titled with the date, with a date property for that day, or linking to it. */
	entries: BrainNoteSummary[];
};

export type BrainTemplate = {
	/** Pluralized, like the category it creates: "People", "Projects". */
	name: string;
	/** Category title the template adds to `categories`; `null` for Daily. */
	category: string | null;
	description: string;
	/** Export folder: "References", "Clippings", "Daily", or "" for the vault root. */
	folder: string;
	/** Default properties. The string "{{date}}" becomes today's YYYY-MM-DD. */
	properties: BrainProperties;
	/** Default body. */
	body: string;
};

export type BrainFile = {
	/** Vault-relative path with forward slashes, e.g. "References/Ada Lovelace.md". */
	path: string;
	content: string;
};

export type BrainExport = { vault: BrainVaultId; files: BrainFile[] };

export type BrainImportRequest = {
	files: BrainFile[];
	/** Replace notes whose titles already exist. Otherwise they are skipped. */
	overwrite?: boolean;
};

export type BrainImportResult = {
	created: string[];
	updated: string[];
	skipped: Array<{ path: string; reason: string }>;
};

export type BrainProposalAction = "create" | "update" | "append" | "delete";
export type BrainProposalStatus = "pending" | "approved" | "rejected";

/** An agent's request to change the shared vault, decided by an owner or admin. */
export type BrainProposal = {
	id: string;
	vault: "shared";
	action: BrainProposalAction;
	title: string;
	/** update: rename to this title. */
	newTitle?: string;
	/** create and update: the proposed body. */
	body?: string;
	/** create and update: properties merged into the note. */
	properties?: BrainProperties;
	/** append: text added to the end of the note. */
	text?: string;
	/** Why the agent wants this change. */
	reason: string;
	status: BrainProposalStatus;
	author: BrainActor;
	createdAt: string;
	/** Revision of the shared note when proposed; approval fails with 409 if the note changed since. */
	baseRevision: number | null;
	decidedAt?: string;
	decidedBy?: BrainActor;
	decisionReason?: string;
};

export type CreateBrainProposalRequest = Pick<
	BrainProposal,
	"action" | "title" | "newTitle" | "body" | "properties" | "text" | "reason"
>;

export type DecideBrainProposalRequest = {
	decision: "approve" | "reject";
	/** Required to reject; written into the author agent's daily note. */
	reason?: string;
};

export type BrainProposalList = { proposals: BrainProposal[] };

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
	/** Whether the note is still current: a decision's status, a draft, the last review. */
	standing: SynapseStanding;
	/** Where the note's claims come from: the lines of its `## Evidence` section. */
	evidence: SynapseEvidence[];
};

/** A decision's status. Written in the `status` property as `[[Active]]`, `[[Disputed]]`, or `[[Superseded]]`. */
export const SYNAPSE_DECISION_STATUSES = [
	"active",
	"disputed",
	"superseded",
] as const;
export type SynapseDecisionStatus = (typeof SYNAPSE_DECISION_STATUSES)[number];

/** "Is it still current?" for one note, read from its properties. */
export type SynapseStanding = {
	/** From the `status` property; null when the note carries none of the three. */
	status: SynapseDecisionStatus | null;
	/** Titles in `superseded_by`: what replaced this note. */
	supersededBy: string[];
	/** Titles in `supersedes`: what this note replaced. */
	supersedes: string[];
	/** The `reviewed` property, else `date`: when someone last confirmed it (YYYY-MM-DD). */
	reviewed: string | null;
	/** `status` says `[[Draft]]`: saved, not yet approved knowledge. */
	draft: boolean;
	/** False once the note is superseded. */
	current: boolean;
};

/**
 * One line of a note's `## Evidence` section:
 * `- [[Source]] (r3, 2026-11-18): "the passage"`. The source is a note, so the
 * line is also a link and shows among the source's backlinks.
 */
export type SynapseEvidence = {
	/** The source note's title as written. */
	source: string;
	/** The source's revision when it was cited, when the line records one. */
	revision: number | null;
	/** When it was cited (YYYY-MM-DD), when the line records it. */
	date: string | null;
	/** The quoted passage; empty when the line only links the source. */
	passage: string;
	/**
	 * `verified`: the passage is in the source as it stands. `changed`: the
	 * source no longer contains it (its history may). `missing`: no note with
	 * that title. `unquoted`: the line quotes nothing to check.
	 */
	state: "verified" | "changed" | "missing" | "unquoted";
};

export type CiteSynapseEvidenceRequest = {
	/** Title of the source note, in the same space. */
	source: string;
	/** Words copied from the source. They must appear in it. */
	passage: string;
};

export type SetSynapseDecisionStatusRequest = {
	status: SynapseDecisionStatus;
	/** superseded: the decision that replaces this one. */
	supersededBy?: string;
	/** Why; written into the decision's `## Status` log. */
	reason?: string;
};

export type SynapseRevisionChange = "created" | "updated" | "deleted";

/** One past state of a note, without its contents. */
export type SynapseRevisionSummary = {
	revision: number;
	/** The note's title at that revision. */
	title: string;
	change: SynapseRevisionChange;
	at: string;
	by: SynapseActor;
	/** Characters in the body. */
	size: number;
};

/** One past state of a note in full. A `deleted` revision holds what was deleted. */
export type SynapseRevision = SynapseRevisionSummary & {
	properties: SynapseProperties;
	body: string;
	/** That state as an Obsidian file. */
	markdown: string;
};

export type SynapseHistory = {
	title: string;
	/** False when the note has been deleted: its history remains. */
	exists: boolean;
	/** Newest first, up to the 200 latest. */
	revisions: SynapseRevisionSummary[];
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

/** A note, or a link target with no note yet, in a space's link graph. */
export type SynapseGraphNode = {
	/** The note's title, or the first-seen spelling of an unresolved target. */
	title: string;
	/** False for a link target with no note yet. */
	exists: boolean;
	/** The note's own space, so `shared` can tell the notes it inherits from `global`. Absent when `exists` is false. */
	space?: SynapseSpaceId;
	categories: string[];
	tags: string[];
	/** How many of the graph's edges touch this node. */
	degree: number;
};

/** An undirected link between two nodes, by title. Each pair appears once. */
export type SynapseGraphEdge = { source: string; target: string };

/** How a space's notes link together, capped at 1,000 nodes so a large space stays drawable. */
export type SynapseGraph = {
	/** Sorted by title. */
	nodes: SynapseGraphNode[];
	/** Sorted by source, then target. */
	edges: SynapseGraphEdge[];
	/** Notes in the space, before any cap. */
	noteCount: number;
	/** True when notes or unresolved targets were left out to stay under the cap. */
	truncated: boolean;
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

/** Advisory only: unresolved links may be intentional breadcrumbs. */
export type SynapseLinkWarning = {
	source: string;
	/** Full written target, before folder interpretation. */
	target: string;
	interpretedTarget: string;
	reason: "invalid-target" | "unresolved";
	suggestions: string[];
};

export type SynapseImportResult = {
	created: string[];
	updated: string[];
	skipped: Array<{ path: string; reason: string }>;
	/** Snapshot after this batch; later imports can resolve these links. */
	warnings?: SynapseLinkWarning[];
	warningsTruncated?: boolean;
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

/** What `synapse_capture` and "Save to Synapse" take: one of a URL, text, or a document. */
export type SynapseCaptureRequest = {
	/** The page's address. Fetched when no `text` comes with it; otherwise recorded as where the text came from. */
	url?: string;
	/** Text to keep as it is. */
	text?: string;
	/** A document's name and its text. */
	document?: { name: string; content: string };
	/** Title for the source note. Defaults to the document's name, the page's heading, or its address. */
	title?: string;
	/** Also make the prepared updates: append to the capturer's own notes, and propose appends to shared ones. */
	apply?: boolean;
};

/** An existing note the captured text mentions by title or alias. */
export type SynapseCaptureEntity = {
	title: string;
	space: SynapseSpaceId;
	categories: string[];
	/** Times the text names it. */
	mentions: number;
	/** The text around the first mention. */
	passage: string;
};

/** A line prepared for a note the capture mentions, and what became of it. */
export type SynapseCaptureUpdate = {
	title: string;
	space: SynapseSpaceId;
	/** The Markdown to append: a dated line that links the source and quotes the mention. */
	text: string;
	/**
	 * `prepared`: ready, not written. `applied`: appended. `proposed`: filed
	 * as a proposal for the shared space. `skipped`: not needed or not possible,
	 * with `detail` saying why.
	 */
	state: "prepared" | "applied" | "proposed" | "skipped";
	detail?: string;
	proposalId?: string;
};

export type SynapseCaptureResult = {
	source: {
		title: string;
		space: SynapseSpaceId;
		revision: number;
		/** `unchanged`: this exact content was captured before, and nothing was written. */
		status: "created" | "updated" | "unchanged";
		url: string | null;
		/** SHA-256 of the content with line endings and trailing space normalized. */
		hash: string;
		/** The content was longer than a note holds and was cut. */
		truncated: boolean;
		/** When it was first captured (YYYY-MM-DD). */
		captured: string | null;
		/** `updated`: how the content differs from the version before. */
		diff?: { added: number; removed: number; sample: string[] };
		/**
		 * An agent's capture whose updates were proposed for the shared space:
		 * the proposal that adds the source there too, so the lines that cite
		 * it lead somewhere once they are approved.
		 */
		proposalId?: string;
	};
	entities: SynapseCaptureEntity[];
	updates: SynapseCaptureUpdate[];
	/** What changed, in a sentence or two. */
	summary: string;
};

export type SynapseRetrieveRequest = {
	question: string;
	/** Passages to return. Default 8, maximum 30. */
	limit?: number;
};

/**
 * How far a passage can be trusted. `approved`: team canon (shared or
 * global). `unreviewed`: an agent's own note, which nobody reviewed. `draft`:
 * saved with `[[Draft]]` status. `disputed` and `superseded`: a decision's
 * status says so. `source`: captured or clipped material, kept as it was
 * found, which is somebody else's words wherever it is stored.
 */
export type SynapsePassageStanding =
	| "approved"
	| "unreviewed"
	| "draft"
	| "disputed"
	| "superseded"
	| "source";

/** A cited piece of a note that answers part of a question. */
export type SynapsePassage = {
	title: string;
	space: SynapseSpaceId;
	/** The heading the passage sits under, when it has one. */
	heading: string | null;
	text: string;
	/** Higher is better; comparable only within one retrieval. */
	score: number;
	/** The question's words this passage matched, as asked. */
	matched: string[];
	/** `text`: its words match. `link`: a matching note links to or from it. */
	via: "text" | "link";
	/** `link`: the matching note it was reached from. */
	from?: string;
	categories: string[];
	/** The note's own date: `date`, `published`, `start`, or `created`, else the day it last changed. */
	date: string | null;
	/** Dates the passage itself mentions (YYYY-MM-DD). */
	dates: string[];
	standing: SynapsePassageStanding;
	revision: number;
	updatedAt: string;
};

export type SynapseRetrieval = {
	question: string;
	passages: SynapsePassage[];
	/** The question's words that matched nothing: what Synapse does not know. */
	missing: string[];
	/** Links in the matching notes that have no note yet: knowledge someone meant to write. */
	unresolved: string[];
	/** Notes considered. */
	searched: number;
};

export type SaveSynapseAnswerRequest = {
	question: string;
	answer: string;
	/** What the answer rests on: source notes, each with the words it relies on. */
	evidence: CiteSynapseEvidenceRequest[];
	/** Defaults to the question. */
	title?: string;
};

export const SYNAPSE_COMMITMENT_STATUSES = [
	"open",
	"blocked",
	"done",
	"cancelled",
] as const;
export type SynapseCommitmentStatus =
	(typeof SYNAPSE_COMMITMENT_STATUSES)[number];

/** An obligation someone took on: a note in the Commitments category, read as a record. */
export type SynapseCommitment = {
	title: string;
	space: SynapseSpaceId;
	/** Who owes it: link targets of the `owner` property. */
	owner: string[];
	/** YYYY-MM-DD, or null when no date was promised. */
	due: string | null;
	status: SynapseCommitmentStatus;
	project: string[];
	/** The messages and notes it rests on: note titles, and message references such as `channel:<id>#<seq>`. */
	evidence: string[];
	/** Open or blocked, and past its due date. */
	overdue: boolean;
	updatedAt: string;
	revision: number;
};
export type SynapseCommitmentList = { commitments: SynapseCommitment[] };

export type CreateSynapseCommitmentRequest = {
	/** What is owed, as a short statement. */
	title: string;
	owner: string | string[];
	due?: string;
	project?: string | string[];
	/** The message or note where it was promised: a note title, a `[[link]]`, or a message reference. */
	evidence: string;
	body?: string;
};

/**
 * Something that happened to a commitment. `message`, `meeting`, and
 * `transcript` cite where it was said; `confirmation` is a person saying so.
 * `calendar` is scheduling context: it may move the due date, never the status.
 */
export type SynapseCommitmentEvent = {
	kind: "message" | "meeting" | "transcript" | "confirmation" | "calendar";
	/** New status. Needs `evidence` unless `kind` is `confirmation`; refused for `calendar`. */
	status?: SynapseCommitmentStatus;
	/** New due date (YYYY-MM-DD). */
	due?: string;
	/** A note title, a `[[link]]`, or a message reference. */
	evidence?: string;
	/** What happened, in a sentence. */
	text?: string;
};

export type SynapseContextRequest = {
	/** What the agent is about to do, in its own words. */
	task?: string;
	/** A project note's title, when the task belongs to one. */
	project?: string;
};

/** One line of a briefing: a note and the part of it that matters. */
export type SynapseContextItem = {
	title: string;
	space: SynapseSpaceId;
	text: string;
	date: string | null;
	/** Decisions: `disputed` marks one that is not settled. */
	status?: SynapseDecisionStatus;
};

/** A compact briefing for a task; see docs/SYNAPSE.md §15. */
export type SynapseContext = {
	generatedAt: string;
	task: string | null;
	/** What the agent is for: its description and its `Remit` note. */
	remit: string | null;
	/** Standing rules that apply to this agent. */
	rules: SynapseContextItem[];
	/** Goals of the projects the task concerns. */
	goals: SynapseContextItem[];
	/** Decisions in force. Superseded ones are left out. */
	decisions: SynapseContextItem[];
	/** Passages that bear on the task. */
	evidence: SynapsePassage[];
	/** Open questions. */
	questions: SynapseContextItem[];
	/** Overdue and blocked commitments, and the agent's own open ones. */
	commitments: SynapseCommitment[];
	/** The briefing as Markdown, cut to fit a prompt. */
	text: string;
	truncated: boolean;
};

export type SynapseFindingKind =
	| "duplicate"
	| "conflict"
	| "stale"
	| "unsupported";

/** What applying a finding does. A finding without one needs a person to edit the notes. */
export type SynapseFix =
	/** Appends `from` to `into`, points links at `into`, and deletes `from`. */
	| { action: "merge"; from: string; into: string }
	/** Records that the decision was reviewed today and still stands. */
	| { action: "confirm"; title: string }
	/** Marks the decision superseded by `by`. */
	| { action: "supersede"; title: string; by: string }
	/** Points links to `from`, a title with no note, at `into`, which lists it as an alias. */
	| { action: "relink"; from: string; into: string };

export type SynapseFinding = {
	id: string;
	kind: SynapseFindingKind;
	/** The notes it is about. */
	titles: string[];
	summary: string;
	fix: SynapseFix | null;
	state: "open" | "applied" | "dismissed";
	/** Why applying it failed, when it did. */
	detail?: string;
	decidedAt?: string;
	decidedBy?: SynapseActor;
};

/** "What changed / what needs you" since the last maintenance run. */
export type SynapseDigest = {
	/** When the run before this one finished, or null for the first. */
	since: string | null;
	changed: string[];
	needsYou: string[];
};

/** One maintenance run's findings for a space, reviewed as a batch. */
export type SynapseMaintenanceBatch = {
	id: string;
	space: SynapseSpaceId;
	createdAt: string;
	/** Increments with every decision, so two reviewers do not overwrite each other. */
	revision: number;
	findings: SynapseFinding[];
	digest: SynapseDigest;
};

export type SynapseMaintenanceView = {
	/** The latest run, or null before the first. */
	batch: SynapseMaintenanceBatch | null;
	/** Hours between automatic runs. */
	intervalHours: number;
};

export type DecideSynapseFindingsRequest = {
	ids: string[];
	decision: "apply" | "dismiss";
	/** The batch revision the reviewer saw. */
	revision?: number;
};

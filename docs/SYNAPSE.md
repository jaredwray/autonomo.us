# autonomo.us: Synapse

*Status: v2, November 2026. Companion to [DESIGN.md](./DESIGN.md) section 3 (Memory). Types live in [`core/common/src/synapse.ts`](../core/common/src/synapse.ts).*

Synapse is the gateway's built-in long-term memory for agents and the team: a knowledge graph of linked Markdown notes. Its shape is borrowed from Steph Ango's (kepano) Obsidian vault ([repository](https://github.com/kepano/kepano-obsidian), [write-up](https://stephango.com/vault)), because that method already solves the problem agents have: capturing a lot of loosely structured knowledge quickly, without deciding up front where it belongs, and still being able to find and connect it later.

It covers the **agent memory** and **shared memory** tiers from the design doc. Working memory stays in the agent's run.

On top of the notes, sections 13 to 18 add what makes them knowledge an agent can work from: every note keeps its history and says where its claims come from and whether they still hold; outside material is captured as sources; an agent is briefed when it starts a task; questions are answered with cited passages; commitments are tracked against real activity; and a background job keeps the whole thing tidy for a person to review. None of it leaves the format: sources, decisions, answers, and commitments are ordinary notes that export to Obsidian like any other.

## 1. What we take from kepano's vault

| Space convention | In Synapse |
| --- | --- |
| A space is a folder of plain Markdown files ("file over app"). | Notes are Markdown plus properties. Any space exports to Obsidian-compatible files and a `.zip` you can open in Obsidian, and imports back. |
| Bottom-up: few folders, structure emerges from links. | No folders. Notes are classified by the `categories` property and connected by links. Folders appear only in exports. |
| Link profusely; always link the first mention. | `[[wikilinks]]` in bodies and properties are parsed into the graph. Backlinks are computed. MCP instructions tell agents to link first mentions. |
| Unresolved links are breadcrumbs for future notes. | Unresolved links are listed (`synapse_unresolved`, dashboard) with how many notes point at them. Deleting a note leaves links to it unresolved. |
| `categories` property linking to category notes (`[[People]]`), each showing a Base of its members. | Same. A note whose title is used as a category shows its members. Missing category notes are created automatically, tagged `categories`. |
| Category templates define properties; short, shared, composable names; lists over text. | Built-in templates (section 4) seed properties. `{{date}}` becomes today's date. |
| Pluralize categories and tags. `YYYY-MM-DD` dates everywhere. | Template and category names are plural. All dates are `YYYY-MM-DD` in Synapse's time zone. |
| Daily notes `YYYY-MM-DD` exist to be linked to; the Daily base lists the day's notes. | `GET .../daily/:date` and `synapse_daily` list notes created that day, titled with the date, with a date property for it, or linking to it. |
| Related base: notes sharing outgoing links. | `related` uses the same formula (section 5). |
| Evergreen notes: one idea per note, titled as a statement. | The `Evergreen` template, and the MCP instructions encourage it. |
| Renaming updates links (`alwaysUpdateLinks`). | Renaming a note rewrites `[[Old]]` links across its space. |

Deliberate departures: agents append a timestamped log to the daily note (kepano leaves daily notes empty), because an agent's history of what it did is the most common memory it needs. Evergreen notes use `categories: [[Evergreen]]` instead of the `0🌲` tag. There is no rating property in templates.

## 2. Spaces, workspaces, and access

Synapse lives inside [workspaces](./WORKSPACES_PLAN.md), with one global canon above them all:

- **`global`**: the gateway-wide canon (company-wide brand voice, policies, people). Every workspace reads it. Only owners and admins change it, from the dashboard or the REST API.
- **`shared`**: one per workspace, that workspace's team canon (character sheets, its brand voice, standing decisions). It **inherits `global`**: reading `shared` shows the workspace's own notes plus every global note whose title the workspace does not use. A workspace note with the same title as a global note overrides it in that workspace only. Inherited notes are read-only in `shared` (409 "inherited from the global Synapse"); to change one for a workspace, create a note with its title there. Links, backlinks, related notes, categories, unresolved links, search, and daily views all see the inherited notes; export, import, and the note limit cover the workspace's own notes. Every agent with `mcp:call` reads its workspace's `shared`. Agents never write it directly: they file a **proposal**, which a workspace admin approves or rejects. Approval applies the change; a rejection's reason is appended to the author agent's daily note, so the agent learns from it (design doc: "reject reasons flow back into the author agent's memory").
- **`agent-<agentTokenId>`**: one agent's private space, created on first write. The agent token ID is stable across rolls, so rotating a credential keeps the memory. The space's display name is the token name at the last write. Agents cannot read each other's spaces, and the dashboard and REST API open an agent's space only in that agent's workspace. Agent spaces do not inherit `global`.

| Principal | Access |
| --- | --- |
| Agent token (`agt_…`) over MCP | `mcp:read`: `tools/list`. `mcp:call`: call tools. Read and write its own space; read its workspace's `shared` (with global notes); propose changes to that `shared`; list its own proposals. Refused while its workspace is archived. |
| Signed-in team member with access to a workspace | Read and write that workspace's `shared` and its agents' spaces, and read `global`, from the dashboard and `/v1/<workspace id>/synapse`, including importing and exporting. |
| Workspace admin (and owners and admins, who are admins of every workspace) | Also decides that workspace's proposals. |
| Owner or admin | Also changes `global`. |
| API token (bound to one workspace) | `synapse:read` for GET routes and for a briefing (`POST /synapse/context`), `synapse:edit` (includes read) for writes, import, and export, in its workspace. Reads `global`, never changes it, and never does what needs a person: deciding proposals, approving answers, or reviewing a maintenance batch. |

## 3. Notes

A note is `{ title, properties, body }` plus derived fields (`links`, `tags`, `categories`) and bookkeeping (`id`, `revision`, timestamps, actors). See `SynapseNote`.

**Titles** are the identity users and agents see, and the file name on export. They are unique per space, compared case-insensitively. A title is 1–200 characters, has no leading or trailing whitespace, does not start with `.`, and contains none of `\ / : * ? " < > | # ^ [ ]` or control characters (Obsidian's file name and link restrictions). Routes address notes by URL-encoded title.

**Links.** `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`, `[[Target#^block]]`, and embeds `![[Target]]` all link to `Target` (trimmed). Links inside fenced code blocks (```` ``` ```` or `~~~`) and inline code spans are ignored. Links inside property string values and list items count too, so `categories: ["[[People]]"]` links to `People`. Links resolve case-insensitively. `links` is in file order (properties, then body) and keeps the first-seen spelling, deduplicated case-insensitively. A link whose target ends in a known attachment extension (images, audio, video, PDF, `.canvas`, `.base`: `SYNAPSE_ATTACHMENT_EXTENSIONS`) is ignored, so `[[Node.js]]` still links to a note. `[[Note.md]]` and `[[Folder/Note]]` link to `Note`, and `[[Note\|alias]]` (a pipe escaped inside a table) links to `Note`.

**Tags** come from the `tags` property (a string or list; a leading `#` is stripped) and inline `#tags` in the body outside code. An inline tag starts after whitespace or line start, is made of letters, digits, `_`, `-`, `/` and emoji, and must contain at least one non-digit character. A line starting with `# ` is a heading, not a tag. Tags are stored lowercased and deduplicated.

**Categories** are the link targets found in the `categories` property, in order.

**Properties** are a flat object. Keys are 1–64 characters matching `^[A-Za-z0-9_][A-Za-z0-9_ .-]*$` other than `__proto__`, at most 50 per note. Values are strings (≤ 2,000 characters), finite numbers, booleans, `null` (an empty property), or lists of up to 100 strings (≤ 2,000 characters each). Dates are `YYYY-MM-DD` strings.

**Limits.** Body ≤ 100,000 characters. A space holds at most 10,000 notes. An append adds ≤ 20,000 characters, and the result must still fit the body limit. Violations return 400. (413 appears only when a request body exceeds its route's limit, such as the 5 MB import limit.)

**Concurrency.** Every change increments `revision`. Updates may send the `revision` they read; a mismatch returns 409. Titles are claimed atomically (duplicate titles return 409). A rename rewrites links in other notes one by one; it is not a transaction, so a crash mid-rename can leave some links pointing at the old (now unresolved) title.

**Rename rewrite.** When `Old` becomes `New`, every `[[Old…]]` in the space (body and property strings, any casing of `Old`) is rewritten to `[[New…]]`, keeping any `#heading`, `|alias`, and the `!` of embeds. Links inside code are left alone, as they are not links. Notes whose `categories` used `Old` now use `New`. Renaming a note in `global` also rewrites links in every workspace's `shared` space that inherits it, except in a workspace that has its own note titled `Old` or `New` (its links point at, or would land on, its own note). That check repeats before each note, so a workspace that creates such a note during the rename keeps its remaining links.

**Aliases.** The `aliases` property (Obsidian's own) lists other names a note goes by. Capture finds a note by its aliases as well as its title, retrieval matches a question against them, and maintenance treats a note whose title is another note's alias as a possible duplicate. Aliases do not resolve links: `[[Countess of Lovelace]]` is still unresolved until a note has that title.

**Category notes.** When a create, update, append, or import leaves a note with a category that has no note, Synapse creates that category note with `tags: ["categories"]` and the built-in template's description as its body (or an empty body for custom categories).

## 4. Built-in templates

Adapted from kepano's templates for an agent team. `{{date}}` is replaced with today's date when a note is created from the template. Template properties come first; request properties are merged over them.

| Template | Category | Folder | Properties |
| --- | --- | --- | --- |
| People | People | References | `org: []`, `role:`, `email:`, `url:`, `created: {{date}}` |
| Companies | Companies | References | `type: []`, `people: []`, `url:`, `created: {{date}}` |
| Projects | Projects | (root) | `type: []`, `org: []`, `start:`, `end:`, `status: []`, `url:`, `created: {{date}}` |
| Meetings | Meetings | (root) | `type: []`, `date: {{date}}`, `org: []`, `people: []`, `topics: []` |
| Decisions | Decisions | (root) | `date: {{date}}`, `status: ["[[Active]]"]`, `owner: []`, `topics: []` |
| Evergreen | Evergreen | (root) | `created: {{date}}`, `topics: []` |
| Clippings | Clippings | Clippings | `author: []`, `url:`, `published:`, `topics: []`, `created: {{date}}`, `tags: ["clippings"]` |
| Posts | Posts | (root) | `author: []`, `url:`, `published:`, `status: []`, `topics: []`, `created: {{date}}` |
| Events | Events | (root) | `type: []`, `start:`, `end:`, `loc:`, `people: []`, `created: {{date}}` |
| Products | Products | References | `type: []`, `maker: []`, `url:`, `price:`, `created: {{date}}` |
| Places | Places | References | `type: []`, `loc: []`, `url:`, `created: {{date}}` |
| Journal | Journal | (root) | `created: {{date}}`, `tags: ["journal"]` |
| Sources | Sources | Sources | `kind:`, `url:`, `author: []`, `published:`, `captured: {{date}}`, `hash:`, `topics: []` |
| Rules | Rules | (root) | `status: ["[[Active]]"]`, `applies_to: []`, `topics: []`, `created: {{date}}` |
| Questions | Questions | (root) | `status: ["[[Open]]"]`, `project: []`, `asked: {{date}}`, `topics: []` |
| Answers | Answers | (root) | `question:`, `status: ["[[Draft]]"]`, `sources: []`, `asked: {{date}}`, `topics: []` |
| Commitments | Commitments | (root) | `owner: []`, `due:`, `status: ["[[Open]]"]`, `project: []`, `evidence: []`, `created: {{date}}` |
| Daily | (none) | Daily | `tags: ["daily"]` |

Every template with a category also sets `categories: ["[[<Category>]]"]`. Descriptions (one sentence each, used for category notes and `synapse_templates`) should explain what belongs in the category, e.g. People: "People the team works with or learns from. Link them from meetings, projects, and clippings."

## 5. Finding things

**Query** (`SynapseQuery`, `GET /v1/<workspace id>/synapse/spaces/:space/notes`): all given filters must match.

- `text`: every whitespace-separated term (case-insensitive) appears in the title, body, or any property value. Relevance ranks a note higher when terms appear in the title (exact title match highest, then title contains all terms), then by how many times terms appear in the body, then by `updatedAt`.
- `category`, `tag` (nested tags match: `projects` matches `projects/active`), `linksTo` (backlinks), and `where` (property equality; list properties match when any item matches; strings compare case-insensitively after stripping `[[ ]]`).
- `sort`: `relevance` (default with `text`), `updated` (default otherwise), `created`, `title`. `direction` defaults to `desc` for dates and relevance, `asc` for title. `limit` defaults to 50 (max 200).
- Summaries include a `snippet`: about 160 characters of plain text around the first body match of any term, or the start of the body, with Markdown syntax for links (`[[A|b]]` → `b`) and leading heading markers flattened.

**Backlinks**: notes whose links include the title, newest first, up to 100.

**Related** (kepano's `Related.base`): for the viewed note N, a candidate C is related if C links to N, N links to C, or they share more than two outgoing links. Sort by shared-link count, then shared-tag count, then C's backlink count, all descending; return up to 20. The category link counts as a shared link, as in Obsidian, which is why the threshold is above two.

**Unresolved links**: targets with no note, sorted by how many notes link to them (descending), then title.

**Categories**: every category used in the space with its member count, plus built-in categories in use. `exists` tells whether the category note exists.

**Graph** (`SynapseGraph`, Obsidian's graph view): every note is a node and every link an undirected edge, so `A → B` and `B → A` are one edge and a note's link to itself is none. Links come from bodies and properties, `categories` included, and resolve case-insensitively to the note's own spelling. A link to a missing note makes an unresolved node (`exists: false`) with the spelling of the first note, by title, that uses it. In `shared`, inherited global notes are nodes too, with `space: "global"`. Nodes are sorted by title and edges by source, then target. At most 1,000 nodes are returned: the notes with the most distinct neighbours first (ties by title), then, in the room left, the unresolved targets most linked from those notes. Edges to anything left out are dropped, `degree` counts the edges that remain, `noteCount` is the space's full note count, and `truncated` says something was left out.

**Daily** (kepano's `Daily.base`) for date D: the note titled `D` (if any), and entries: other notes whose title starts with `D`, whose `createdAt` falls on D in Synapse's time zone, whose `created`, `date`, `start`, `end`, or `published` property starts with D, or that link to `[[D]]`. Newest first, up to 200.

**Questions** are answered by retrieval (section 16), which matches word forms and aliases, follows links, and returns cited passages instead of note summaries.

**Time zone**: `SYNAPSE_TIME_ZONE` (an IANA name, default `UTC`) decides "today" for `{{date}}`, daily notes, and the log.

## 6. Agent log and the daily note

`synapse_log` appends a line `- HH:mm <text>` to today's daily note in the agent's space, creating it from the Daily template if needed. Lines go under a `## Log` heading, which is added at the end of the body if missing. The log is how an agent records what it did and decided; linking the people, projects, and notes involved puts those events on their backlinks.

A rejected proposal appends `- HH:mm Proposal to <action> [[<title>]] in the shared space was rejected by <name>: <reason>` to the author's daily note. Note the `[[<title>]]` here is a breadcrumb into the agent's own space, which is intended.

## 7. Proposals (reviewed writes to `shared`)

A proposal belongs to the workspace of the agent that filed it and changes that workspace's own `shared` notes. Workspace admins see and decide only their workspace's proposals; another workspace's proposal is 404. An agent files `{ action, title, newTitle?, body?, properties?, text?, reason }`:

- `create`: the title must not exist among the workspace's own notes (400 if it does). A title only `global` has is allowed and overrides that note in the workspace. `body` and/or `properties`.
- `update`: the note must exist (404 otherwise). Optional `newTitle`, `body`, `properties` (merged). At least one change. For `update`, `append`, and `delete`, a note the workspace only inherits is refused with 409: propose `create` to override it.
- `append`: the note must exist (404 otherwise); `text` required.
- `delete`: the note must exist (404 otherwise).

The proposal records `baseRevision` (the shared note's revision, or `null` for create). An agent may have at most 50 pending proposals. Proposals are listed newest first, filterable by status, and agents see only their own.

An owner or admin decides. **Approve** first takes a 60-second claim on the proposal, applies the change as that owner or admin, and only then records it as approved. While the claim is live the proposal stays pending and any other decision gets 409, so an approval and a rejection can never both take effect. If the process dies mid-approval, the claim expires and the proposal can be decided again; it is never left approved without its change. Update, append, and delete write only to `baseRevision`. If the note's revision no longer equals `baseRevision`, a create's title is now taken, or the note is gone, approval returns 409, the claim is released, and the reviewer can reject the proposal. **Reject** requires a reason (1–2,000 characters). Decided proposals cannot be decided again (409).

## 8. Export and import ("file over app")

**Export** (`GET .../export`, JSON `SynapseExport`; `?format=zip` returns an uncompressed `.zip` named `<space>.zip`):

- One file per note at `<folder>/<title>.md` (no folder means the vault root). The folder comes from the first of the note's categories that has a built-in template with a folder; notes tagged `categories` go in `Categories/`; daily notes (title `YYYY-MM-DD` with tag `daily`) go in `Daily/`.
- Each built-in template as `Templates/<Name> Template.md`, with `{{date}}` left in place.
- Content is YAML frontmatter (omitted when there are no properties) followed by the body.

**Frontmatter format** (written and read):

```yaml
---
categories:
  - "[[People]]"
org: []
role: Researcher
created: 2026-11-08
rating: 6
active: true
email:
---
```

Written: keys in stored order; `null` as `key:` with nothing after; numbers and booleans bare; empty lists as `[]`; non-empty lists as `  - item` lines. A string is written bare only when it is a `YYYY-MM-DD` date or is non-empty plain text that YAML would read back as the same string (no leading/trailing space; does not start with any of `- ? : , [ ] { } # & * ! | > ' " % @` or a backtick; contains no `: ` or ` #`; is not `true`, `false`, `null`, `~`, or a number). Otherwise it is written as a JSON double-quoted string.

When a note has no properties but its body starts with a `---` line (a horizontal rule), an empty block `---\n---` is written first so the file reads back the same.

Read (import and the `markdown` field): a leading byte-order mark is ignored; a frontmatter block starts with a `---` line and ends at the next `---` line (trailing whitespace allowed on both). Supported: `key: value` scalars (bare, double-quoted with JSON escapes, single-quoted with `''`), `key:` (null), `key: []`, flow lists `key: [a, "b"]`, block lists of `- item`, and a bare link `key: [[Note]]` as older spaces write it (read as the list `["[[Note]]"]`). `true`/`false` become booleans, integers and decimals become numbers (except `YYYY-MM-DD`, which stays a string), `null`/`~` become `null`. A non-string list item becomes its string form. Anything else (nested maps, `|` or `>` block scalars, anchors) is an error that names the line.

**Import** (`POST .../import`, `SynapseImportRequest`, up to 500 files and a 5 MB body): each `.md` file becomes a note titled with its file name minus `.md`, wherever its folder. Files under `.obsidian/`, `Templates/`, or any dot-folder, and non-`.md` files, are skipped with a reason. Invalid titles, duplicate titles within the request, frontmatter errors, and limit violations skip that file with a reason. Existing titles are skipped unless `overwrite` is true, in which case the note's body and properties are replaced. The exception is a category note Synapse generated and nobody has edited (created by the system, still at revision 1): an imported file with that title replaces it and counts as created, so a vault imported in several requests keeps its real category notes. Category notes are created afterwards for any missing categories.

## 9. MCP endpoint for agents

`POST /mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over Streamable HTTP in stateless mode: each request carries one JSON-RPC message and gets a JSON response (`application/json`). No session IDs, no server-initiated stream. It is implemented directly on Fastify with no SDK dependency. The transport lives in `core/server/src/mcp/server.ts` and serves one tool set per feature: Synapse's tools below, the `channels_*` tools described in [CHANNELS_PLAN.md](./CHANNELS_PLAN.md) section 8, the `models_*` tools, and `web_fetch`. `initialize` returns every set's instructions and `tools/list` every set's tools.

- **Auth**: `Authorization: Bearer agt_…` via `AgentTokenStore`. Missing, unknown, expired, or revoked tokens get HTTP 401 with `WWW-Authenticate: Bearer`. Session tokens, API tokens, and the setup token are not accepted.
- **Origin**: a request with an `Origin` header not allowed by `CORS_ORIGIN` gets 403 (DNS-rebinding protection required by the MCP spec).
- **Methods**: `GET` and `DELETE /mcp` return 405 with `Allow: POST`.
- **Messages**: `initialize` returns `protocolVersion` (the client's requested version if it is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, else `2025-11-25`), `capabilities: { tools: { listChanged: false } }`, `serverInfo: { name: "autonomo.us", version }`, and `instructions` (below). `ping` returns `{}`. Notifications (`notifications/*`, no `id`) return 202 with no body; any other method sent without an `id` is refused with HTTP 400 and `-32600`, so a request is never acknowledged and dropped. `tools/list` needs `mcp:read`; `tools/call` needs `mcp:call`; without them the JSON-RPC error is `-32001` with a message naming the missing grant (HTTP 200). Malformed JSON is `-32700` and a batch array or a non-object is `-32600`, both with HTTP 400; an unknown method is `-32601`; an unknown tool or invalid arguments is `-32602`. Tool failures (not found, validation, limits, conflicts) are tool results with `isError: true` and the message as text.
- **Results**: every tool returns `structuredContent` (the JSON result) and one text content item. The text is JSON, except `synapse_read`, whose text is the note's Markdown followed by `## Backlinks`, `## Related`, and `## Unresolved links` sections listing `[[titles]]`.

**Instructions** sent at `initialize` (condensed kepano rules): Synapse is your long-term memory; search before you write; one note per thing (person, company, project, idea) titled with its name, evergreen notes titled as a statement; always link the first mention of a person, project, company, or idea with `[[Title]]`, even when no note exists yet; set `categories` with a template (plural names); dates are `YYYY-MM-DD`; record what you did with `synapse_log`; your space is private; `shared` is the team canon you may read and change only with `synapse_propose`. Then, for sections 13 to 18: start every task with `synapse_context`; keep outside material with `synapse_capture`; say where a claim comes from with `synapse_cite`, and mind that a superseded decision no longer applies; answer from memory with `synapse_ask` and keep useful answers with `synapse_save_answer`; record promises with `synapse_commit`.

**Tools** (all names `synapse_*`, snake case for client compatibility). `space` is `"agent"` (default, your own) or `"shared"` where offered.

| Tool | Arguments | Result |
| --- | --- | --- |
| `synapse_search` | `query?`, `category?`, `tag?`, `linksTo?`, `space?`, `limit?` (≤ 50, default 10) | `SynapseNoteList` |
| `synapse_read` | `title`, `space?` | `SynapseNoteView` |
| `synapse_create` | `title`, `template?`, `body?`, `properties?` | `SynapseNote` (own space) |
| `synapse_update` | `title`, `newTitle?`, `body?`, `properties?`, `revision?` | `SynapseNote` |
| `synapse_append` | `title`, `text`, `template?` (creates the note if missing) | `SynapseNote` |
| `synapse_delete` | `title`, `revision?` | `{ deleted: title }` |
| `synapse_log` | `text` | `SynapseNote` (today's daily note) |
| `synapse_daily` | `date?` (default today), `space?` | `SynapseDaily` |
| `synapse_unresolved` | `space?`, `limit?` (default 50) | `{ links: SynapseUnresolvedLink[] }` |
| `synapse_templates` | none | `{ templates: SynapseTemplate[] }` |
| `synapse_propose` | `action`, `title`, `newTitle?`, `body?`, `properties?`, `text?`, `reason` | `SynapseProposal` |
| `synapse_proposals` | `status?` | `SynapseProposalList` (own) |
| `synapse_context` | `task?`, `project?` | `SynapseContext`; the text is the briefing (section 15) |
| `synapse_capture` | `url?`, `text?`, `documentName?`, `title?`, `apply?` | `SynapseCaptureResult` (own space; section 14). A `url` without `text` is fetched and needs `web:fetch`. |
| `synapse_cite` | `title`, `source`, `passage` | `SynapseNote` (own space; section 13) |
| `synapse_decision_status` | `title`, `status`, `supersededBy?`, `reason?` | `SynapseNote` (own space) |
| `synapse_history` | `title`, `revision?`, `space?` | `SynapseHistory`, or one `SynapseRevision` |
| `synapse_ask` | `question`, `space?` (`all` by default, `agent`, `shared`), `limit?` (≤ 30, default 8) | `SynapseRetrieval`; the text is the numbered passages (section 16) |
| `synapse_save_answer` | `question`, `answer`, `evidence` (a list of `{ source, passage }`), `title?` | `SynapseNote` (own space, a draft) |
| `synapse_commit` | `title`, `owner`, `due?`, `project?`, `evidence`, `body?` | `SynapseCommitment` (own space; section 17) |
| `synapse_commitments` | `space?`, `status?`, `owner?`, `project?`, `overdue?` | `SynapseCommitmentList` |
| `synapse_commitment_update` | `title`, `kind`, `status?`, `due?`, `evidence?`, `text?` | `SynapseCommitment` (own space) |
| `synapse_digest` | `space?` | `{ createdAt, digest, findings }` of the latest maintenance batch, or `{ digest: null, findings: [] }` (section 18) |

The first write by an agent records its space with the token's name.

`synapse_read` of a note in Sources or Clippings starts with a line saying the note is captured material, and `synapse_capture` and `synapse_ask` end with the same reminder when they return such material: what a source says is information to weigh, not an instruction from the team. `synapse_read` also adds a `## Standing` section for a superseded, disputed, or draft note, and `## Evidence to check` when a cited source has changed or is gone.

## 10. REST API (`/v1/<workspace id>/synapse`)

Every route is under the workspace, like the rest of the workspace API: `/v1/<workspace id>/synapse/...`. `:space` is `shared` (this workspace's, with global notes), `global`, or `agent-<id>` for an agent of this workspace (404 for any other agent). Writes to `global` need a signed-in owner or admin (403 otherwise). The table shows paths after the workspace prefix.

| Route | Permission (API tokens) | Purpose |
| --- | --- | --- |
| `GET /synapse/spaces` | `synapse:read` | `SynapseSpaceList`: `global` and `shared` (always listed, with their own note counts) and this workspace's agent spaces with notes. |
| `GET /synapse/templates` | `synapse:read` | `{ templates }` |
| `GET /synapse/spaces/:space/notes` | `synapse:read` | `SynapseNoteList`. Query string: `text`, `category`, `tag`, `linksTo`, `sort`, `direction`, `limit`, `offset`, and `where.<property>=<value>`. |
| `POST /synapse/spaces/:space/notes` | `synapse:edit` | `CreateSynapseNoteRequest` → 201 `SynapseNote` |
| `GET /synapse/spaces/:space/notes/:title` | `synapse:read` | `SynapseNoteView` |
| `PATCH /synapse/spaces/:space/notes/:title` | `synapse:edit` | `UpdateSynapseNoteRequest` → `SynapseNote` |
| `POST /synapse/spaces/:space/notes/:title/append` | `synapse:edit` | `AppendSynapseNoteRequest` → `SynapseNote` (201 when created) |
| `DELETE /synapse/spaces/:space/notes/:title` | `synapse:edit` | 204; with `?revision=` only that revision is deleted (409 otherwise) |
| `GET /synapse/spaces/:space/unresolved` | `synapse:read` | `{ links: SynapseUnresolvedLink[] }`; `?limit=` (default 200, max 1000) |
| `GET /synapse/spaces/:space/categories` | `synapse:read` | `{ categories: SynapseCategory[] }` |
| `GET /synapse/spaces/:space/graph` | `synapse:read` | `SynapseGraph`: nodes and edges, capped at 1,000 nodes |
| `GET /synapse/spaces/:space/daily/:date` | `synapse:read` | `SynapseDaily` |
| `GET /synapse/spaces/:space/export` | `synapse:edit` | `SynapseExport`, or a zip with `?format=zip` |
| `POST /synapse/spaces/:space/import` | `synapse:edit` | `SynapseImportRequest` → `SynapseImportResult` |
| `GET /synapse/spaces/:space/notes/:title/history` | `synapse:read` | `SynapseHistory` (section 13) |
| `GET /synapse/spaces/:space/notes/:title/history/:revision` | `synapse:read` | `SynapseRevision` |
| `POST /synapse/spaces/:space/notes/:title/history/:revision/restore` | `synapse:edit` | `SynapseNote`, with that state as its newest revision |
| `POST /synapse/spaces/:space/notes/:title/evidence` | `synapse:edit` | `CiteSynapseEvidenceRequest` → `{ note, evidence }` |
| `POST /synapse/spaces/:space/notes/:title/status` | `synapse:edit` | `SetSynapseDecisionStatusRequest` → `SynapseNote` |
| `POST /synapse/spaces/:space/notes/:title/approve` | `synapse:edit`, signed-in person only | Approves a draft answer → `SynapseNote` |
| `POST /synapse/spaces/:space/capture` | `synapse:edit` | `SynapseCaptureRequest` → `SynapseCaptureResult` (section 14); body up to 2 MB |
| `GET /synapse/spaces/:space/retrieve` | `synapse:read` | `SynapseRetrieval`; `?question=` (required), `?limit=` (section 16) |
| `POST /synapse/spaces/:space/answers` | `synapse:edit` | `SaveSynapseAnswerRequest` → 201 `SynapseNote` |
| `GET /synapse/spaces/:space/commitments` | `synapse:read` | `SynapseCommitmentList`; `?status=`, `?owner=`, `?project=`, `?overdue=` (section 17) |
| `POST /synapse/spaces/:space/commitments` | `synapse:edit` | `CreateSynapseCommitmentRequest` → 201 `SynapseCommitment` |
| `POST /synapse/spaces/:space/commitments/:title/events` | `synapse:edit` | `SynapseCommitmentEvent` → `SynapseCommitment` |
| `POST /synapse/context` | `synapse:read` | `SynapseContextRequest` plus `agent?` (an agent ID of this workspace) → `SynapseContext` (section 15) |
| `GET /synapse/spaces/:space/maintenance` | `synapse:read` | `SynapseMaintenanceView` (section 18) |
| `POST /synapse/spaces/:space/maintenance/run` | `synapse:edit` | Runs the space now → `{ batch }`; 409 while another run holds it |
| `POST /synapse/spaces/:space/maintenance/decide` | `synapse:edit`, signed-in person only | `DecideSynapseFindingsRequest` → `SynapseMaintenanceBatch` |
| `GET /synapse/proposals` | `synapse:read` | `SynapseProposalList`; `?status=` |
| `POST /synapse/proposals/:id/decide` | none (signed-in workspace admin only) | `DecideSynapseProposalRequest` → `SynapseProposal` |

Export needs `synapse:edit` because it hands out a space's full contents in one request. Spaces are created by their first write, so a space with no notes reads as empty. IDs that do not match `SYNAPSE_SPACE_ID_PATTERN` return 400. Errors use the gateway's `{ error: { message } }` shape.

## 11. Persistence

With `MONGODB_URI`, notes live in `synapse_notes`, space records in `synapse_spaces`, proposals in `synapse_proposals`, past states of notes in `synapse_revisions`, and each space's maintenance record in `synapse_maintenance`. Each note document stores the public fields plus lowercased `titleKey`, `linkKeys`, `categoryKeys`, `tagKeys`, and `searchText`, with indexes on `{space, titleKey}` (unique), `{space, linkKeys}`, `{space, categoryKeys}`, `{space, tagKeys}`, and `{space, updatedAt}`. Indexes are created once per process on first use. Queries run in MongoDB; text terms use escaped, anchored-free regexes over `searchText`, and relevance ranking runs on at most 1,000 candidates. Notes written since aliases were indexed also store `aliasKeys`. A revision document is keyed `<note id>:<revision>` and indexed on `{noteId, revision}`, `{space, titleKey, at}` (a deleted note's history is found by the title it had), and `{space, at}`. A maintenance document is keyed by the space's storage key and holds its last run's time, its batch, the IDs of dismissed findings, and the lease of a run in progress. Retrieval narrows its candidates in MongoDB with one regex over `searchText` that matches any of the question's word roots. Without MongoDB, the same repository contract is implemented in memory and lasts until restart. If a configured MongoDB is unavailable, Synapse routes and tools fail with 503 (tools: `isError`).

Storage keys qualify the shared space by workspace: `global`, `shared` for the default workspace (the key Synapse used before workspaces, so existing notes and proposals stay with the default workspace), `shared-<workspaceId>` for any other workspace, and `agent-<agentTokenId>`. Requests and responses always say `shared`. A proposal stores the storage key of the shared space it targets. Inherited reads query both keys and skip global notes whose titles the workspace defines.

Every MongoDB client follows the gateway's per-request rules (`requestMongoClient`, closed in `releaseRequestResources`) so Synapse works in the Worker.

## 12. Dashboard

**Synapse** in the sidebar, inside the selected workspace (`#/w/<workspace id>/synapse/...`): pick a space (Global, the workspace's Shared, or one of its agents), see its graph, search and filter by category, browse notes, read a note (properties with clickable links, rendered Markdown with clickable wikilinks and dimmed unresolved ones, backlinks, related notes, unresolved outgoing links, category members), create from a template, edit the note's Markdown source, rename, delete, import an Obsidian vault folder or `.md` files (split into requests within the import limits, so a vault of any size imports), and export the space as a `.zip`. Note bodies render with a small React-only Markdown renderer whose patterns are linear-time, since agents write up to 100,000 characters per note. A **Proposals** tab lists pending agent proposals with the current and proposed text, and workspace admins approve or reject with a reason. Admins can also check several proposals (or **Select all**, which clears them again when all are checked) and **Approve selected**: the dashboard approves them one at a time, oldest first, so two proposals to the same note apply in the order they were filed. One that fails (for example a 409 because its note moved on) stays pending and checked, and the rest still apply. In Shared, notes inherited from Global carry a **Global** chip and open read-only, with **Override in this workspace** to create the workspace's own note with that title. Global is read-only for members.

**Graph.** With no note open, the main panel draws the space's graph, like Obsidian's graph view, drawn as a night sky in both themes: notes are stars that grow and brighten with how many links they have, links are faint lines, categories and notes inherited from Global are marked, and unresolved links are hollow (a checkbox hides them). Hovering or focusing a note highlights it with its neighbours and their labels; otherwise labels show for every note when zoomed in and for the best-linked dozen when zoomed out. Selecting a note opens it, and its page has **Back to graph**, where that note is ringed. Selecting an unresolved link opens the New note form with its title, for people who can write to the space. Drag the background to pan, drag a note to move it, scroll or use the buttons to zoom, and **Fit graph to view** to see it all again. **Full screen** lets the graph fill everything beside the app navigation: the page header, tabs, banners, and notes column give way, and the heading **Synapse Graph - <space>**, the controls, and the legend float on the sky. **Exit full screen**, or Esc (unless focus is in the app navigation), brings the page back, and selecting an unresolved link leaves full screen for the New note form. It stays on across spaces and after a visit to a note, until the page is reloaded. The layout is a small force simulation in `core/ux/src/synapse-graph-layout.ts` that starts from positions derived from the titles, so a space looks the same on every load; with `prefers-reduced-motion` it is computed in one step instead of animated. Each note in the graph is a link, and the notes list reaches every note without it. When the space has more notes than the graph returns, the panel says how many are shown.

## 13. Evidence, history, and standing

Every significant claim should answer two questions: where did this come from, and is it still current. Three things answer them, all read from the note itself.

**History.** Every change to a note records its new state: `{ revision, title, change, at, by, properties, body }`, where `change` is `created`, `updated`, or `deleted`. A deleted note's last record holds what was deleted, so its content survives the deletion, and its history is found by the title it had. `GET .../notes/:title/history` and `synapse_history` list the states newest first; one state is read in full by its revision; `POST .../history/:revision/restore` writes a past state back as the note's newest revision, or creates a deleted note again. Imports, link rewrites from a rename, and the category notes Synapse writes are recorded like any other write. A note that predates history shows its current state as its only record, and its next change records the state before it too, which also repairs a record that failed to write: recording history never fails the write it describes. Each note keeps its 200 latest states (`MAX_REVISIONS_PER_NOTE`); older ones are dropped, so a daily note logged to hundreds of times stays bounded. A note created under a deleted note's title starts a history of its own, and from then on the deleted note's states are no longer listed.

**Standing.** `SynapseNoteView.standing` is read from properties: `status` gives a decision's status when it links `[[Active]]`, `[[Disputed]]`, or `[[Superseded]]` (the strongest wins when several are listed) and marks a draft when it links `[[Draft]]`; `superseded_by` and `supersedes` name the notes on either side of a replacement; `reviewed`, else `date`, is when someone last confirmed it. `current` is false once a note is superseded. A decision is marked with `POST .../notes/:title/status` or `synapse_decision_status`, for notes in the Decisions category only: it sets `status` and `reviewed`, appends `- <date> <Status>[ by [[Replacement]]] (<who>)[: <reason>]` to the note's `## Status` section, and, when superseding, sets `superseded_by` on the old decision and adds it to `supersedes` on the one that replaces it. Marking a decision active or disputed again removes `superseded_by`. An agent marks decisions in its own space; for a shared decision it proposes the same properties with `synapse_propose`. Superseded decisions are left out of briefings and rank last in retrieval; disputed ones are flagged in both.

**Evidence.** A note says where its claims come from in an `## Evidence` section, one line per citation:

```markdown
## Evidence
- [[Q3 report]] (r3, 2026-11-18): "Revenue grew 12% in Q3."
```

The source is a note (usually in Sources, Clippings, or Meetings), so the line is also a link and the source lists the note among its backlinks. `r3` is the source's revision when it was cited and the date is when. `POST .../notes/:title/evidence` and `synapse_cite` add such a line after checking that the source contains the passage (case and whitespace aside); a passage the source does not contain is refused with 400, and citing the same passage twice adds nothing. Lines written by hand are read too: any bullet under `## Evidence` that starts with a link, with or without the parenthesis and the quote. `SynapseNoteView.evidence` returns each line with a `state` checked against the source as it stands: `verified`, `changed` (the source no longer contains the passage; its history shows what it said at the cited revision), `missing` (no note with that title), or `unquoted` (the line quotes nothing). The source is looked up in the note's own space, through inheritance.

## 14. Capture ("Save to Synapse")

`synapse_capture` and `POST .../spaces/:space/capture` take one of a URL, text, or a document and do four things.

**Preserve the source.** The content becomes a note in the Sources category whose body is the content as it was found, with line endings and trailing whitespace normalized, and whose properties record `kind` (`url`, `text`, or `document`), `url`, `file` (a document's name), `captured`, and `hash` (SHA-256 of the normalized content). A capture takes at most 500,000 characters and keeps the first 100,000 (a note's limit), marking the note `truncated: true` and saying so in its summary; capture a longer document in sections. The title is the one given, else the document's name without its extension, the page's first heading, its host and path, or the text's first line, made into a valid title.

**Deduplicate.** A capture is another version of an existing source when it has the same content (by `hash`), else the same address (`url`, compared exactly, fragment removed), else the title the caller named or the same document name. The same content again writes nothing and reports `status: "unchanged"` with the date it was first captured. Different content for the same address, title, or document updates that note, so its history (section 13) holds every version, and reports `status: "updated"` with how many lines were added and removed and the first few of each. A text captured without a title is always new, numbered `(2)`, `(3)` when its derived title is taken, because two pasted texts that start alike are rarely the same thing. A title the caller names that belongs to a note outside Sources is refused with 409.

**Identify existing notes.** The stored text is scanned once for the titles and aliases of existing notes, whole words only and whatever the case, the longer name winning where two start at the same word (`Ada Lovelace` is not also counted as `Ada`). Daily notes, category notes, other sources, and one-word names that are short or ordinary words are not looked for. The result lists each note mentioned with its space, categories, how often it is named, and the line around the first mention; the 30 most-mentioned are linked from the source's `topics` property, so the graph connects them at once. Over REST the notes are those the space shows; over MCP they are the agent's own notes and its workspace's shared space, the agent's own note winning a shared title.

**Prepare updates.** For each of the 20 most-mentioned notes the capture prepares a line in the evidence format, `- [[Source]] (r1, 2026-11-18): "the line that mentions it"`, to go under that note's `## Mentions` section. A note that already links the source is `skipped`, which is what makes a repeated capture quiet. With `apply: true` the lines are written: appended to notes of the capturer's own space (`applied`), and, for an agent, filed as update proposals for notes of the shared space (`proposed`, with the proposal's ID). Notes inherited from Global are `skipped` with the reason. A line that cannot be written (a full proposal queue, a note that keeps changing) stays `prepared` with the reason and never undoes the capture. The result ends with a `summary` sentence saying what changed.

**Fetching.** A capture that names a page and brings none of its text is fetched by the gateway exactly as `web_fetch` would fetch it (WEB_PROXIES_PLAN.md): over MCP it needs the `web:fetch` grant and follows the workspace's web rules and proxies; over REST only a signed-in workspace admin may, since a fetch can spend the proxy budget, and anyone else sends the page's text with the `url`. When web access is turned off, every capture needs the text.

**Captured text is outside material.** A page can say anything. In a hosted bot's reply a capture by address counts as reading the web: it needs the bot's web access and stays inside its web scope and follow-up limit, the reply's Synapse and channel tools are refused afterwards, and a capture made after the reply has already read a page only prepares its updates, whatever `apply` says. Briefings never quote Sources or Clippings (section 15), and `synapse_read`, `synapse_capture`, and `synapse_ask` label such material as information to weigh (section 9).

## 15. Briefings (`synapse_context`)

A briefing is what an agent should know before it starts a task, compact enough to sit beside a prompt. `synapse_context { task?, project? }` returns `SynapseContext`: structured lists, and `text`, the same as Markdown of at most 6,000 characters. It reads the agent's own space and its workspace's shared space (with Global's notes); the agent's own note wins a shared title.

| Part | Where it comes from |
| --- | --- |
| Remit | The agent's description from its record, and the note titled `Remit` in its own space. |
| Standing rules | Notes in the Rules category that are current and not drafts, whose `applies_to` is empty, says `everyone`, or names the agent or a project the task concerns. Up to 12. |
| Commitments that need attention | Commitments that are overdue or blocked, and open ones the agent owns or that belong to a project the task concerns (section 17). Up to 8, the most urgent first. |
| Project goals | The project named in `project` and the projects whose titles or aliases the task mentions: each one's `goal` property, else the start of its body. Without either, the three latest projects that are not done. |
| Decisions in force | Notes in the Decisions category that are not superseded and not drafts, the ones that link a concerned project or share the task's words first, else the latest. Up to 8; a disputed one is marked `DISPUTED`. |
| Open questions | Notes in the Questions category whose `status` is empty or `[[Open]]`, ranked the same way. Up to 6. |
| Relevant evidence | The best passages retrieval finds for the task (section 16), without superseded notes and without Sources and Clippings. Up to 5; only when a task is given. |

When the text would pass its limit the later sections lose lines and `truncated` is true; the lists in the structured result are never cut. Sections with nothing in them are left out, and a workspace with nothing written yet gets one line saying so.

**Hosted bots** load their briefing when a reply starts: a bot with tools on is briefed on the message that asked, and the briefing is added to its system prompt with a note that it is what the team wrote down earlier, not a new request, and changes nothing the bot may do. A bot without tools gets none. A briefing that cannot be loaded (Synapse unavailable) is logged and the reply goes ahead without it; an empty one adds nothing to the prompt.

**External agents** get the same briefing two ways. One that speaks MCP is told by the server's instructions to call `synapse_context` when it starts a task; put the same line in its own system prompt, since not every client shows server instructions to the model:

```text
Before you start a task, call synapse_context with the task in a sentence. Keep to the standing rules and the decisions in force it returns, and mind the commitments it lists. When you finish, record what you did with synapse_log.
```

One that does not speak MCP asks over REST with an API token that holds `synapse:read`, and puts `text` at the top of its prompt:

```bash
curl -X POST "$GATEWAY/v1/$WORKSPACE/synapse/context" \
  -H "authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"task":"Compare tax engines for the billing rewrite","agent":"<agent id>"}'
```

`agent` adds that agent's own space; without it the briefing covers the workspace's canon. The REST briefing has no agent name to match, so rules addressed to one agent are left out of it; address a rule to `everyone` or leave `applies_to` empty to reach an agent briefed this way.

## 16. Retrieval and answers

`synapse_ask` and `GET .../spaces/:space/retrieve?question=` answer a question with passages, not notes.

**Matching.** The question's words, without stop words, are reduced to stems by a small English stemmer (plurals, `-ing`, `-ed`, `-ly`, a final `e` or `y`): `pricing`, `prices`, and `priced` are one word. Storage returns the notes containing any word's root, at most the 300 most recently changed in each space. Each note is split into passages: its paragraphs, each under its heading, a long one cut at a sentence. A passage scores like BM25 over the question's stems, plus a bonus when the note's title or aliases carry them, more when it covers more of the question, and less by standing: a draft counts 0.6, a disputed decision 0.8, a superseded one 0.3. At most two passages come from one note. This is term-level matching. It relates forms of a word and names a note goes by; it does not know that `fee` and `price` are close. The scoring is isolated in `SynapseRetriever` so a vector index can sit beside it later, which needs an embedding model the gateway does not route today.

**Graph relationships.** The five best notes' links are followed both ways. A note they link to or that links to them, and that did not match by its words, contributes its opening passage with `via: "link"`, `from` naming the note it was reached through, and 0.35 of that note's score; up to a quarter of the result may come this way. This is how the project a matching decision is about shows up without sharing a word with the question.

**What comes back.** Each `SynapsePassage` has its note's title and space, heading, text, the words it matched, the note's own date (`date`, `published`, `start`, or `created`, else the day it last changed), the dates the passage mentions, and its `standing`: `approved` (the shared or global canon), `unreviewed` (an agent's own note), `draft`, `disputed`, or `superseded`. `missing` lists the question's words that matched nothing, which is what Synapse does not know; `unresolved` lists links written in the best notes that have no note yet, which is what someone meant to write.

**Answers.** The server does not write the answer; the agent or person does, from the passages. `synapse_save_answer` and `POST .../answers` keep it as a note in the Answers category: `question`, `status: ["[[Draft]]"]`, `sources` linking each source, and a body of the answer followed by an `## Evidence` section (section 13). At least one piece of evidence is required and each must quote its source exactly, so a saved answer always shows what it rests on, and its evidence goes `changed` if a source later moves on. **Drafts and approved knowledge** are told apart by status and by space. An answer stays a draft, and retrieval labels it `draft` and ranks it lower, until a person approves it: `POST .../notes/:title/approve` (signed-in people only) sets `status: ["[[Approved]]"]`, `approved`, and `approved_by`. An agent's saved answer lives in its own space, where everything is `unreviewed`; it becomes team knowledge by being proposed to the shared space and approved there (section 7).

## 17. Commitments

A commitment is a note in the Commitments category with an `owner`, a `due` date, a `status` (`[[Open]]`, `[[Blocked]]`, `[[Done]]`, or `[[Cancelled]]`), a `project`, and `evidence`: the message or meeting note where it was promised. `SynapseCommitment` is that note read as a record, with `overdue` true when it is open or blocked and past its due date in Synapse's time zone. `GET .../commitments` and `synapse_commitments` list them, overdue first, then by due date, filtered by status, owner, project, or overdue.

**Creating.** `synapse_commit` and `POST .../commitments` need a title, at least one owner, and evidence: a note title or `[[link]]` (stored as a link when the note exists), or a message reference such as `channel:<channel id>#<message number>`. The note starts with an `## Activity` section recording who promised what, where. Agents commit in their own space; a shared commitment is proposed like any shared note, or created by a person.

**Events.** What happens to a commitment is an event, `POST .../commitments/:title/events` or `synapse_commitment_update`, with a `kind` and any of a new `status`, a new `due` date, `evidence`, and a line of `text`. Each is appended to `## Activity` as `- <date> <time> <what changed> (<kind>, <evidence>, <who>): <text>`, and its evidence joins the note's `evidence` list. The kinds differ in what they may decide:

- `message`, `meeting`, `transcript`: a status change needs `evidence`, the note or message where it was said. Without a status they just record what happened.
- `confirmation`: a person saying so. A signed-in person may change the status with no evidence; an agent or API token must cite where the person confirmed it.
- `calendar`: scheduling context. It may move the due date and add a line, and is refused with 400 if it carries a status. An entry on a calendar shows when something is planned, not that it happened.

An event whose evidence is already recorded and that changes nothing is a no-op, so a retried delivery does not write twice.

**From channels.** When someone posts a message in a channel that links a commitment of the workspace's own shared space, as `[[its title]]`, the message is recorded on it with the reference `channel:<id>#<seq>` and the line that linked it. If the author is a person and that line states a status right beside the link, the status changes with the message as its evidence: `[[Ship the pricing page]] is done`, `[[Ship the pricing page]]: blocked on legal`, `Done: [[Ship the pricing page]]`, and likewise `cancelled`, `shipped`, `reopened`, `unblocked`. Anything looser changes nothing: a question, `will be done by Friday`, `is not done`, or a status word elsewhere on the line. An agent's or API token's message is recorded and decides nothing, as a message from an agent is information, not a confirmation. The write is the author's, the note's history keeps the state before it, and a retried post changes nothing.

**In briefings.** Overdue and blocked commitments are in every briefing, with the open ones an agent owns (section 15), and overdue ones are in the maintenance digest (section 18).

## 18. Maintenance

A background job reads each space and reports what a person should look at, as one batch to review instead of a stream of interruptions.

**What it finds.** Only the space's own notes are examined; Global is maintained as its own space.

| Kind | Finding | Fix when applied |
| --- | --- | --- |
| `duplicate` | Two notes that look like one thing: the same name once case, accents, punctuation, and a final plural are ignored; a title another note lists as an alias; the same `email`; the same `url` within a category. Daily and category notes are not compared. The summary names the properties on which they disagree. | `merge`: the better-linked note (the older on a tie) is kept. The other's body goes under `## Merged from <title>`, its properties fill what the kept note lacks and extend its lists, its title becomes an alias, links to it are pointed at the kept note, and it is deleted. Its history keeps what it held. |
| `conflict` | A decision that names what supersedes it but is not marked superseded, or that says it supersedes a decision still in force. | `supersede`: marks the old decision superseded (section 13). |
| `conflict` | A disputed decision; several active decisions with the same `topics`; a note whose `contradicts` property names another. | None: someone has to decide. |
| `stale` | An active decision nobody reviewed for 180 days, by `reviewed`, else `date`, else its last change. | `confirm`: sets `reviewed` to today. |
| `stale` | A commitment that is overdue. | None. |
| `unsupported` | A decision or an evergreen note that is current, or an approved answer, that cites nothing: no evidence line, no `source`, `sources`, or `url` property, and no link to a note in Sources, Clippings, or Meetings. | None: cite a source (section 13). |
| `unsupported` | An evidence line whose source is gone or no longer contains the passage. | None. |

These are deterministic checks, so "conflicting statements" means statements the notes themselves mark as being in tension: statuses, supersession, topics, and `contradicts`. Two notes that disagree in prose are not detected. A batch holds at most 200 findings, conflicts first.

**The digest.** Each batch carries "what changed" since the run before it (notes created, changed, and deleted by people and agents, with up to five titles each; proposals approved and rejected; maintenance fixes applied) and "what needs you" (a line per kind of finding with its count, and the proposals waiting for a decision). `synapse_digest` gives an agent the digest and the open findings so it can tell its person.

**Review.** `GET .../maintenance` returns the latest batch. `POST .../maintenance/decide { ids, decision, revision? }` applies the chosen findings' fixes or dismisses them, for signed-in people only, since applying merges and deletes notes: a token gets 403, and in Global only owners and admins may. Applying a finding without a fix is refused; a fix that fails (a note that changed or is gone) leaves its finding open with the reason while the rest apply. A dismissed finding is remembered by its ID, which is derived from its kind and the notes it is about, and later runs leave it out. The batch has a `revision` that every review increments, and a review sent with a stale one gets 409.

**Durability.** A run is a unit of work with state in storage, not a timer in a process. Each space has one maintenance record holding its last run, its batch, its dismissals, and the lease of a run in progress. A run starts by claiming the space atomically: the claim fails while another unexpired lease holds it or when the last run is newer than the interval, so replicas and Worker isolates run a space once. The lease lasts 5 minutes; a run that crashes simply stops holding it, and the next sweep runs the space again from the start, which is safe because a run only reads notes and writes its own record. A run counts from the moment it starts reading, so a note written while it reads is reported by the next one. The gateway's background sweep calls it: a 30-second timer in Node, and the scheduled invocation each minute in the container deployment (CLOUDFLARE-CONTAINERS.md). It looks for due spaces at most once a minute and runs at most two per sweep. The legacy Worker has no sweep between requests, so there a space is run from the dashboard or with `POST .../maintenance/run`. A space is due when it has never been run, when it changed since a run older than the interval (24 hours), or when it has not been run for seven intervals, since stale decisions and overdue commitments appear without anyone writing. `POST .../maintenance/run` runs a space at once, and returns 409 while another run holds it.

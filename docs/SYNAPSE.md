# autonomo.us: Synapse

*Status: v1, November 2026. Companion to [DESIGN.md](./DESIGN.md) section 3 (Memory). Types live in [`core/common/src/synapse.ts`](../core/common/src/synapse.ts).*

Synapse is the gateway's built-in long-term memory for agents and the team: a knowledge graph of linked Markdown notes. Its shape is borrowed from Steph Ango's (kepano) Obsidian vault ([repository](https://github.com/kepano/kepano-obsidian), [write-up](https://stephango.com/vault)), because that method already solves the problem agents have: capturing a lot of loosely structured knowledge quickly, without deciding up front where it belongs, and still being able to find and connect it later.

It covers the **agent memory** and **shared memory** tiers from the design doc. Working memory stays in the agent's run.

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
| API token (bound to one workspace) | `synapse:read` for GET routes, `synapse:edit` (includes read) for writes, import, and export, in its workspace. Reads `global`, never changes it, and never decides proposals: approvals need a person. |

## 3. Notes

A note is `{ title, properties, body }` plus derived fields (`links`, `tags`, `categories`) and bookkeeping (`id`, `revision`, timestamps, actors). See `SynapseNote`.

**Titles** are the identity users and agents see, and the file name on export. They are unique per space, compared case-insensitively. A title is 1–200 characters, has no leading or trailing whitespace, does not start with `.`, and contains none of `\ / : * ? " < > | # ^ [ ]` or control characters (Obsidian's file name and link restrictions). Routes address notes by URL-encoded title.

**Links.** `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`, `[[Target#^block]]`, and embeds `![[Target]]` all link to `Target` (trimmed). Links inside fenced code blocks (```` ``` ```` or `~~~`) and inline code spans are ignored. Links inside property string values and list items count too, so `categories: ["[[People]]"]` links to `People`. Links resolve case-insensitively. `links` is in file order (properties, then body) and keeps the first-seen spelling, deduplicated case-insensitively. A link whose target ends in a known attachment extension (images, audio, video, PDF, `.canvas`, `.base`: `SYNAPSE_ATTACHMENT_EXTENSIONS`) is ignored, so `[[Node.js]]` still links to a note. `[[Note.md]]` and `[[Folder/Note]]` link to `Note`, and `[[Note\|alias]]` (a pipe escaped inside a table) links to `Note`.

**Tags** come from the `tags` property (a string or list; a leading `#` is stripped) and inline `#tags` in the body outside code. An inline tag starts after whitespace or line start, is made of letters, digits, `_`, `-`, `/` and emoji, and must contain at least one non-digit character. A line starting with `# ` is a heading, not a tag. Tags are stored lowercased and deduplicated.

**Categories** are the link targets found in the `categories` property, in order.

**Properties** are a flat object. Keys are 1–64 characters matching `^[A-Za-z0-9_][A-Za-z0-9_ .-]*$` other than `__proto__`, at most 50 per note. Values are strings (≤ 2,000 characters), finite numbers, booleans, `null` (an empty property), or lists of up to 100 strings (≤ 2,000 characters each). Dates are `YYYY-MM-DD` strings.

**Limits.** Body ≤ 100,000 characters. A space holds at most 10,000 notes. An append adds ≤ 20,000 characters, and the result must still fit the body limit. Violations return 400. (413 appears only when a request body exceeds its route's limit, such as the 5 MB import limit.)

**Concurrency.** Every change increments `revision`. Updates may send the `revision` they read; a mismatch returns 409. Titles are claimed atomically (duplicate titles return 409). A rename rewrites links in other notes one by one; it is not a transaction, so a crash mid-rename can leave some links pointing at the old (now unresolved) title.

**Rename rewrite.** When `Old` becomes `New`, every `[[Old…]]` in the space (body and property strings, any casing of `Old`) is rewritten to `[[New…]]`, keeping any `#heading`, `|alias`, and the `!` of embeds. Links inside code are left alone, as they are not links. Notes whose `categories` used `Old` now use `New`. Renaming a note in `global` also rewrites links in every workspace's `shared` space that inherits it, except in a workspace that has its own note titled `Old` or `New` (its links point at, or would land on, its own note).

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

**Daily** (kepano's `Daily.base`) for date D: the note titled `D` (if any), and entries: other notes whose title starts with `D`, whose `createdAt` falls on D in Synapse's time zone, whose `created`, `date`, `start`, `end`, or `published` property starts with D, or that link to `[[D]]`. Newest first, up to 200.

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

`POST /mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over Streamable HTTP in stateless mode: each request carries one JSON-RPC message and gets a JSON response (`application/json`). No session IDs, no server-initiated stream. It is implemented directly on Fastify with no SDK dependency.

- **Auth**: `Authorization: Bearer agt_…` via `AgentTokenStore`. Missing, unknown, expired, or revoked tokens get HTTP 401 with `WWW-Authenticate: Bearer`. Session tokens, API tokens, and the setup token are not accepted.
- **Origin**: a request with an `Origin` header not allowed by `CORS_ORIGIN` gets 403 (DNS-rebinding protection required by the MCP spec).
- **Methods**: `GET` and `DELETE /mcp` return 405 with `Allow: POST`.
- **Messages**: `initialize` returns `protocolVersion` (the client's requested version if it is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, else `2025-11-25`), `capabilities: { tools: { listChanged: false } }`, `serverInfo: { name: "autonomo.us", version }`, and `instructions` (below). `ping` returns `{}`. Notifications (`notifications/*`, no `id`) return 202 with no body; any other method sent without an `id` is refused with HTTP 400 and `-32600`, so a request is never acknowledged and dropped. `tools/list` needs `mcp:read`; `tools/call` needs `mcp:call`; without them the JSON-RPC error is `-32001` with a message naming the missing grant (HTTP 200). Malformed JSON is `-32700` and a batch array or a non-object is `-32600`, both with HTTP 400; an unknown method is `-32601`; an unknown tool or invalid arguments is `-32602`. Tool failures (not found, validation, limits, conflicts) are tool results with `isError: true` and the message as text.
- **Results**: every tool returns `structuredContent` (the JSON result) and one text content item. The text is JSON, except `synapse_read`, whose text is the note's Markdown followed by `## Backlinks`, `## Related`, and `## Unresolved links` sections listing `[[titles]]`.

**Instructions** sent at `initialize` (condensed kepano rules): Synapse is your long-term memory; search before you write; one note per thing (person, company, project, idea) titled with its name, evergreen notes titled as a statement; always link the first mention of a person, project, company, or idea with `[[Title]]`, even when no note exists yet; set `categories` with a template (plural names); dates are `YYYY-MM-DD`; record what you did with `synapse_log`; your space is private; `shared` is the team canon you may read and change only with `synapse_propose`.

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

The first write by an agent records its space with the token's name.

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
| `GET /synapse/spaces/:space/daily/:date` | `synapse:read` | `SynapseDaily` |
| `GET /synapse/spaces/:space/export` | `synapse:edit` | `SynapseExport`, or a zip with `?format=zip` |
| `POST /synapse/spaces/:space/import` | `synapse:edit` | `SynapseImportRequest` → `SynapseImportResult` |
| `GET /synapse/proposals` | `synapse:read` | `SynapseProposalList`; `?status=` |
| `POST /synapse/proposals/:id/decide` | none (signed-in workspace admin only) | `DecideSynapseProposalRequest` → `SynapseProposal` |

Export needs `synapse:edit` because it hands out a space's full contents in one request. Spaces are created by their first write, so a space with no notes reads as empty. IDs that do not match `SYNAPSE_SPACE_ID_PATTERN` return 400. Errors use the gateway's `{ error: { message } }` shape.

## 11. Persistence

With `MONGODB_URI`, notes live in `synapse_notes`, space records in `synapse_spaces`, and proposals in `synapse_proposals`. Each note document stores the public fields plus lowercased `titleKey`, `linkKeys`, `categoryKeys`, `tagKeys`, and `searchText`, with indexes on `{space, titleKey}` (unique), `{space, linkKeys}`, `{space, categoryKeys}`, `{space, tagKeys}`, and `{space, updatedAt}`. Indexes are created once per process on first use. Queries run in MongoDB; text terms use escaped, anchored-free regexes over `searchText`, and relevance ranking runs on at most 1,000 candidates. Without MongoDB, the same repository contract is implemented in memory and lasts until restart. If a configured MongoDB is unavailable, Synapse routes and tools fail with 503 (tools: `isError`).

Storage keys qualify the shared space by workspace: `global`, `shared` for the default workspace (the key Synapse used before workspaces, so existing notes and proposals stay with the default workspace), `shared-<workspaceId>` for any other workspace, and `agent-<agentTokenId>`. Requests and responses always say `shared`. A proposal stores the storage key of the shared space it targets. Inherited reads query both keys and skip global notes whose titles the workspace defines.

Every MongoDB client follows the gateway's per-request rules (`requestMongoClient`, closed in `releaseRequestResources`) so Synapse works in the Worker.

## 12. Dashboard

**Synapse** in the sidebar, inside the selected workspace (`#/w/<workspace id>/synapse/...`): pick a space (Global, the workspace's Shared, or one of its agents), search and filter by category, browse notes, read a note (properties with clickable links, rendered Markdown with clickable wikilinks and dimmed unresolved ones, backlinks, related notes, unresolved outgoing links, category members), create from a template, edit the note's Markdown source, rename, delete, import an Obsidian vault folder or `.md` files (split into requests within the import limits, so a vault of any size imports), and export the space as a `.zip`. Note bodies render with a small React-only Markdown renderer whose patterns are linear-time, since agents write up to 100,000 characters per note. A **Proposals** tab lists pending agent proposals with the current and proposed text, and workspace admins approve or reject with a reason. In Shared, notes inherited from Global carry a **Global** chip and open read-only, with **Override in this workspace** to create the workspace's own note with that title. Global is read-only for members.

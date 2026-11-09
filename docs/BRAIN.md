# autonomo.us: The Brain

*Status: v1, November 2026. Companion to [DESIGN.md](./DESIGN.md) section 3 (Memory). Types live in [`core/common/src/brain.ts`](../core/common/src/brain.ts).*

The Brain is the gateway's built-in long-term memory for agents and the team: a knowledge graph of linked Markdown notes. Its shape is borrowed from Steph Ango's (kepano) Obsidian vault ([repository](https://github.com/kepano/kepano-obsidian), [write-up](https://stephango.com/vault)), because that method already solves the problem agents have: capturing a lot of loosely structured knowledge quickly, without deciding up front where it belongs, and still being able to find and connect it later.

It covers the **agent memory** and **shared memory** tiers from the design doc. Working memory stays in the agent's run.

## 1. What we take from kepano's vault

| Vault convention | In the Brain |
| --- | --- |
| A vault is a folder of plain Markdown files ("file over app"). | Notes are Markdown plus properties. Any vault exports to Obsidian-compatible files and a `.zip` you can open in Obsidian, and imports back. |
| Bottom-up: few folders, structure emerges from links. | No folders. Notes are classified by the `categories` property and connected by links. Folders appear only in exports. |
| Link profusely; always link the first mention. | `[[wikilinks]]` in bodies and properties are parsed into the graph. Backlinks are computed. MCP instructions tell agents to link first mentions. |
| Unresolved links are breadcrumbs for future notes. | Unresolved links are listed (`brain_unresolved`, dashboard) with how many notes point at them. Deleting a note leaves links to it unresolved. |
| `categories` property linking to category notes (`[[People]]`), each showing a Base of its members. | Same. A note whose title is used as a category shows its members. Missing category notes are created automatically, tagged `categories`. |
| Category templates define properties; short, shared, composable names; lists over text. | Built-in templates (section 4) seed properties. `{{date}}` becomes today's date. |
| Pluralize categories and tags. `YYYY-MM-DD` dates everywhere. | Template and category names are plural. All dates are `YYYY-MM-DD` in the Brain's time zone. |
| Daily notes `YYYY-MM-DD` exist to be linked to; the Daily base lists the day's notes. | `GET .../daily/:date` and `brain_daily` list notes created that day, titled with the date, with a date property for it, or linking to it. |
| Related base: notes sharing outgoing links. | `related` uses the same formula (section 5). |
| Evergreen notes: one idea per note, titled as a statement. | The `Evergreen` template, and the MCP instructions encourage it. |
| Renaming updates links (`alwaysUpdateLinks`). | Renaming a note rewrites `[[Old]]` links across its vault. |

Deliberate departures: agents append a timestamped log to the daily note (kepano leaves daily notes empty), because an agent's history of what it did is the most common memory it needs. Evergreen notes use `categories: [[Evergreen]]` instead of the `0🌲` tag. There is no rating property in templates.

## 2. Vaults and access

- **`shared`**: the team canon (character sheets, brand voice, standing decisions). Every agent with `mcp:call` can read it. Agents never write it directly: they file a **proposal**, which an owner or admin approves or rejects. Approval applies the change; a rejection's reason is appended to the author agent's daily note, so the agent learns from it (design doc: "reject reasons flow back into the author agent's memory").
- **`agent-<agentTokenId>`**: one agent's private vault, created on first write. The agent token ID is stable across rolls, so rotating a credential keeps the memory. The vault's display name is the token name at the last write. Agents cannot read each other's vaults.

| Principal | Access |
| --- | --- |
| Agent token (`agt_…`) over MCP | `mcp:read`: `tools/list`. `mcp:call`: call tools. Read and write its own vault; read `shared`; propose changes to `shared`; list its own proposals. |
| Signed-in team member (any role) | Read and write every vault from the dashboard and `/v1/brain`, including importing and exporting. |
| Owner or admin | Also decides proposals. |
| API token | `brain:read` for GET routes, `brain:edit` (includes read) for writes, import, and export. Never decides proposals: approvals need a person. |

## 3. Notes

A note is `{ title, properties, body }` plus derived fields (`links`, `tags`, `categories`) and bookkeeping (`id`, `revision`, timestamps, actors). See `BrainNote`.

**Titles** are the identity users and agents see, and the file name on export. They are unique per vault, compared case-insensitively. A title is 1–200 characters, has no leading or trailing whitespace, does not start with `.`, and contains none of `\ / : * ? " < > | # ^ [ ]` or control characters (Obsidian's file name and link restrictions). Routes address notes by URL-encoded title.

**Links.** `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`, `[[Target#^block]]`, and embeds `![[Target]]` all link to `Target` (trimmed). Links inside fenced code blocks (```` ``` ```` or `~~~`) and inline code spans are ignored. Links inside property string values and list items count too, so `categories: ["[[People]]"]` links to `People`. Links resolve case-insensitively. `links` is in file order (properties, then body) and keeps the first-seen spelling, deduplicated case-insensitively. A link whose target ends in a known attachment extension (images, audio, video, PDF, `.canvas`, `.base`: `BRAIN_ATTACHMENT_EXTENSIONS`) is ignored, so `[[Node.js]]` still links to a note. `[[Note.md]]` and `[[Folder/Note]]` link to `Note`, and `[[Note\|alias]]` (a pipe escaped inside a table) links to `Note`.

**Tags** come from the `tags` property (a string or list; a leading `#` is stripped) and inline `#tags` in the body outside code. An inline tag starts after whitespace or line start, is made of letters, digits, `_`, `-`, `/` and emoji, and must contain at least one non-digit character. A line starting with `# ` is a heading, not a tag. Tags are stored lowercased and deduplicated.

**Categories** are the link targets found in the `categories` property, in order.

**Properties** are a flat object. Keys are 1–64 characters matching `^[A-Za-z0-9_][A-Za-z0-9_ .-]*$` other than `__proto__`, at most 50 per note. Values are strings (≤ 2,000 characters), finite numbers, booleans, `null` (an empty property), or lists of up to 100 strings (≤ 2,000 characters each). Dates are `YYYY-MM-DD` strings.

**Limits.** Body ≤ 100,000 characters. A vault holds at most 10,000 notes. An append adds ≤ 20,000 characters, and the result must still fit the body limit. Violations return 400. (413 appears only when a request body exceeds its route's limit, such as the 5 MB import limit.)

**Concurrency.** Every change increments `revision`. Updates may send the `revision` they read; a mismatch returns 409. Titles are claimed atomically (duplicate titles return 409). A rename rewrites links in other notes one by one; it is not a transaction, so a crash mid-rename can leave some links pointing at the old (now unresolved) title.

**Rename rewrite.** When `Old` becomes `New`, every `[[Old…]]` in the vault (body and property strings, any casing of `Old`) is rewritten to `[[New…]]`, keeping any `#heading`, `|alias`, and the `!` of embeds. Links inside code are left alone, as they are not links. Notes whose `categories` used `Old` now use `New`.

**Category notes.** When a create, update, append, or import leaves a note with a category that has no note, the Brain creates that category note with `tags: ["categories"]` and the built-in template's description as its body (or an empty body for custom categories).

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

Every template with a category also sets `categories: ["[[<Category>]]"]`. Descriptions (one sentence each, used for category notes and `brain_templates`) should explain what belongs in the category, e.g. People: "People the team works with or learns from. Link them from meetings, projects, and clippings."

## 5. Finding things

**Query** (`BrainQuery`, `GET /v1/brain/vaults/:vault/notes`): all given filters must match.

- `text`: every whitespace-separated term (case-insensitive) appears in the title, body, or any property value. Relevance ranks a note higher when terms appear in the title (exact title match highest, then title contains all terms), then by how many times terms appear in the body, then by `updatedAt`.
- `category`, `tag` (nested tags match: `projects` matches `projects/active`), `linksTo` (backlinks), and `where` (property equality; list properties match when any item matches; strings compare case-insensitively after stripping `[[ ]]`).
- `sort`: `relevance` (default with `text`), `updated` (default otherwise), `created`, `title`. `direction` defaults to `desc` for dates and relevance, `asc` for title. `limit` defaults to 50 (max 200).
- Summaries include a `snippet`: about 160 characters of plain text around the first body match of any term, or the start of the body, with Markdown syntax for links (`[[A|b]]` → `b`) and leading heading markers flattened.

**Backlinks**: notes whose links include the title, newest first, up to 100.

**Related** (kepano's `Related.base`): for the viewed note N, a candidate C is related if C links to N, N links to C, or they share more than two outgoing links. Sort by shared-link count, then shared-tag count, then C's backlink count, all descending; return up to 20. The category link counts as a shared link, as in Obsidian, which is why the threshold is above two.

**Unresolved links**: targets with no note, sorted by how many notes link to them (descending), then title.

**Categories**: every category used in the vault with its member count, plus built-in categories in use. `exists` tells whether the category note exists.

**Daily** (kepano's `Daily.base`) for date D: the note titled `D` (if any), and entries: other notes whose title starts with `D`, whose `createdAt` falls on D in the Brain's time zone, whose `created`, `date`, `start`, `end`, or `published` property starts with D, or that link to `[[D]]`. Newest first, up to 200.

**Time zone**: `BRAIN_TIME_ZONE` (an IANA name, default `UTC`) decides "today" for `{{date}}`, daily notes, and the log.

## 6. Agent log and the daily note

`brain_log` appends a line `- HH:mm <text>` to today's daily note in the agent's vault, creating it from the Daily template if needed. Lines go under a `## Log` heading, which is added at the end of the body if missing. The log is how an agent records what it did and decided; linking the people, projects, and notes involved puts those events on their backlinks.

A rejected proposal appends `- HH:mm Proposal to <action> [[<title>]] in the shared brain was rejected by <name>: <reason>` to the author's daily note. Note the `[[<title>]]` here is a breadcrumb into the agent's own vault, which is intended.

## 7. Proposals (reviewed writes to `shared`)

An agent files `{ action, title, newTitle?, body?, properties?, text?, reason }`:

- `create`: the title must not exist in `shared` (400 if it does). `body` and/or `properties`.
- `update`: the note must exist (404 otherwise). Optional `newTitle`, `body`, `properties` (merged). At least one change.
- `append`: the note must exist (404 otherwise); `text` required.
- `delete`: the note must exist (404 otherwise).

The proposal records `baseRevision` (the shared note's revision, or `null` for create). An agent may have at most 50 pending proposals. Proposals are listed newest first, filterable by status, and agents see only their own.

An owner or admin decides. **Approve** first takes a 60-second claim on the proposal, applies the change as that owner or admin, and only then records it as approved. While the claim is live the proposal stays pending and any other decision gets 409, so an approval and a rejection can never both take effect. If the process dies mid-approval, the claim expires and the proposal can be decided again; it is never left approved without its change. Update, append, and delete write only to `baseRevision`. If the note's revision no longer equals `baseRevision`, a create's title is now taken, or the note is gone, approval returns 409, the claim is released, and the reviewer can reject the proposal. **Reject** requires a reason (1–2,000 characters). Decided proposals cannot be decided again (409).

## 8. Export and import ("file over app")

**Export** (`GET .../export`, JSON `BrainExport`; `?format=zip` returns an uncompressed `.zip` named `<vault>.zip`):

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

Read (import and the `markdown` field): a leading byte-order mark is ignored; a frontmatter block starts with a `---` line and ends at the next `---` line (trailing whitespace allowed on both). Supported: `key: value` scalars (bare, double-quoted with JSON escapes, single-quoted with `''`), `key:` (null), `key: []`, flow lists `key: [a, "b"]`, block lists of `- item`, and a bare link `key: [[Note]]` as older vaults write it (read as the list `["[[Note]]"]`). `true`/`false` become booleans, integers and decimals become numbers (except `YYYY-MM-DD`, which stays a string), `null`/`~` become `null`. A non-string list item becomes its string form. Anything else (nested maps, `|` or `>` block scalars, anchors) is an error that names the line.

**Import** (`POST .../import`, `BrainImportRequest`, up to 500 files and a 5 MB body): each `.md` file becomes a note titled with its file name minus `.md`, wherever its folder. Files under `.obsidian/`, `Templates/`, or any dot-folder, and non-`.md` files, are skipped with a reason. Invalid titles, duplicate titles within the request, frontmatter errors, and limit violations skip that file with a reason. Existing titles are skipped unless `overwrite` is true, in which case the note's body and properties are replaced. The exception is a category note the Brain generated and nobody has edited (created by the system, still at revision 1): an imported file with that title replaces it and counts as created, so a vault imported in several requests keeps its real category notes. Category notes are created afterwards for any missing categories.

## 9. MCP endpoint for agents

`POST /mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over Streamable HTTP in stateless mode: each request carries one JSON-RPC message and gets a JSON response (`application/json`). No session IDs, no server-initiated stream. It is implemented directly on Fastify with no SDK dependency.

- **Auth**: `Authorization: Bearer agt_…` via `AgentTokenStore`. Missing, unknown, expired, or revoked tokens get HTTP 401 with `WWW-Authenticate: Bearer`. Session tokens, API tokens, and the setup token are not accepted.
- **Origin**: a request with an `Origin` header not allowed by `CORS_ORIGIN` gets 403 (DNS-rebinding protection required by the MCP spec).
- **Methods**: `GET` and `DELETE /mcp` return 405 with `Allow: POST`.
- **Messages**: `initialize` returns `protocolVersion` (the client's requested version if it is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, else `2025-11-25`), `capabilities: { tools: { listChanged: false } }`, `serverInfo: { name: "autonomo.us", version }`, and `instructions` (below). `ping` returns `{}`. Notifications (`notifications/*`, no `id`) return 202 with no body; any other method sent without an `id` is refused with HTTP 400 and `-32600`, so a request is never acknowledged and dropped. `tools/list` needs `mcp:read`; `tools/call` needs `mcp:call`; without them the JSON-RPC error is `-32001` with a message naming the missing grant (HTTP 200). Malformed JSON is `-32700` and a batch array or a non-object is `-32600`, both with HTTP 400; an unknown method is `-32601`; an unknown tool or invalid arguments is `-32602`. Tool failures (not found, validation, limits, conflicts) are tool results with `isError: true` and the message as text.
- **Results**: every tool returns `structuredContent` (the JSON result) and one text content item. The text is JSON, except `brain_read`, whose text is the note's Markdown followed by `## Backlinks`, `## Related`, and `## Unresolved links` sections listing `[[titles]]`.

**Instructions** sent at `initialize` (condensed kepano rules): the Brain is your long-term memory; search before you write; one note per thing (person, company, project, idea) titled with its name, evergreen notes titled as a statement; always link the first mention of a person, project, company, or idea with `[[Title]]`, even when no note exists yet; set `categories` with a template (plural names); dates are `YYYY-MM-DD`; record what you did with `brain_log`; your vault is private; `shared` is the team canon you may read and change only with `brain_propose`.

**Tools** (all names `brain_*`, snake case for client compatibility). `vault` is `"agent"` (default, your own) or `"shared"` where offered.

| Tool | Arguments | Result |
| --- | --- | --- |
| `brain_search` | `query?`, `category?`, `tag?`, `linksTo?`, `vault?`, `limit?` (≤ 50, default 10) | `BrainNoteList` |
| `brain_read` | `title`, `vault?` | `BrainNoteView` |
| `brain_create` | `title`, `template?`, `body?`, `properties?` | `BrainNote` (own vault) |
| `brain_update` | `title`, `newTitle?`, `body?`, `properties?`, `revision?` | `BrainNote` |
| `brain_append` | `title`, `text`, `template?` (creates the note if missing) | `BrainNote` |
| `brain_delete` | `title`, `revision?` | `{ deleted: title }` |
| `brain_log` | `text` | `BrainNote` (today's daily note) |
| `brain_daily` | `date?` (default today), `vault?` | `BrainDaily` |
| `brain_unresolved` | `vault?`, `limit?` (default 50) | `{ links: BrainUnresolvedLink[] }` |
| `brain_templates` | none | `{ templates: BrainTemplate[] }` |
| `brain_propose` | `action`, `title`, `newTitle?`, `body?`, `properties?`, `text?`, `reason` | `BrainProposal` |
| `brain_proposals` | `status?` | `BrainProposalList` (own) |

The first write by an agent records its vault with the token's name.

## 10. REST API (`/v1/brain`)

| Route | Permission (API tokens) | Purpose |
| --- | --- | --- |
| `GET /v1/brain/vaults` | `brain:read` | `BrainVaultList`: `shared` (always listed) and agent vaults with notes. |
| `GET /v1/brain/templates` | `brain:read` | `{ templates }` |
| `GET /v1/brain/vaults/:vault/notes` | `brain:read` | `BrainNoteList`. Query string: `text`, `category`, `tag`, `linksTo`, `sort`, `direction`, `limit`, `offset`, and `where.<property>=<value>`. |
| `POST /v1/brain/vaults/:vault/notes` | `brain:edit` | `CreateBrainNoteRequest` → 201 `BrainNote` |
| `GET /v1/brain/vaults/:vault/notes/:title` | `brain:read` | `BrainNoteView` |
| `PATCH /v1/brain/vaults/:vault/notes/:title` | `brain:edit` | `UpdateBrainNoteRequest` → `BrainNote` |
| `POST /v1/brain/vaults/:vault/notes/:title/append` | `brain:edit` | `AppendBrainNoteRequest` → `BrainNote` (201 when created) |
| `DELETE /v1/brain/vaults/:vault/notes/:title` | `brain:edit` | 204; with `?revision=` only that revision is deleted (409 otherwise) |
| `GET /v1/brain/vaults/:vault/unresolved` | `brain:read` | `{ links: BrainUnresolvedLink[] }`; `?limit=` (default 200, max 1000) |
| `GET /v1/brain/vaults/:vault/categories` | `brain:read` | `{ categories: BrainCategory[] }` |
| `GET /v1/brain/vaults/:vault/daily/:date` | `brain:read` | `BrainDaily` |
| `GET /v1/brain/vaults/:vault/export` | `brain:edit` | `BrainExport`, or a zip with `?format=zip` |
| `POST /v1/brain/vaults/:vault/import` | `brain:edit` | `BrainImportRequest` → `BrainImportResult` |
| `GET /v1/brain/proposals` | `brain:read` | `BrainProposalList`; `?status=` |
| `POST /v1/brain/proposals/:id/decide` | none (signed-in owner or admin only) | `DecideBrainProposalRequest` → `BrainProposal` |

Export needs `brain:edit` because it hands out a vault's full contents in one request. Unknown vault IDs that match the pattern are empty vaults (reads return empty results; writes create them). IDs that do not match `BRAIN_VAULT_ID_PATTERN` return 400. Errors use the gateway's `{ error: { message } }` shape.

## 11. Persistence

With `MONGODB_URI`, notes live in `brain_notes`, vault records in `brain_vaults`, and proposals in `brain_proposals`. Each note document stores the public fields plus lowercased `titleKey`, `linkKeys`, `categoryKeys`, `tagKeys`, and `searchText`, with indexes on `{vault, titleKey}` (unique), `{vault, linkKeys}`, `{vault, categoryKeys}`, `{vault, tagKeys}`, and `{vault, updatedAt}`. Indexes are created once per process on first use. Queries run in MongoDB; text terms use escaped, anchored-free regexes over `searchText`, and relevance ranking runs on at most 1,000 candidates. Without MongoDB, the same repository contract is implemented in memory and lasts until restart. If a configured MongoDB is unavailable, Brain routes and tools fail with 503 (tools: `isError`).

Every MongoDB client follows the gateway's per-request rules (`requestMongoClient`, closed in `releaseRequestResources`) so the Brain works in the Worker.

## 12. Dashboard

**Brain** in the sidebar: pick a vault (Shared or an agent), search and filter by category, browse notes, read a note (properties with clickable links, rendered Markdown with clickable wikilinks and dimmed unresolved ones, backlinks, related notes, unresolved outgoing links, category members), create from a template, edit the note's Markdown source, rename, delete, import an Obsidian vault folder or `.md` files (split into requests within the import limits, so a vault of any size imports), and export the vault as a `.zip`. Note bodies render with a small React-only Markdown renderer whose patterns are linear-time, since agents write up to 100,000 characters per note. A **Proposals** tab lists pending agent proposals with the current and proposed text, and owners and admins approve or reject with a reason.

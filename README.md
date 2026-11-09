<div align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="media/logo-light.svg">
    <img alt="AUTONOMO.US" src="media/logo.svg" width="480">
  </picture>
</div>

# autonomo.us

AI platform for gateway, agents, and management.

## Packages

- **@autonomo.us/server** — Fastify server: the AI gateway API, which also hosts the dashboard build
- **@autonomo.us/ux** — React + Vite management dashboard
- **@autonomo.us/common** — Shared types and utilities
- **@autonomo.us/logo** — Animated AUTONOMOUS aurora logo (framework-agnostic SVG)

## Getting Started

Run the whole platform with docker compose — one server container (API gateway
and dashboard) plus MongoDB:

```bash
docker compose up --build
# Dashboard and API: http://localhost:3000
```

Add a real local LLM with the `llm` profile (Ollama):

```bash
docker compose --profile llm up --build -d
docker compose exec ollama ollama pull llama3.2
OPENAI_COMPAT_MODELS=llama3.2 docker compose up -d api
```

For Codespaces or VS Code Dev Containers, rebuild the container after changing
`.devcontainer/devcontainer.json`. The Docker-in-Docker feature supplies Docker
and Compose (Docker CE, `"moby": false`, because the Debian trixie base image has
no Moby packages; with Moby the build fails and Codespaces starts in recovery
mode). Container startup launches MongoDB with a persistent volume. New
terminals inherit `MONGODB_URI` for the host-run API. Start the API and UX using
the development commands below; the dashboard
uses forwarded port 5173. Port 3000 is also forwarded for the server, which
hosts the built dashboard too once `core/ux/dist` exists.

For development on the host:

```bash
pnpm install
pnpm build
pnpm test
```

## Development

```bash
# Start the server (the API; it also serves core/ux/dist once the dashboard is built)
pnpm --filter @autonomo.us/server dev

# Start the UX dashboard with hot reload (proxies /v1 to the server on :3000)
pnpm --filter @autonomo.us/ux dev

# Lint
pnpm lint

# Lint and fix
pnpm lint:fix
```

## Sign-in and team

A new gateway opens the dashboard on first-run setup. Whether setup has run is
stored in MongoDB (`gateway_setup` in the database named by `MONGODB_URI`), so
every API replica and dashboard tab agrees. Setup creates the first **Owner**
account from a name, email, and password, signs it in, and opens **Team**.

There is no unauthenticated mode. Before and after setup, every `/v1/*` request
needs a signed-in team member or an API token. Only `/health`, CORS preflight,
`GET /v1/auth/status`, sign-in, invite redemption, and setup itself answer
without one. Set `SETUP_TOKEN` on the API to protect the first run: while setup
is pending, the dashboard asks for it before creating the owner account, so
nobody else can claim a deployed gateway. The setup token unlocks setup and
nothing else. It is not a login, and after setup it grants nothing. Without
`SETUP_TOKEN`, whoever reaches a fresh gateway first can complete setup; that's
fine locally but not for a public deployment.

Accounts sign in with email and password. The email is only a sign-in
identifier: the gateway never sends email. Passwords are 12–128 characters and
are stored as salted scrypt hashes (N=2^14, r=8, p=5, which fits Workers memory
limits). An unknown email takes the same time and gets the same error as a wrong
password. Ten failed attempts within 15 minutes throttle that account until the
window passes, including bursts of concurrent guesses. A session lasts 14 days. The browser keeps its session token in
`localStorage` so reloads stay signed in; **Sign out** revokes it on the server.
Only SHA-256 digests of session tokens are stored. Each account keeps up to 10
sessions.

Open **Team** to manage access:

- **Invite member** creates a single-use invite link for a role, valid for 1, 7,
  or 30 days. The link is shown once; send it over a channel you trust. The
  invitee opens it, picks a name, email, and password, and is signed in. The
  secret lives in the URL fragment (`#/invite/…`), which browsers never send to
  servers, and the dashboard posts it in a request body, so it stays out of
  request logs. Only its digest is stored. Pending links can be revoked; the
  table shows each link's status and who redeemed it.
- **Add member** creates an account directly with an initial password to share.
- **Edit** changes a member's name or role. **Reset password** sets a new
  password and signs that member out everywhere. **Remove** deletes the account
  and its sessions immediately.
- **Change password** (your own account) requires your current password and
  signs out your other sessions.

| Role | Access |
| --- | --- |
| Owner | Everything in every workspace, including granting, changing, and removing owners. |
| Admin | Everything in every workspace except owner accounts and owner invites. |
| Member | Only the workspaces they are added to, with a workspace role there; read-only Team. No API or agent tokens, because tokens outlive the member who created them. |

There is always at least one owner, and nobody can remove themselves. Changes
that remove an owner take a short lock on the setup record, so two owners
demoting or removing each other at once cannot leave the team without one. A
forgotten password is reset by an owner or admin. If every owner is locked out,
fix the account in the `gateway_users` collection. Setup writes the owner account into its
marker in the same atomic write that claims setup. If the request dies before
the account is copied into `gateway_users`, the next request finishes the copy,
so a crash can neither lock the gateway nor admit a second owner.
Without MongoDB, accounts and invites last until the API restarts and setup
runs again. If a configured
MongoDB is unreachable, sign-in and sessions fail with HTTP 503, and requests
without credentials still get 401.

## Workspaces

A workspace is an isolation unit inside one gateway: it has its own provider
connections and keys, routing, API and agent tokens, and usage telemetry.
Nothing configured in one workspace is readable, routable, or billable from
another. Everything that existed before workspaces belongs to the **Default**
workspace, and keys set as environment variables belong to Default only. A new
workspace starts empty. See the [workspaces plan](docs/WORKSPACES_PLAN.md) for
the design.

Every workspace-scoped API route names its workspace in the path:
`/v1/<workspace id>/models`, `/v1/<workspace id>/chat`, and so on. The id is a
UUID, including for Default. Find it in **Workspaces**, in the token dialog, or
with `GET /v1/workspaces`. An API token belongs to one workspace and gets 403
under any other workspace's path. An unknown workspace and one you cannot open
both return 404.

Team accounts stay gateway-wide. Owners and admins are admins of every
workspace. Members open only the workspaces they are added to, with a
workspace role:

| Workspace role | Access |
| --- | --- |
| Admin | Models and connections (including keys), routing, the dashboard, renaming the workspace, and adding or removing its members. |
| Member | The dashboard, routing, and read-only connections. |

Only owners and admins create, archive, and unarchive workspaces, and manage
API and agent tokens. Archiving refuses every token and session request to the
workspace on the next request and keeps its data; Default cannot be archived.
Open **Workspaces** in the sidebar to create, rename, archive, and manage
members, and use the switcher at the top of the sidebar to change workspace.
**Team** shows each member's workspaces, and **Add member** and **Invite
member** grant a workspace to new members. Granting, changing, and removing
workspace access are recorded in a membership history.

Workspace configuration is read from MongoDB on every request, so a change
made through one replica or Worker isolate applies on the next request
everywhere. Rolling back to a release from before workspaces is safe only
while Default is the only workspace: older releases merge every workspace's
connections and accept every token gateway-wide.

## Gateway

The dashboard has a collapsible sidebar with a workspace switcher and
**Dashboard**, **Models**, **Routing**, **API Tokens**, **Agent Tokens**,
**Synapse**, **Workspaces**, and **Team** views. Dashboard, Models,
Routing, and the two token views show the selected workspace, and their URLs
name it (`#/w/<workspace id>/models`). Synapse is shared by the whole gateway
for now.
In **Models**, search active models or choose **Add model** to connect Google
Gemini, xAI Grok, Anthropic Claude, OpenAI, Groq, Mistral, DeepSeek, OpenRouter,
Cloudflare Workers AI, or Jev (TypeSafe). Choose a catalog suggestion or enter a
provider-native model ID and supply your API key. Cloudflare also requires your
32-character Account ID and a Workers AI API token. Additional models reuse the
saved key for the selected connection; entering a new key updates only that connection. Active means
configured for routing; adding a model does not verify provider account access
or make a billable inference request.

A provider can have multiple named connections, each with its own API key,
models, and Cloudflare account (where applicable). In **Add model**, choose a
provider, select **New connection…**, and give it a unique name such as
`openai-work` or `openai-personal`. Select an existing connection to add models
using its saved key. Names start with a lowercase letter and contain up to 64
lowercase letters, numbers, dashes, or underscores.
The connection name `pool` is reserved for routing pools. Legacy connections
with that name keep routing directly, but must be renamed before adding pools.

Route requests and failover targets using `connection/model`, for example
`openai-work/gpt-5.2`. The same model may be added to both connections. Existing
`provider/model` IDs keep working as the default connection; no migration is
needed. Credentials and Cloudflare accounts are never inherited by a new
connection. Duplicate names are rejected when creating a connection.

With `MONGODB_URI` configured, model settings and credentials are stored in the
`gateway_providers` collection and restored at startup. Saved provider settings
take precedence over environment settings for the same connection name. Protect this
database as a credential store: keys are stored server-side, are never returned
by management endpoints, and are not saved in browser storage. Without MongoDB,
the UI identifies changes as lasting only until the API restarts. If configured
MongoDB is unavailable, changes fail without activating an unsaved model.

The API service routes chat requests to LLM providers via the [Vercel AI SDK](https://ai-sdk.dev),
records token usage, and ships telemetry to MongoDB. Providers are configured
through environment variables:

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Registers the `anthropic` provider (`ANTHROPIC_MODELS` overrides the advertised list) |
| `GEMINI_API_KEY` | Registers the native Google Gemini adapter as `google`; `GOOGLE_GENERATIVE_AI_API_KEY` is an alias, and `GEMINI_MODELS` overrides the advertised list (default `gemini-2.5-flash`) |
| `OPENAI_API_KEY` | Native OpenAI adapter using the Responses API; `OPENAI_MODELS` overrides the list |
| `GROQ_API_KEY` / `MISTRAL_API_KEY` | Native Groq / Mistral adapters; `GROQ_MODELS` / `MISTRAL_MODELS` override the lists |
| `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` | OpenAI-compatible adapters; `DEEPSEEK_MODELS` / `OPENROUTER_MODELS` override the lists |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Workers AI; `CLOUDFLARE_MODELS` contains native IDs such as `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `TYPESAFE_API_KEY` | Jev decisions adapter; `TYPESAFE_MODELS` defaults to `jev-latest` |
| `XAI_API_KEY` | Registers the native xAI Grok adapter as `xai`; `XAI_MODELS` overrides the advertised list (default `grok-4`) |
| `OPENAI_COMPAT_BASE_URL` | Registers an OpenAI-compatible provider — Ollama, LM Studio, vLLM, llama.cpp (`OPENAI_COMPAT_NAME` defaults to `local`, plus optional `OPENAI_COMPAT_API_KEY` / `OPENAI_COMPAT_MODELS`) |
| `MONGODB_URI` | Persists the setup marker, team accounts, invites, API tokens, agent tokens, provider settings, routing, Synapse notes, and telemetry. Compose uses `mongodb://autonomous:autonomous@mongo:27017/autonomous?authSource=admin` |
| `SYNAPSE_TIME_ZONE` | IANA time zone that decides "today" in the [Synapse](#synapse) (template dates, daily notes, the agent log). Default `UTC`; an unknown name fails startup |
| `CORS_ORIGIN` | Comma-separated browser origins allowed by CORS (default: the Vite dev dashboard on `localhost:5173`; set `*` to allow any) |
| `FAILOVER_ENABLED` | Seeds the failover policy switch (`true`/`1`; default off) — see [Failover](#failover) |
| `FAILOVER_TARGETS` | Comma-separated `provider/model` ids tried, in order, when a request fails |
| `FAILOVER_TIMEOUT_MS` | Per-attempt budget in ms before failing over (default `30000`; `0` disables the timeout) |

### Endpoints

- `GET /health` and `GET /healthz` — API liveness (`status`, `timestamp`) plus `mongodb`, containing `configured`, `connected`, and `initialized`. The last field confirms saved settings loaded and the default routing document exists. A configured database is probed with a bounded timeout; an unavailable database reports `connected: false` while liveness remains HTTP 200. Set `MONGODB_URI` to enable the check.

- `GET /v1/auth/status` — public: `{ setupComplete, setupTokenRequired, persistence }`. The dashboard reads it to choose setup or sign-in.
- `POST /v1/setup` — first-run only: `{ email, name, password }` creates the first owner and returns `{ token, expiresAt, user }`. Requires `Authorization: Bearer <SETUP_TOKEN>` when it is set; returns 409 once setup is complete. `GET /v1/setup/token` checks a setup token (204) before the form is shown.
- `POST /v1/auth/session` — public sign-in with `{ email, password }`; returns `{ token, expiresAt, user }`. Send `Authorization: Bearer <token>` on later requests. `GET` returns the current identity; `DELETE` signs out that session.
- `PUT /v1/auth/password` — signed-in member: `{ currentPassword, newPassword }`.
- `GET /v1/workspaces` — signed-in members: the workspaces you can open, with your role in each, `isDefault`, and whether you can create workspaces.
- `POST /v1/workspaces` — owners/admins: create `{ name, description? }`; the server assigns a UUID. `GET /v1/workspaces/:workspace` returns one workspace with its lifecycle history; `PATCH` updates `{ name, description }` (owners, admins, and workspace admins); `POST /v1/workspaces/:workspace/archive` and `/unarchive` are for owners and admins.
- `GET /v1/:workspace/members` — workspace admins and above: who can open the workspace and the latest 100 membership changes. `PUT /v1/:workspace/members/:userId` sets `{ role }` (`admin` or `member`) for an existing member account; `DELETE` removes their access.
- `POST /v1/invites/preview` and `POST /v1/invites/accept` — public: `{ token }` shows an invite's role and inviter; `{ token, email, name, password }` redeems it once and returns a session.
- `GET /v1/team` — members (each with their workspace memberships), the latest 50 invites, and whether the caller can manage the team. Signed-in members only; API tokens get 403.
- `POST /v1/team` — owners/admins: add `{ email, name, role, password, workspace? }`, where `workspace` is `{ workspaceId, role }` for a member. `PATCH /v1/team/:id` updates `{ name, role }`; `PUT /v1/team/:id/password` sets `{ password }` and signs that member out; `DELETE /v1/team/:id` removes them.
- `POST /v1/team/invites` — owners/admins: `{ role, ttlDays, workspace? }` with TTL `1`, `7`, or `30`; returns `{ invite, token }` once. `DELETE /v1/team/invites/:id` revokes a pending link.

- `GET /v1/:workspace/api-tokens` — token metadata, latest 100 lifecycle actions, persistence and authentication mode; never returns secrets or hashes.
- `POST /v1/:workspace/api-tokens` — create with `{ name, description, ttlDays, permissions? }`, where TTL is `1`, `7`, `30`, `180`, or `"never"`. Returns `{ token, secret }` once.
- `PATCH /v1/:workspace/api-tokens/:id` — update `{ name, description, permissions? }`. Omitted permissions stay unchanged; `[]` removes all grants.
- `POST /v1/:workspace/api-tokens/:id/roll` — issue a new secret with `{ ttlDays, previousTokenTtlSeconds }`. Overlap is 0–2592000 seconds (30 days), capped at the previous value's original expiry.
- `DELETE /v1/:workspace/api-tokens/:id` — revoke the token and all overlapping values; retains its metadata and action history.

- `GET /v1/:workspace/agent-tokens` — agent token metadata, latest 100 lifecycle actions, persistence and authentication mode.
- `POST /v1/:workspace/agent-tokens` — create an agent credential with `{ name, description, ttlDays, permissions? }`. Returns `{ token, secret }` once; omitted permissions grant no access.
- `PATCH /v1/:workspace/agent-tokens/:id` — update `{ name, description, permissions? }`; omitted permissions stay unchanged and `[]` removes all grants.
- `POST /v1/:workspace/agent-tokens/:id/roll` — rotate with `{ ttlDays, previousTokenTtlSeconds }`, using the same TTL and overlap choices as API tokens.
- `DELETE /v1/:workspace/agent-tokens/:id` — revoke all current and overlapping values, retaining metadata and history.

- `POST /v1/:workspace/chat` — proxy a chat request; body `{ model, messages, stream?, temperature?, maxTokens? }` where `model` is `connection/model`, `auto`, or `pool/<id>`. Returns the assistant message plus `usage` token counts; with `stream: true` responds with SSE (`text-delta` events, then `finish` with usage).
- `GET /v1/:workspace/models` — routable models and providers.
- `POST /v1/:workspace/models` — add an active model; body `{ provider, connectionId?, createConnection?, model, apiKey?, accountId? }` (provider IDs: `google`, `xai`, `anthropic`, `openai`, `groq`, `mistral`, `deepseek`, `openrouter`, `cloudflare`, `typesafe`). Omit `connectionId` to use the default provider connection. Set `createConnection: true` to reject an existing name with HTTP 409. The key is required for a new connection and optional for subsequent additions to that connection. Repeated additions are idempotent; replies contain only the model ID and provider.
- `GET /v1/:workspace/providers` — supported provider names, a `connections` list with IDs, provider kinds, key-configured flags and Cloudflare account IDs, and the settings persistence mode; never includes credentials.
- `GET /v1/models/catalog` — the full multi-provider model catalog (refreshed daily at runtime; bundled `models.json` as the fallback).
- `GET /v1/:workspace/failover` — current failover policy.
- `PUT /v1/:workspace/failover` — update the failover policy; body `{ enabled?, targets?, timeoutMs? }` (partial updates keep omitted fields).
- `GET /v1/:workspace/routing` — routing `{ config, persistence }`, including Auto selection, pools, the default failover policy, and model/pool rules.
- `PUT /v1/:workspace/routing` — replace the full routing configuration; returns `{ config, persistence }`. Invalid settings are rejected before activation.
- `GET /v1/:workspace/telemetry/summary` — usage aggregates (MongoDB when available, in-memory otherwise; `?source=memory|mongodb` to force).
- `GET /v1/:workspace/telemetry/events` — recent gateway events and sink status.
- `GET /v1/:workspace/telemetry/analytics?from=<ISO timestamp>&to=<ISO timestamp>` — date-filtered model, connection, caller, and time-series analytics. Optional `model`, `provider` (connection ID), and `caller` filters apply to the entire report. Ranges are start-inclusive, end-exclusive, and limited to 90 days. Requires `telemetry:read` when API authentication is enabled.

- `/v1/synapse/...` — Synapse's notes, spaces, export/import, and proposals; see [Synapse](#synapse).
- `POST /mcp` — the MCP endpoint for agent tokens; see [Synapse](#synapse).

```bash
# Host-run API against the compose services
docker compose up -d mongo
OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1 \
MONGODB_URI='mongodb://autonomous:autonomous@localhost:27017/autonomous?authSource=admin' \
pnpm --filter @autonomo.us/server dev

# WORKSPACE_ID: the workspace's UUID, from Workspaces or GET /v1/workspaces.
curl -X POST http://localhost:3000/v1/$WORKSPACE_ID/chat \
  -H "content-type: application/json" \
  -d '{"model": "local/llama3.3", "messages": [{"role": "user", "content": "Hello"}]}'
```

### API tokens

Open **API Tokens** to create, edit, roll, or revoke gateway credentials. Each
token has a name, description, and a TTL of 1, 7, 30, or 180 days, or Never.
Creation and rolling show the secret once; copy it before leaving the page.
The server stores only its SHA-256 digest. MongoDB persists tokens and their
actions in `gateway_api_tokens`; without MongoDB they last until API restart.

Managing tokens requires a signed-in owner or admin; the action log records
which member acted. Generated tokens receive the permissions chosen in Create/Edit
token. `/health` stays public. Entries from before team accounts may still show
the retired owner credential or local admin as their actor.

A token belongs to the workspace it was created in, and its permissions apply
within that workspace:

| Resource | Choices | Access |
| --- | --- | --- |
| Models | None, Read, Edit | Read lists models, the catalog, and provider connection metadata. Edit also adds models and changes connection credentials; secrets are never returned. |
| Routing | None, Read, Edit | Read inspects routing and failover. Edit also saves those settings. |
| Inference | None, Run | Run sends chat and decisions requests, including Auto, pools, and failover. |
| Telemetry | None, Read | Read views usage and events. |
| Synapse | None, Read, Edit | Read lists spaces, templates, notes, categories, unresolved links, daily views, and proposals. Edit also creates, changes, appends to, deletes, imports, and exports notes. Neither decides proposals. Synapse is shared by the whole gateway for now, so these grants reach it whatever the token's workspace. |

Edit includes Read for that resource, but never Run. API token management and
action history remain owner-only. Requests without the required permission
return 403 before any provider call. There is no per-model or per-pool scope yet.

The API accepts permission IDs `models:read`, `models:edit`, `routing:read`,
`routing:edit`, `inference:run`, `telemetry:read`, `synapse:read`, and
`synapse:edit`. For example, an observer
can use `["models:read", "routing:read", "telemetry:read"]`. The dashboard starts
new tokens with every permission unchecked; select the access each token needs.
API clients that omit permissions default to Models Read + Inference Run. Older stored tokens
get those same grants and acquire an explicit permissions field when edited or
rolled. An explicit empty array grants no access. Rolling preserves permissions;
editing them applies immediately to every current and overlapping token value
on new requests and records the change in the action log.

When rolling, choose the new TTL and how long the previous value stays alive:
immediately expire it, 1 hour, 24 hours, 7 days, or a custom duration up to 30 days.
The old value never outlives its original expiry. Previously rolled values keep
their own deadlines; revoked and expired values cannot be revived. Revoking a
token blocks all its values on new requests; requests already admitted can finish.
Up to 20 values may overlap. The table shows each previous value's deadline.

The action log at the bottom shows the latest 100 creates, edits, rolls, and
revocations across tokens, with time, actor, and details. Each token retains its
latest 100 actions atomically with its metadata. Future resource scopes,
delegated token management, and a permanent audit log are covered in the
[API token permissions plan](docs/API_TOKEN_PERMISSIONS_PLAN.md).

### Agent tokens

Open **Agent Tokens** to issue credentials for agents that connect over MCP.
The MCP server at `POST /mcp` serves the [Synapse](#synapse) tools; an agent sends
its token as `Authorization: Bearer agt_…`. Each token supports the same name,
description, TTL, one-time secret display, rolling with overlap, revocation, and
action log as API Tokens.

Agent secrets use the `agt_` prefix and store only SHA-256 digests in the separate
`gateway_agent_tokens` MongoDB collection. Without MongoDB they last until API
restart. API and agent token lists, histories, permission sets, and authentication
are isolated: an agent credential cannot authenticate a `/v1/*` request, and an
API credential cannot authenticate through `AgentTokenStore`. Management requires
a signed-in owner or admin.

New agent tokens start with no permissions, both in the dashboard and through the
API. The MCP grants are `mcp:read` (`tools/list`) and `mcp:call` (`tools/call`).
They are independent; an agent that uses Synapse needs both. These grants do
not authorize any REST endpoint: an agent token on `/v1/*` gets 401. Permission
edits apply to all overlapping values, and rolling preserves grants. An agent's
token ID names its private Synapse space (`agent-<id>`), so rolling a credential
keeps the agent's memory and revoking it cuts the agent off without deleting it.

### Synapse

Synapse is the gateway's long-term memory for agents and the team: a
knowledge graph of linked Markdown notes with properties, modelled on Steph
Ango's (kepano) [Obsidian vault](https://github.com/kepano/kepano-obsidian).
Notes have no folders; they are classified by a `categories` property, linked
with `[[wikilinks]]`, and found through backlinks, related notes, unresolved
links, and daily notes. Every space exports to Obsidian-compatible files, and
an Obsidian vault imports back. The full behavior is in
[docs/SYNAPSE.md](docs/SYNAPSE.md).

There are two kinds of space. `shared` is the team canon: every agent can read
it, and agents change it only through **proposals** that an owner or admin
approves or rejects (a rejection's reason is appended to the agent's daily
note). `agent-<agentTokenId>` is one agent's private space, created on its first
write and named after the token; agents cannot read each other's spaces.
Signed-in team members read and write every space from the **Synapse** view in
the dashboard and over `/v1/synapse`; API tokens use `synapse:read` for GET routes
and `synapse:edit` for writes, import, and export, and never decide proposals.

Agents use Synapse over MCP. `POST /mcp` speaks Streamable HTTP in stateless
mode (one JSON-RPC message per request, JSON responses, no sessions) and
accepts agent tokens only. `initialize` returns short instructions (search
before you write, one note per thing, link first mentions, dates as
`YYYY-MM-DD`, log what you did); the tools are `synapse_search`, `synapse_read`,
`synapse_create`, `synapse_update`, `synapse_append`, `synapse_delete`, `synapse_log`,
`synapse_daily`, `synapse_unresolved`, `synapse_templates`, `synapse_propose`, and
`synapse_proposals`:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "authorization: Bearer agt_…" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}'

curl -X POST http://localhost:3000/mcp \
  -H "authorization: Bearer agt_…" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"synapse_log","arguments":{"text":"Drafted the launch post with [[Ada Lovelace]]"}}}'
```

Requests with an `Origin` outside `CORS_ORIGIN` get 403, `GET`/`DELETE /mcp`
get 405, `notifications/*` messages get 202, and any other message without an
`id` gets 400. Tool failures (not found, validation, limits, conflicts) come
back as tool results with `isError: true`.

REST routes under `/v1/synapse`: `GET /spaces` and `GET /templates`;
`GET|POST /spaces/:space/notes` (query with `text`, `category`, `tag`,
`linksTo`, `sort`, `direction`, `limit`, `offset`, `where.<property>=`);
`GET|PATCH|DELETE /spaces/:space/notes/:title` and
`POST .../notes/:title/append`; `GET /spaces/:space/unresolved`,
`.../categories`, `.../daily/:date`; `GET /spaces/:space/export` (JSON, or a
`.zip` with `?format=zip`) and `POST /spaces/:space/import` (up to 500 files,
5 MB); `GET /proposals` and `POST /proposals/:id/decide` (signed-in owners and
admins only). Titles are URL-encoded; errors use `{ error: { message } }`.

With `MONGODB_URI`, notes live in `synapse_notes`, space records in
`synapse_spaces`, and proposals in `synapse_proposals`; without it Synapse lasts
until restart. `SYNAPSE_TIME_ZONE` sets the time zone for `{{date}}`, daily
notes, and the log.

### Jev decisions

Jev is a decision model, marked **Decisions** in Models and excluded from chat
failover. Add `typesafe/jev-latest` using a key from the
[TypeSafe console](https://console.typesafe.ai). The adapter calls the official
[System One API](https://docs.typesafe.ai/api/system-one).

`POST /v1/:workspace/decisions` accepts native text or JSON state and named `noul`,
`choice`, or `score` questions. It returns the provider's model name, typed
answers (including confidence/probabilities), and usage. Requests time out after
30 seconds. Experimental image/Box inputs and long-context opt-ins are not yet
supported. Decisions contribute to gateway usage and telemetry.

```sh
curl http://localhost:3000/v1/$WORKSPACE_ID/decisions -H 'Content-Type: application/json' -d '{
  "model": "typesafe/jev-latest",
  "state": "I was charged twice this month.",
  "questions": {
    "billing": { "type": "noul", "instructions": "Is this about billing?" }
  }
}'
```

Each new hosted provider also accepts a server-side `<PREFIX>_BASE_URL` override
for testing or trusted proxies. Cloudflare account IDs and provider credentials
are reused for additional model additions and survive restarts with MongoDB.
Catalog refresh uses environment credentials; keys added through Models remain
in the settings store. Model suggestions fall back to the public or bundled
catalog and are not an account entitlement check.

### Model catalog

The gateway tracks the known models across the major providers (Anthropic,
OpenAI, Google, Mistral, Groq, xAI, DeepSeek, OpenRouter, Cloudflare, TypeSafe) and serves the catalog at
`GET /v1/models/catalog`. On startup the API queries the model sources itself
and re-checks daily, keeping the result in [cacheable](https://cacheable.org)
(in-memory with a one-day TTL by default — hand `ModelCatalogService` a
`Cacheable` with a secondary store to persist it). Providers whose API key is
set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`) are
asked directly via their models endpoint; everything else comes from the
public [models.dev](https://models.dev) catalog, so no keys are required. A
refresh that cannot reach the sources just keeps the catalog it already has —
requests are always served from cache, never blocked on a fetch.

The bundled `core/server/src/models.json` is the baseline the gateway serves
until the first successful refresh. The
[update-models](.github/workflows/update-models.yml) workflow runs the same
collection daily (using repo secrets for whichever provider keys are
configured) and uploads the refreshed catalog as a workflow artifact — it
does not commit back to the repo. Refresh the committed baseline locally
with:

```bash
pnpm --filter @autonomo.us/server models:update
```

To collect another provider, add a spec to `PROVIDERS` in
`core/server/src/model-catalog.ts` (and its key to the workflow env).

### Routing

Open **Routing** to configure these features and send a test request using
**Auto**, a pool, or a specific model. The tester uses saved settings and makes
real provider calls. Add models and account connections in **Models** first.

- **Auto mode:** choose Jev or any configured chat model (including OpenAI) as
  the decision model. Add at least two allowed models or pools, describe the
  tasks each should handle, and choose a fallback target. Send `model: "auto"`
  to let the selector inspect the conversation and pick a target. Jev uses a
  native Choice question; chat selectors return an allowed target ID. Invalid
  answers, errors, and decision timeouts use the configured fallback. Selection
  adds one provider call; its token usage appears separately in telemetry.
- **Load balancing:** create a named pool with concrete `connection/model`
  members. Different models share work; the same model on different named
  connections shares work across accounts with independent credentials. Weighted
  round robin distributes requests in proportion to weights (3:1 gives roughly
  75%:25%). Least requests chooses the lowest active-request count divided by
  weight, counting streams until they finish. Send `model: "pool/coding"` to
  use a pool named `coding`. Balancing state is local to each API process and
  resets on restart; it is not coordinated across replicas.
- **Failover rules:** a rule for a pool takes priority over a rule for its
  selected model, which takes priority over the default policy. Each rule has
  an enabled switch, ordered fallback models, and an attempt timeout. A disabled
  rule suppresses the default policy for that route. Pool member failover is a
  separate switch: when enabled, remaining members are tried first, followed
  by the applicable rule's targets. Duplicate models are attempted only once.
  Rules do not recursively follow other rules, and pools cannot contain pools.

For example, after configuring these model IDs on your connections:

```json
{
  "auto": {
    "enabled": true,
    "decisionModel": "typesafe/jev-latest",
    "targets": [
      { "target": "pool/coding", "description": "Complex coding and technical reasoning" },
      { "target": "anthropic/claude-opus-5-5", "description": "Creative writing and general questions" }
    ],
    "fallbackTarget": "pool/coding",
    "timeoutMs": 10000
  },
  "pools": [{
    "id": "coding",
    "strategy": "weighted-round-robin",
    "members": [
      { "model": "openai-work/gpt-6-astra", "weight": 3 },
      { "model": "openai-personal/gpt-6-astra", "weight": 1 }
    ],
    "failover": true
  }],
  "failover": { "enabled": false, "targets": [], "timeoutMs": 30000 },
  "rules": [{
    "model": "pool/coding",
    "enabled": true,
    "targets": ["anthropic/claude-opus-5-5"],
    "timeoutMs": 15000
  }]
}
```

PUT this object to `/v1/<workspace id>/routing`. Auto can choose the coding pool, distribute
its requests across the two OpenAI connections, and fall back to Opus if both
pool members fail. Use provider-native IDs available to your accounts; these
example IDs are not an entitlement check.

Auto and pool responses include `routing` metadata with the requested route,
selected model, and target. `decisionFallback: true` indicates a failed selector.
The response's top-level `model` always identifies the model that answered,
including after failover. Streams begin with a `routing` event and include the
same metadata in `finish`. Once text has reached the client, no policy switches
the stream to another model. Selector calls and model attempts are recorded
individually in telemetry, so request totals include that extra work.

Routing settings are stored in MongoDB's `gateway_routing` collection when
`MONGODB_URI` is configured, otherwise in memory until restart. The legacy
`/v1/:workspace/failover` endpoint and dashboard card update the same default policy and
persist it too. Saved policies override environment defaults on startup.
On first startup, the gateway saves the default configuration if it is missing.
This creates the database named in `MONGODB_URI` and the routing collection;
other collections are created as their data is saved. The MongoDB user needs
write access to that database. Restarts and concurrent startups preserve the
configuration already stored there.
Writes must succeed before a policy becomes active. If routing settings cannot
be initialized or loaded at startup, chat requests return 503 until MongoDB is
available; the gateway does not silently bypass saved routing policies.

### Failover

The gateway can retry a failed chat request against other models. The policy —
on/off, an ordered list of fallback models, and a per-attempt timeout — lives
in the API and is configurable at runtime from the dashboard's **Failover
policy** card or directly over HTTP:

```bash
curl -X PUT http://localhost:3000/v1/$WORKSPACE_ID/failover \
  -H "content-type: application/json" \
  -d '{"enabled": true, "targets": ["anthropic/claude-sonnet-5", "local/llama3.3"], "timeoutMs": 15000}'
```

When enabled, a request whose model errors or exceeds `timeoutMs` is retried
on each target in order (the requested model is never retried against itself,
and stale targets whose provider disappeared are skipped). Successful failover
responses carry a `failover` object naming the requested model and the failed
attempts, and each attempt is recorded in telemetry under the model that
actually handled it. Streaming requests fail over only until the first token
is sent — once output reaches the client the response is committed to that
model; SSE clients see a `failover` event when the gateway switches models.
`FAILOVER_*` environment variables seed the policy at boot.

The dashboard reports model calls, token usage, estimated spending, active
callers, success rates, and successful-call latency. Choose a 24-hour, 7-day,
30-day, or 90-day window, filter by connection/model/caller, inspect hourly or
daily trends, sort and page the model/caller tables, or export the filtered
report as CSV. It refreshes every 30 seconds while visible and preserves the
last successful report with a stale-data notice if refresh fails. Configuration,
including failover, remains on the Models and Routing pages.

Calls include chat completions, decisions, routing selectors, and failed
fallback attempts; they are not a count of end-user requests. Caller attribution
uses authenticated API token IDs (stable across token rotation), the owner
credential, or a client-reported `agentId` for unauthenticated traffic. Calls
without identity are shown as unattributed, not counted as unique users. No
credentials or prompts are stored in these analytics.

Estimated USD spending uses the catalog's models.dev base input/output rates,
snapshotted with each call so later price changes do not reprice history.
Provider connections are matched by their implementation kind and exact model
ID; custom OpenAI-compatible endpoints remain unpriced. Older events without
prices also remain unknown. The dashboard shows price coverage, including
partial totals, and distinguishes unknown costs from zero-priced models.
Failed attempts remain unpriced because their usage may be missing or partial.
Estimates exclude cache discounts, pricing tiers, and other provider fees.

With MongoDB, analytics aggregate durable records (including prior gateway
processes) with deduplication. Otherwise the report uses up to 50,000 retained
events from this process, independently of the short recent-event feed. The
response and dashboard disclose memory coverage and durable-storage failures;
missing history is never silently presented as complete. Durable queries that
exceed 100,000 time/model/caller/operation groups also fall back with this notice.

## Deployment

Merges to `main` deploy the development environment to one Cloudflare Worker,
`autonomous-server-development`, which serves the dashboard and the API at
<https://dev.autonomo.us>. The
[deploy-development](.github/workflows/deploy-development.yml) workflow runs
`pnpm deploy:development`, which builds `@autonomo.us/ux` and uploads its
`dist` directory as the Worker's static assets together with the API code
(`assets` in `core/server/wrangler.jsonc`). The `autonomo.us` zone must already
be on the Cloudflare account. Compose and the Worker now have the same shape:
one origin, one deployable.

| Path | Served by |
| --- | --- |
| `/v1/*`, `/mcp`, `/health`, `/healthz` | The API (Fastify) inside the Worker (`run_worker_first`). |
| Everything else | The dashboard build. Unknown paths get `index.html` for client-side routes. These requests never invoke the Worker. |

The dashboard calls the API on its own origin, so the build needs no
`VITE_API_URL`. API clients use `https://dev.autonomo.us/v1/...`.

Cutting over from the retired Workers (`autonomous-ux-development` and
`autonomous-api-development`) is a one-time step. Secrets belong to a Worker,
so set them on the new name **before** merging the change that first deploys
it; Wrangler creates the Worker as a placeholder when it does not exist yet.
Never deploy a new Worker to a public hostname without them: with no
`SETUP_TOKEN`, first-run setup is open to whoever reaches `POST /v1/setup`
first, and with no `MONGODB_URI` that owner lives in memory until the next
deploy.

1. Before merging, create the new Worker with its secrets:

   ```bash
   pnpm exec wrangler secret put MONGODB_URI -c core/server/wrangler.jsonc
   pnpm exec wrangler secret put SETUP_TOKEN -c core/server/wrangler.jsonc
   ```

2. Merge. The deploy attaches `dev.autonomo.us` to the new Worker (Wrangler
   moves a custom domain from the Worker that held it) and the workflow's
   health check verifies `/healthz` and MongoDB. The retired Workers keep
   running throughout, so a failed deploy leaves `dev-api.autonomo.us`
   serving the previous release.

3. Only after that check passes, delete the retired Workers so
   `dev-api.autonomo.us` stops serving the old code:

   ```bash
   pnpm exec wrangler delete --name autonomous-ux-development
   pnpm exec wrangler delete --name autonomous-api-development
   ```

Provision a MongoDB server or managed cluster outside this workflow and store
its connection string as the `MONGODB_URI` Worker secret, as above. The
deployment check fails until it is set.

`SETUP_TOKEN` matters only while first-run setup is pending: with a fresh
database, set it so only you can create the owner account, then open
<https://dev.autonomo.us> and enter it. Setup state lives in MongoDB, so a
Worker pointed at an already set-up database needs no token, and the token
grants nothing after setup.

Include the application database name in the connection string. The MongoDB
user needs read/write access to that database, and the cluster must accept
connections from the Worker. A GitHub or local environment secret alone does
not configure this Worker binding. On the first request, the API creates the
database's `gateway_routing` collection and its default configuration.

The deployment workflow runs `pnpm check:deployment` after uploading. It fails
unless `/healthz` responds successfully and MongoDB is configured, connected,
and initialized. For an initial deployment, set the Worker secret and rerun
the workflow. Database write failures remain visible even when a ping succeeds.

Worker logs are enabled in `core/server/wrangler.jsonc`. View them in Cloudflare's
Worker observability page or with:

```bash
pnpm exec wrangler tail -c core/server/wrangler.jsonc
```

`gateway.request` records method, path, status, and duration. Persistence emits
`gateway.persistence_ready`, `gateway.mongodb_unconfigured`, or
`gateway.persistence_failed` with a store name and diagnostic error type/code.
Logs omit request bodies, authorization headers, connection strings, and driver
messages. For example, MongoDB code 13 indicates insufficient permissions and
code 18 indicates authentication failure.

| Secret | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | yes | Token scoped to the account and the `autonomo.us` zone. Permissions: Account → Workers Scripts → Edit, Zone → Workers Routes → Edit, Zone → DNS → Edit. |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Account that owns the `autonomo.us` zone. |

## Testing

API integration tests run against real services: chat routes talk to a real
OpenAI-compatible HTTP server over the production provider wire path, and the
telemetry suites run against a real MongoDB (CI provides one as a service
container). Locally:

```bash
docker compose up -d mongo
pnpm test
pnpm test:worker
```

`test:worker` starts the production entry in the actual Workers runtime and
requires MongoDB. It checks cold startup, both health endpoints, schema
validation, logging, automatic configuration creation, concurrent requests,
database writes, and failure recovery. It uses temporary databases and removes
them afterward. Set `MONGODB_TEST_URL` to use a different test MongoDB server.

Without a reachable MongoDB the integration suites skip with a warning;
everything else still runs. The default test URL is
`mongodb://autonomous:autonomous@localhost:27017/autonomous?authSource=admin`.

## License

MIT

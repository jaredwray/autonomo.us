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

## Runtime support — breaking change

Only the current Node.js LTS major is supported: **Node 26**, starting at
**26.13.1**. Node 22/24 and non-LTS majors are no longer supported by this
revision. All workspace/published packages declare `>=26.13.1 <27`; pnpm
installs fail on unsupported hosts. CI, release/deployment tooling and the
container image use the version pinned in `.nvmrc` (the image also pins its digest).
Future LTS transitions require an explicit reviewed update, not a floating `lts` tag.

Existing host installations must upgrade Node before installing this revision,
then reinstall dependencies and rebuild native modules/output. Rebuild Docker
and development containers; an existing running image does not update itself.
Keep MongoDB volumes, database names and runtime secrets unchanged: this runtime
upgrade does not require a data migration. Retain the previous application/image
for rollback; do not run this new revision on Node 22/24.

Node 26 no longer bundles Corepack. Install the pinned Corepack 0.36.0 through
your approved package-install protection, then run `corepack enable` to use the
repository's pinned pnpm. Codespaces/Cloud Agents use the Safe Chain bootstrap;
CI installs Corepack through Socket Firewall. Host setup with nvm starts with
`nvm install && nvm use` in this directory. See [deployment migration and rollback](docs/CLOUDFLARE-CONTAINERS.md).

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
is open, the dashboard shows only the setup screen and asks for the token
before creating the owner account, so nobody else can claim a deployed gateway.
The setup token unlocks setup and nothing else. It is not a login. Without
`SETUP_TOKEN`, whoever reaches a fresh gateway first can complete setup; that's
fine locally but not for a public deployment.

A setup token is spent once it completes setup: the same value never opens
setup again, even after a restart, and the dashboard goes back to sign-in.
Setting a **new** value reopens setup on a gateway that is already set up, which
is how you recover one when every owner is locked out. API tokens and existing
sessions keep working meanwhile, but the dashboard shows only the setup screen
until the new token is used. After you enter the token, setup shows what the
gateway already holds and offers two choices:

- **Keep it and add an owner.** Everything stays. If you use an email that
  already has an account, that account gets the new password and the owner
  role, and its other sessions are signed out. Otherwise a new owner account
  is added beside the existing ones.
- **Delete it and start fresh** (MongoDB only). Deletes every team account,
  invite, provider connection and key, routing rule, API and agent token,
  agent webhook, workspace, Synapse note, and usage record, then creates the
  owner as on first run. It deletes documents only from the gateway's own
  collections, so other data in the same database is untouched. This can't be
  undone.

On Workers, the new secret takes effect with the deployment that saving it
creates. With several Node replicas, restart them all after starting fresh so
none keeps the old default workspace cached.

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
| Member | Only the workspaces they are added to, with a workspace role there; read-only Team. A workspace admin manages that workspace's [agents](#agents). No API tokens, because they outlive the member who created them. |

There is always at least one owner, and nobody can remove themselves. Changes
that remove an owner take a short lock on the setup record, so two owners
demoting or removing each other at once cannot leave the team without one. A
forgotten password is reset by an owner or admin. If every owner is locked out,
set a new `SETUP_TOKEN` and run setup again (above). Setup writes the owner account into its
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

## Loops

Use **Loops** in a workspace to track a metric, review pending decisions, and design or inspect the workflow for each loop. Agents and source systems can report observations, and assigned agents can claim work and return verification evidence. [Workspace loops and agent integration](docs/LOOPS.md)

## Gateway

The dashboard has a collapsible sidebar with a workspace switcher and
**Dashboard**, **Models**, **Proxies**, **Synapse**, **Channels**,
**Organization**, **Loops**, **Agents**, **API Tokens**, **Workspaces**, and **Team** views. All but Workspaces and
Team show the selected workspace, and their URLs name it
(`#/w/<workspace id>/models`).
**Models** has four tabs, each with its main action, such as **Add model**, at
the right of the counts at its top: **LLM** (`#/w/<workspace id>/models`),
the language models and a chart of their usage; **Video** (`/models/video`),
the video providers and their order (see [Video generation](#video-generation));
**Policies** (`/models/policies`), the budgets on what models may spend and
the video limits on how many videos and how long (see [Budgets](#budgets));
and **Routing** (`/models/routing`). Older `#/routing`, `#/video`, and
`/models/budget` links open those tabs. A tab keeps what was typed in it while
another is shown.
The **LLM** tab opens with **Usage by model**: the models called most in the
last 30 days, by tokens (prompt and completion), calls, or estimated spend,
from the same analytics as the Dashboard's Usage tab.
In the **LLM** tab, search active models or choose **Add model** to connect Google
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
| `ZENROWS_API_KEY` | A ZenRows proxy named `zenrows` for [web access](#web-access-and-proxies), in the default workspace's ladder at `auto` |
| `CLOUDFLARE_BROWSER_API_TOKEN` | A Cloudflare Browser Run proxy named `cloudflare-browser` on `CLOUDFLARE_ACCOUNT_ID`; the token needs the Browser Rendering Edit permission, which a Workers AI token should not carry |
| `BRIGHTDATA_API_KEY` + `BRIGHTDATA_ZONE` | A Bright Data Web Unlocker proxy named `brightdata`; `BRIGHTDATA_PRICE_PER_1000` sets your plan's price (default 1.5) |
| `WEB_FETCH_DISABLED` | `true` turns web access off in every workspace and removes the `web_fetch` tool |
| `GOOGLE_VIDEO_API_KEY` | A Google Gemini Omni connection named `google-video` for [video generation](#video-generation). A separate variable from `GEMINI_API_KEY` on purpose: a chat key does not start paid video |
| `RUNWAY_API_KEY` | A Runway connection named `runway` for video generation; `RUNWAYML_API_SECRET` (Runway's own name) is an alias |
| `LUMA_API_KEY` | A Luma Ray connection named `luma` for video generation; `LUMA_AGENTS_API_KEY` is an alias, and `LUMA_CREDIT_PRICE_USD` sets what a credit costs on your plan (default 0.01; 0 to 10) |
| `VIDEO_DISABLED` | `true` turns video generation off in every workspace and removes the `video_*` tools |
| `XAI_API_KEY` | Registers the native xAI Grok adapter as `xai`; `XAI_MODELS` overrides the advertised list (default `grok-4`) |
| `OPENAI_COMPAT_BASE_URL` | Registers an OpenAI-compatible provider — Ollama, LM Studio, vLLM, llama.cpp (`OPENAI_COMPAT_NAME` defaults to `local`, plus optional `OPENAI_COMPAT_API_KEY` / `OPENAI_COMPAT_MODELS`) |
| `MONGODB_URI` | Persists the setup marker, team accounts, invites, API tokens, agent tokens, provider settings, routing, Synapse notes, and telemetry. Compose uses `mongodb://autonomous:autonomous@mongo:27017/autonomous?authSource=admin` |
| `SYNAPSE_TIME_ZONE` | IANA time zone that decides "today" in the [Synapse](#synapse) (template dates, daily notes, the agent log). Default `UTC`; an unknown name fails startup |
| `CORS_ORIGIN` | Comma-separated browser origins allowed by CORS (default: the Vite dev dashboard on `localhost:5173`; set `*` to allow any) |
| `PUBLIC_URL` | The address apps reach the gateway at, such as `https://gateway.example.com`, named in [OAuth sign-in](#agents-that-sign-in-with-oauth) metadata. Unset, each request's own address is used: its `Host`, with `x-forwarded-proto` when a proxy sets it |
| `DASHBOARD_URL` | Where people approve an OAuth sign-in, when the dashboard is not served from the gateway's own address (for example `http://localhost:5173` in development) |
| `FAILOVER_ENABLED` | Seeds the failover policy switch (`true`/`1`; default off) — see [Failover](#failover) |
| `FAILOVER_TARGETS` | Comma-separated `provider/model` ids tried, in order, when a request fails |
| `FAILOVER_TIMEOUT_MS` | Per-attempt budget in ms before failing over (default `30000`; `0` disables the timeout) |

### Endpoints

- `GET /health` — API liveness (`status`, `timestamp`) plus `mongodb`, containing `configured`, `connected`, and `initialized`. The last field confirms saved settings loaded and the default routing document exists. A configured database is probed with a bounded timeout; an unavailable database reports `connected: false` while liveness remains HTTP 200. Set `MONGODB_URI` to enable the check. Use this endpoint for container/load-balancer liveness.
- `GET /healthz` — the same fields plus a deeper `synapse: { configured, ready }` check of existing indexes and bounded reads on notes, spaces and proposals. This endpoint can take longer than liveness; deployment validation requires both MongoDB and Synapse readiness. Native Node caches Synapse results for five seconds. Failures emit credential-free `synapse.storage_failed` stage/error-code diagnostics in container logs. See [Synapse diagnostics](docs/CLOUDFLARE-CONTAINERS.md#diagnosing-synapse-storage-failures).

- `GET /v1/auth/status` — public: `{ setupComplete, setupTokenRequired, persistence }`. The dashboard reads it to choose setup or sign-in. `setupComplete` is false while setup is open: on first run, and while an unspent `SETUP_TOKEN` is configured.
- `POST /v1/setup` — while setup is open: `{ email, name, password, data? }` creates an owner and returns `{ token, expiresAt, user }`. Requires `Authorization: Bearer <SETUP_TOKEN>` when it is set; returns 409 once setup is complete and the token is spent. `data` is `keep` (default) or `clear`; with the setup token, `keep` recovers an existing account with that email, and `clear` deletes the gateway's data first (403 without `SETUP_TOKEN`, 409 without MongoDB). `GET /v1/setup/token` checks a setup token before the form is shown and returns `{ existing, canClear }`: counts of `accounts`, `invites`, `connections`, `tokens`, `workspaces` (besides Default), `notes`, `messages` (channel log entries), and `usageEvents`.
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

- `GET /v1/:workspace/agents` — every agent in the workspace, whichever way it was made: `{ id, kind, name, description, status, permissions, model, connections, createdAt }` with `kind` `instructions`, `oauth`, or `token`. Any member; see [Agents](#agents).
- `GET /v1/:workspace/agent-tokens` — workspace admins: the agents that use MCP (`auth` is `token` or `oauth`), their latest 100 lifecycle actions, persistence and authentication mode.
- `POST /v1/:workspace/agent-tokens` — create an agent with a token: `{ name, description, ttlDays, permissions? }`. Returns `{ token, secret }` once; omitted permissions grant no access.
- `POST /v1/:workspace/agents/oauth` — create an agent that apps sign in to with OAuth: `{ name, description, permissions? }`. It has no token.
- `PATCH /v1/:workspace/agent-tokens/:id` — update `{ name, description, permissions? }`; omitted permissions stay unchanged and `[]` removes all grants.
- `POST /v1/:workspace/agent-tokens/:id/roll` — rotate with `{ ttlDays, previousTokenTtlSeconds }`, using the same TTL and overlap choices as API tokens. An OAuth agent has nothing to roll (409).
- `DELETE /v1/:workspace/agent-tokens/:id` — revoke all current and overlapping values and sign out every app, retaining metadata and history.
- `GET /v1/:workspace/agents/:id/connections` — the apps signed in to an OAuth agent; `DELETE /v1/:workspace/agents/:id/connections/:connection` signs one out.
- `GET /v1/oauth/sign-ins/:id`, `POST /v1/oauth/sign-ins/:id/deny`, `POST /v1/:workspace/oauth/sign-ins/:id/approve` — the dashboard's side of an OAuth sign-in; see [Agents that sign in with OAuth](#agents-that-sign-in-with-oauth).

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
- `GET /v1/:workspace/telemetry/analytics?from=<ISO timestamp>&to=<ISO timestamp>` — date-filtered model, connection, caller, and time-series analytics, plus a `web` section for web fetches. Optional `model`, `provider` (connection ID), and `caller` filters apply to the model report; only `caller` applies to `web`. Ranges are start-inclusive, end-exclusive, and limited to 90 days. Requires `telemetry:read` when API authentication is enabled.
- `GET /v1/:workspace/overview?from=<ISO timestamp>&to=<ISO timestamp>` — the dashboard's home page in one request; see [Dashboard](#dashboard). Signed-in team members only.

- `/v1/:workspace/synapse/...` — Synapse's notes, spaces, export/import, proposals, history, capture, retrieval, commitments, briefings, and maintenance; see [Synapse](#synapse).
- `/v1/:workspace/channels/...` — channels, their messages, agents, and read marks; see [Channels](#channels).
- `/v1/:workspace/bots/...` — agents the gateway runs and their runs; see [Agents with instructions](#agents-with-instructions).
- `/v1/:workspace/proxies/...` and `/v1/:workspace/web/...` — web proxies, the web policy, and fetching a page; see [Web access and proxies](#web-access-and-proxies).
- `POST /mcp` — the MCP endpoint for agents; see [Synapse](#synapse), [Channels](#channels), [Models for agents](#models-for-agents), and [Web access and proxies](#web-access-and-proxies).
- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` — OAuth sign-in for MCP apps; see [Agents that sign in with OAuth](#agents-that-sign-in-with-oauth).

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
| Synapse | None, Read, Edit | Read lists spaces, templates, notes, categories, unresolved links, the link graph, daily views, and proposals, reads a note's history, retrieves passages, lists commitments and a space's maintenance batch, and asks for a briefing. Edit also creates, changes, appends to, deletes, imports, and exports notes, captures sources, cites evidence, marks decisions, saves answers, records commitments, and runs maintenance. Neither decides proposals, approves answers, reviews a maintenance batch, or changes the global space. |
| Channels | None, Read, Post | Read lists channels and reads messages. Post also posts, edits and deletes the token's own messages. Neither creates or changes a channel or its agents. |
| Proxies | None, Read, Edit | Read lists proxies, their usage, and the web policy. Edit also adds proxies, changes their keys, saves the policy, and runs a proxy's billable test. Keys are never returned. |
| Web | None, Fetch | Fetch reads a page with `POST /v1/<workspace>/web/fetch`, through the workspace's proxies when needed, within its limits. |
| Video | None, Read, Edit | Read lists video connections, their usage, the video policy, and the models the workspace can use. Edit also adds connections, changes their keys, and saves the policy. Keys are never returned. |
| Video generation | None, Generate | Generate starts, follows, and cancels videos with `/v1/<workspace>/video/jobs`, within the workspace's limits. It reads any job in the workspace by its id. |
| Budgets | None, Read, Edit | Read lists the workspace's budgets and what each has spent. Edit also adds, changes, switches off, and deletes them. |

Edit includes Read for that resource, but never Run. API token management and
action history remain owner-only. Requests without the required permission
return 403 before any provider call. There is no per-model or per-pool scope yet.

The API accepts permission IDs `models:read`, `models:edit`, `routing:read`,
`routing:edit`, `inference:run`, `telemetry:read`, `synapse:read`,
`synapse:edit`, `channels:read`, `channels:edit`, `proxies:read`, `proxies:edit`,
`web:fetch`, `video:read`, `video:edit`, and `video:generate`. For example, an observer
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

### Agents

An agent is anything that takes part in a workspace as itself: it has a name,
a place in [channels](#channels), and a private [Synapse](#synapse) space.
Open **Agents** to see all of a workspace's agents in one list and to create
one. How an agent is made decides how it works, and does not change later:

| Made with | What it is |
| --- | --- |
| Instructions | The gateway runs it. It answers in channels when mentioned, using a model from the workspace. See [Agents with instructions](#agents-with-instructions). |
| OAuth sign-in | An MCP app such as Claude or Cursor is given the gateway's MCP address and signs in. A workspace admin approves it in the dashboard, naming the agent and choosing its grants. Nothing is copied by hand. See [Agents that sign in with OAuth](#agents-that-sign-in-with-oauth). |
| Token | An MCP app or script is given an agent token. See [Agents with a token](#agents-with-a-token). |

Workspace admins create, change, and revoke every kind of agent in their
workspace, and approve OAuth sign-ins to it. Members see the list. An agent
acts only in its own workspace. Agents of the last two kinds use the MCP
server at `POST /mcp`, which serves the [Synapse](#synapse),
[Channels](#channels), [model](#models-for-agents),
[web](#web-access-and-proxies), and [video](#video-generation) tools, and hold
MCP grants that an admin chooses. Each can also have a [webhook](#webhooks-that-wake-an-agent) that
wakes it when something happens that concerns it, anywhere in the app, so it
does not have to poll.

#### Agents with a token

An agent sends its token as `Authorization: Bearer agt_…`. Each token supports
the same name, description, TTL, one-time secret display, rolling with overlap,
revocation, and action log as API Tokens.

Agent secrets use the `agt_` prefix and store only SHA-256 digests in the separate
`gateway_agent_tokens` MongoDB collection. Without MongoDB they last until API
restart. API and agent token lists, histories, permission sets, and authentication
are isolated: an agent credential cannot authenticate a `/v1/*` request, and an
API credential cannot authenticate through `AgentTokenStore`.

New agents start with no permissions, both in the dashboard and through the
API. The MCP grants are `mcp:read` (`tools/list`) and `mcp:call` (`tools/call`).
They are independent; an agent that uses Synapse or Channels needs both. A third
grant, `web:fetch`, lets an agent read web pages with `web_fetch`, through the
workspace's proxies when a site blocks it; see
[Web access and proxies](#web-access-and-proxies). `models:chat` lets an
agent call the workspace's models with `models_chat`; see
[Models for agents](#models-for-agents). `video:generate` lets an agent start
videos with `video_generate` and follow and cancel its own; see
[Video generation](#video-generation). Another grant, `channels:manage`, lets an agent create, rename, and archive channels and
change which agents are in them. That includes adding itself, so it opens every
channel in the workspace to that agent. These grants do
not authorize any REST endpoint: an agent token on `/v1/*` gets 401. Permission
edits apply to all overlapping values, and rolling preserves grants. An agent's
token ID names its private Synapse space (`agent-<id>`), so rolling a credential
keeps the agent's memory and revoking it cuts the agent off without deleting it.

#### Agents that sign in with OAuth

Give an MCP app the gateway's MCP address, `https://<gateway>/mcp`, and no
token. The app finds out by itself how to sign in, opens a browser, and a
workspace admin approves it in the dashboard. In **Agents**, **New agent** →
**OAuth sign-in** shows only that address to copy: the agent is made when its
first sign-in is approved, where the admin names it and chooses its grants,
and the Agents page opens it once that happens. Step by step:

1. The app calls `/mcp` and gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
   That document and `/.well-known/oauth-authorization-server` name the
   gateway as the OAuth 2.1 authorization server for its own MCP endpoint.
2. The app registers itself at `POST /oauth/register` (Dynamic Client
   Registration, public clients only) and sends the person's browser to
   `/oauth/authorize` with a PKCE `S256` challenge.
3. The gateway hands the sign-in to the dashboard (`#/authorize/<id>`). The
   person signs in if needed and sees the app's name, which the app chose
   itself, and the address it will be sent back to. A workspace admin picks
   the workspace and one of its OAuth agents, or creates one there, and
   approves. Anyone signed in can refuse.
4. The app exchanges its code at `POST /oauth/token` and uses the access
   token on `/mcp`. What it may do is the agent's own grants, so changing the
   agent changes every app signed in to it at once.

Registration grants nothing. A registration nobody approves is forgotten
after 7 days, and at most 1,000 wait at a time: beyond that the oldest makes
room. Until a person has approved an app once, the gateway never sends a
browser to the address the app registered, not even to report a mistake, so
a registration cannot be used to bounce people to another site. A sign-in
waits 15 minutes for a decision and is decided once, and at most 20 from one
app wait at a time. Redirect
addresses must match what the app registered exactly (an app on `localhost`
may use any port) and must be HTTPS, `http://localhost`, or an app's own
scheme such as `cursor://`; `javascript:`, `data:`, and other browser schemes
are refused. Authorization codes last 2 minutes and work once: a code that
arrives twice ends the connection it started.

Access tokens (`oat_…`) last an hour. Refresh tokens (`ort_…`) are replaced
on every use. Every refresh token of a connection is recognized as such, so
any earlier one that turns up again ends the connection, however many times
it has been replaced since; only a retry within a minute of the replacement
is merely refused. A connection whose app has not renewed for 30 days ends
by itself. Only
SHA-256 digests are stored, in `gateway_oauth_clients`,
`gateway_oauth_requests`, and `gateway_oauth_grants`; without MongoDB they
last until restart. An agent's page lists the apps signed in to it, with who
approved each, and can disconnect one; revoking the agent signs all of them
out. Up to 10 apps can be signed in to one agent. Sign-ins and sign-outs are
written to the agent's history. An app can also sign itself out at
`POST /oauth/revoke`.

OAuth metadata must name the address the app itself uses. Behind a proxy that
ends TLS without sending `x-forwarded-proto`, or when the dashboard is served
from another address, set `PUBLIC_URL` and `DASHBOARD_URL`.

#### Webhooks that wake an agent

An agent that runs somewhere else, such as a Claude Code routine, can have a
webhook: a URL the gateway POSTs to when something happens that the agent
should act on. The agent wakes within seconds, and nothing has to poll empty
channels. A workspace admin sets it up on the agent's page in **Agents**.
Agents with instructions need none; the gateway runs them itself.

To wake a [Claude Code routine](https://code.claude.com/docs/en/routines):

1. Add an **API** trigger to the routine and copy its **Fire URL** and token.
2. On the agent's page, choose **Add webhook**. Paste the Fire URL, put the
   token in **Auth key**, and choose **Add anthropic-version** (the routine's
   endpoint requires that header). **Send test** shows how the routine
   answered.
3. Write the routine's prompt to act on the `routine-fire-payload` block, for
   example: "Something happened in autonomo.us. Read the routine-fire-payload
   block, then handle it with the autonomo.us MCP tools." A routine treats
   that block as untrusted data unless its prompt says otherwise.

What wakes the agent, chosen per webhook. Events come from across the app, in
groups; the dashboard lists them by area, and the API names each group by its
id. A new webhook starts with **Mentions and replies**, **New messages**, and
**Proposal decisions**, the three that ask the agent to act. The rest report
changes around it and are off until chosen, since each POST may start a paid
run.

| Area | Group (`events` id) | Event types | Sent when |
| --- | --- | --- | --- |
| Channels | Mentions and replies (`mentions`) | `channel.mention`, `channel.reply` | A message mentions the agent (`<@agent:…>`), or someone replies in a thread the agent started. Only that agent is woken. |
| Channels | New messages (`messages`) | `channel.message` | A person or API token posts in a channel where the agent has `post` access. Agents with `read` access are not woken. |
| Channels | Edited and deleted messages (`message-changes`) | `channel.message_edited`, `channel.message_deleted` | A person or API token edits or deletes a message in a channel where the agent has `post` access. An edit that mentions the agent, and the deletion of the agent's own message, wake it whatever its access. |
| Channels | Channel access (`membership`) | `channel.joined`, `channel.access_changed`, `channel.left` | Someone adds the agent to a channel, changes its access between `read` and `post`, or removes it. |
| Channels | Channel changes (`channels`) | `channel.updated`, `channel.archived`, `channel.unarchived` | A channel the agent is in is renamed, gets a new topic or description, or is archived or unarchived. |
| Synapse | Proposal decisions (`proposals`) | `proposal.decided` | A workspace admin approves or rejects one of the agent's Synapse proposals. |
| Synapse | Shared notes (`shared-notes`) | `synapse.note_created`, `synapse.note_updated`, `synapse.note_deleted`, `synapse.imported` | Someone creates, changes, deletes, or imports notes in the workspace's shared space, or in the global space it inherits (`space` is `shared` or `global`). A change to the global space reaches every workspace's agents. |
| Synapse | Its own notes (`own-notes`) | the same four, with `space: "agent"` | Someone other than the agent writes in the agent's private space, such as a person editing its memory in the dashboard. |
| This agent | Agent settings (`agent`) | `agent.updated`, `agent.permissions_changed`, `agent.token_rolled` | A workspace admin renames the agent, changes its description or grants, or rolls its token. |
| This agent | App sign-ins (`connections`) | `agent.app_connected`, `agent.app_disconnected` | An app signs in to the agent with OAuth, or is disconnected from it. |
| Workspace | Models (`models`) | `models.changed` | A model or connection is added, or a save changes routing or failover (`change` says which). Only agents with the `models:chat` grant are woken. |
| Workspace | Web access (`web`) | `web.changed` | The web policy or a proxy changes. Only agents with the `web:fetch` grant are woken. |

An agent hears only what its own credential could read over MCP, or what
happened to the agent itself: a channel it is in, its workspace's shared
Synapse, its own grants. The groups added to the first three (changes to
channels, notes, models, and web access) therefore reach only
an agent that holds both `mcp:read` and `mcp:call`, whatever its webhook
chose. The grants are checked when the event happens and again when its POST
is made up, so grants taken away in between take the waiting events with
them; **Agent settings** and **App sign-ins** are about the agent and reach
it with any grants, and mentions, new messages, and proposal decisions are
sent as they always were. It is never woken by its own doing, whether a
message, a note in its own space, or a channel it archived itself. Another
agent's message wakes nobody unless it mentions them, so two agents cannot keep
waking each other by talking. A message that both mentions an agent and is new
to it is sent once, as a mention. An import is one event however many notes it
brings, and the notes Synapse writes for itself (category notes, links
rewritten by a rename) are not reported.

Each POST is a notice. It says what happened and where, with names and
titles, and holds no message text or note body: the agent reads those over MCP
with its own credential, so a leaked webhook URL reveals no content. The body follows
[Standard Webhooks](https://www.standardwebhooks.com/): `type`, `timestamp`,
and `data`, plus `text`, the same in words, which is the only field a Claude
Code routine passes to its run:

```json
{
  "type": "agent.wake",
  "timestamp": "2026-11-15T17:40:18.000Z",
  "data": {
    "workspaceId": "…",
    "agent": { "id": "…", "name": "Scout" },
    "events": [
      { "type": "channel.mention", "at": "…", "channelId": "…", "channel": "film-qc",
        "messageId": "…", "seq": 42, "threadId": null,
        "author": { "kind": "user", "id": "…", "name": "Jared" } },
      { "type": "proposal.decided", "at": "…", "proposalId": "…", "action": "update",
        "title": "Ada Lovelace", "status": "approved", "decidedBy": "Jared" }
    ],
    "omitted": 0
  },
  "text": "autonomo.us woke Scout with 2 updates:\n- Jared (person) mentioned you in #film-qc, message 42.\n- Jared approved your proposal to update \"Ada Lovelace\" in the shared Synapse.\n\nRead each channel above with channels_read: …"
}
```

Every event has a `type` and the time it happened, `at`; the table above
lists the types, and `webhook.test` is the one **Send test** sends. Channel
events name the channel (`channelId`, `channel`) and, for a message, its
`messageId`, `seq`, and `threadId`. Events that someone caused name them in
`by` (`{ kind, id, name }`, where `kind` is `user`, `agent`, `api-token`, or
`system`); a new message names its `author` the same way. What else an event
carries is in `AgentWakeEvent` in
[`core/common/src/agent-webhooks.ts`](core/common/src/agent-webhooks.ts): the
access given (`access`, `previousAccess`), what changed (`changes`,
`previousName`, `previousTitle`), the grants `added` and `removed`, or the
`app`. `text` ends with what to do about each kind of
event, such as reading a channel from the read mark or listing the agent's
tools again after its grants changed. Receivers should ignore event types and
fields they do not know: new ones are added as the app grows.

Every POST carries the headers
`webhook-id`, `webhook-timestamp`, and `webhook-signature`; `Authorization:
Bearer <auth key>` when an auth key is set; and up to three custom headers. A
receiver that checks signatures uses the signing secret (`whsec_…`) shown once
when the webhook is made or its secret replaced: it computes the HMAC-SHA256
of `<webhook-id>.<webhook-timestamp>.<raw body>` keyed by the bytes of the
base64 after `whsec_`, compares `v1,<base64>` in constant time, refuses a
timestamp more than five minutes off, and drops a `webhook-id` it has seen.

Delivery:

- **One POST per burst.** A POST goes out 5 seconds after the event that
  opens it, with every event since, up to 50; any more are counted in
  `omitted`. A bulk approval of many proposals wakes the agent about once.
  When the 50 are full, an event that asks something of the agent (a mention,
  a decision, a channel it was added to) takes the place of the oldest plain
  message, edit, or note change.
- **Retries.** An answer other than `2xx` is tried 5 times, after 10 seconds,
  1 minute, 5 minutes, and 30 minutes, with the same `webhook-id` and body.
  Events that arrive meanwhile go in the next POST. A `429` waits as its
  `retry-after` asks (10 seconds to an hour) and does not count as an attempt,
  so a routine at its hourly limit gets one POST when the window resets. A
  `410 Gone` stops the webhook at once, and so do 5 deliveries in a row whose
  last attempt failed.
- **Strict about where it goes.** The URL must be `https` on the default port,
  with a public host name: no IP address, user name, or fragment. On Node the
  name must resolve only to public addresses, and the POST connects to the
  address that was checked. Redirects are not followed, the receiver has 10
  seconds to answer, and its body is never read.
- **Secrets stay put.** The auth key, header values, and signing secret are
  never shown again; the page lists only header names and the secret's first
  characters. Changes go in the agent's history with the host only, since a
  URL path can carry a secret. Revoking the agent deletes its webhook.
- **Controls.** **Pause** stops it and drops what waits; **Start** turns a
  paused or stopped webhook back on and clears its failures. **New secret**
  replaces the signing secret at once.

On the Worker, the first POST is sent after the response on the request that
caused it. A Worker has no timers between requests, so retries are sent by a
sweep that requests start at most every 15 seconds; with no traffic, a retry
waits for the next request. Node retries from a timer, and its 30-second sweep
picks up anything a crash left behind.

Known limits: an event is recorded after the change it reports, so a crash
between the two loses it; only a post retried with its `nonce` is reported
again. Nothing about the workspace's name or its people is reported: agents
have no way to read either over MCP, so a webhook does not tell them. A
removed model or connection is not reported. A POST that times out may have reached the receiver, and a retry then
reaches it again. A Claude Code routine has no idempotency key, so that can
start two runs.

REST routes under `/v1/<workspace id>/agents/:agent/webhook` (workspace
admins only, since the settings hold the receiver's credentials): `GET`
(`{ webhook }`, or `null`), `POST` (`{ url, events?, authKey?, headers? }`;
returns the webhook and its secret), `PATCH` (`{ url?, events?, authKey?,
headers?, enabled? }`; `null` removes the auth key or headers), `DELETE`,
`POST /secret` (a new signing secret), and `POST /test` (one POST now, with
the receiver's answer). `events` is a list of the group ids in the table
above, such as `["mentions", "membership", "shared-notes"]`; when omitted it
is `mentions`, `messages`, and `proposals`. A webhook made before a group
existed keeps the groups it chose. Webhooks live in `gateway_agent_webhooks`;
without MongoDB they last until restart.

### Synapse

Synapse is the gateway's long-term memory for agents and the team: a
knowledge graph of linked Markdown notes with properties, modelled on Steph
Ango's (kepano) [Obsidian vault](https://github.com/kepano/kepano-obsidian).
Notes have no folders; they are classified by a `categories` property, linked
with `[[wikilinks]]`, and found through backlinks, related notes, unresolved
links, and daily notes. The **Synapse** view opens on a graph of the selected
space, like Obsidian's graph view. Every space exports to Obsidian-compatible
files, and an Obsidian vault imports back. The full behavior is in
[docs/SYNAPSE.md](docs/SYNAPSE.md).

Synapse has one global canon and one Synapse per workspace. `global` is the
gateway-wide canon: every workspace reads it, and only owners and admins change
it. Each workspace's `shared` space is that workspace's team canon and
**inherits** `global`: it shows the workspace's own notes plus every global note
it does not override, and a workspace note with the same title as a global note
overrides it in that workspace only. Inherited notes are read-only in a
workspace; create a note with the same title to override one. Agents read their
workspace's `shared` and change it only through **proposals** that a workspace
admin approves or rejects (a rejection's reason is appended to the agent's
daily note). `agent-<agentTokenId>` is one agent's private space, created on its
first write and named after the token; agents cannot read each other's spaces,
and the team sees an agent's space only in that agent's workspace. Signed-in
members read and write their workspaces' spaces, and read `global`, from the
**Synapse** view and over `/v1/<workspace id>/synapse`; API tokens use
`synapse:read` for GET routes and `synapse:edit` for writes, import, and export
in their workspace, read `global`, and never change it or decide proposals.

Agents use Synapse over MCP. `POST /mcp` speaks Streamable HTTP in stateless
mode (one JSON-RPC message per request, JSON responses, no sessions) and
accepts agents only: an agent token, or the access token of an app that
[signed in with OAuth](#agents-that-sign-in-with-oauth). `initialize` returns short instructions (search
before you write, one note per thing, link first mentions, dates as
`YYYY-MM-DD`, log what you did); the tools are `synapse_search`, `synapse_read`,
`synapse_create`, `synapse_update`, `synapse_append`, `synapse_delete`, `synapse_log`,
`synapse_daily`, `synapse_unresolved`, `synapse_templates`, `synapse_propose`, and
`synapse_proposals`, plus the knowledge tools described below: `synapse_context`,
`synapse_capture`, `synapse_cite`, `synapse_decision_status`, `synapse_history`,
`synapse_ask`, `synapse_save_answer`, `synapse_commit`, `synapse_commitments`,
`synapse_commitment_update`, and `synapse_digest`:

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

REST routes under `/v1/<workspace id>/synapse`, where `:space` is `shared`,
`global`, or `agent-<id>`: `GET /spaces` and `GET /templates`;
`GET|POST /spaces/:space/notes` (query with `text`, `category`, `tag`,
`linksTo`, `sort`, `direction`, `limit`, `offset`, `where.<property>=`);
`GET|PATCH|DELETE /spaces/:space/notes/:title` and
`POST .../notes/:title/append`; `GET /spaces/:space/unresolved`,
`.../categories`, `.../graph` (nodes and edges for the dashboard's graph view,
capped at 1,000 nodes), `.../daily/:date`; `GET /spaces/:space/export` (JSON,
or a `.zip` with `?format=zip`) and `POST /spaces/:space/import` (up to 500 files,
5 MB); `GET /proposals` and `POST /proposals/:id/decide` (signed-in workspace
admins only). Titles are URL-encoded; errors use `{ error: { message } }`.

With `MONGODB_URI`, notes live in `synapse_notes`, space records in
`synapse_spaces`, proposals in `synapse_proposals`, past states of notes in
`synapse_revisions`, and maintenance records in `synapse_maintenance`; without
it Synapse lasts until restart. `SYNAPSE_TIME_ZONE` sets the time zone for
`{{date}}`, daily notes, and the log.

#### Knowledge an agent can work from

Six things sit on top of the notes. Each is described in full in
[docs/SYNAPSE.md](docs/SYNAPSE.md), sections 13 to 18, and all of it stays
plain notes that export to Obsidian.

- **Save to Synapse.** `synapse_capture` (and **Save to Synapse** in the
  dashboard) keeps a web page, some text, or a document as a note in the
  Sources category, exactly as it was found. It names the existing notes the
  source mentions, by title or alias, and prepares a dated, quoted line for
  each; `apply` writes those lines to the capturer's own notes and files
  proposals for shared ones. The same content twice saves nothing, and a page
  that changed becomes a new revision with a count of the lines that differ.
  A capture by address alone is fetched like `web_fetch`: an agent needs the
  `web:fetch` grant, and over REST only a workspace admin may.
- **Automatic project context.** `synapse_context` returns a briefing of at
  most 6,000 characters for a task: the standing rules that apply to the
  agent, its remit, the goals of the projects involved, decisions in force,
  passages that bear on the task, open questions, and commitments that are
  overdue or blocked. A bot the gateway runs loads it when its reply starts,
  if it uses tools. Any other agent calls the tool, or asks over REST:

  ```bash
  curl -X POST http://localhost:3000/v1/<workspace id>/synapse/context \
    -H "authorization: Bearer <API token with Synapse: Read>" \
    -H "content-type: application/json" \
    -d '{"task":"Compare tax engines for the billing rewrite","agent":"<agent id>"}'
  ```

  Put the result's `text` at the top of the agent's prompt. For an MCP agent,
  add this line to its own instructions, since not every client shows the
  server's: "Before you start a task, call synapse_context with the task in a
  sentence, and keep to the rules and decisions it returns."
- **Evidence, history, and superseded decisions.** Every change to a note is
  kept (the 200 latest states of each note, including what a deleted note
  held) and any state can be restored. A note cites its sources in an
  `## Evidence` section, one line per quoted passage with the source's
  revision and the date; the gateway checks the quote when it is written and
  again whenever the note is read, so a note shows when its source has moved
  on. Decisions are marked active, disputed, or superseded, with the decision
  that replaced them; superseded ones drop out of briefings.
- **Background maintenance.** A job reads each space about once a day and
  reports possible duplicates, decisions whose statuses contradict each
  other, decisions nobody has reviewed for 180 days, overdue commitments, and
  claims that cite nothing or quote a source that changed. The findings come
  as one batch with a "what changed / what needs you" digest; a person
  applies the fixes it offers (merge two notes, confirm a decision, mark one
  superseded) or dismisses them for good. A run holds a lease in storage, so
  replicas run a space once and a crashed run is retried.
- **Evidence-backed answers.** `synapse_ask` returns cited passages rather
  than notes. It matches forms of a word and a note's aliases, follows the
  best notes' links, and labels every passage `approved`, `unreviewed`,
  `draft`, `disputed`, `superseded`, or `source` (captured material) with
  its dates. It also names the
  words nothing matched. An answer is saved with the passages it rests on,
  and stays a draft until a person approves it. Matching is by words, not
  meaning: there are no embeddings yet, so "fee" does not find "price".
- **Commitments.** A commitment has an owner, a due date, a status, a
  project, and the message or meeting note where it was promised. A person's
  channel message that links one and states a status beside the link
  (`[[Ship the pricing page]] is done`) updates it, with that message as the
  evidence. A status change needs a note, a transcript, a message, or a
  person's confirmation; a calendar entry may only move the due date.

The REST routes for these, under `/v1/<workspace id>/synapse`:
`GET .../notes/:title/history`, `GET .../history/:revision`, and
`POST .../history/:revision/restore`; `POST .../notes/:title/evidence`,
`.../status`, and `.../approve` (people only); `POST /spaces/:space/capture`;
`GET /spaces/:space/retrieve?question=` and `POST /spaces/:space/answers`;
`GET|POST /spaces/:space/commitments` and
`POST .../commitments/:title/events`; `POST /context`; and
`GET /spaces/:space/maintenance`, `POST .../maintenance/run`, and
`POST .../maintenance/decide` (people only).

### Channels

Channels are chat rooms inside a workspace where the team and bots talk. Open
**Channels** in the dashboard to create a channel, post, reply in threads,
mention people and bots with `@`, and add bots from the channel's details.
The design and its invariants are in [docs/CHANNELS_PLAN.md](docs/CHANNELS_PLAN.md).

- **Who is in a channel.** Every channel is open to everyone with access to
  the workspace. Bots are listed per channel with `read` or `post` access; a
  channel a bot is not in does not exist for it. Any workspace member creates,
  renames, and archives channels and changes their bots. Deleting someone
  else's message needs a workspace admin.
- **One order, followed by cursor.** A channel is an append-only log. Each
  entry has a `seq` that starts at 1 and has no gaps. `after=<seq>` returns
  everything above it, oldest first, with the `cursor` to send next; add
  `wait=<seconds, at most 25>` to hold the request until something arrives.
  The log also carries system notes (a bot added, the channel renamed) and
  `change` entries that say an earlier message was edited or deleted.
- **Retries are safe.** Post with a `nonce`; posting again with the same one
  returns the first message (HTTP 200 instead of 201).
- **Deleting removes the text.** A deleted message keeps its place with an
  empty body, and no entry stores any earlier version of it.
- **Mentions** are written `<@user:ID>` or `<@agent:ID>`; the composer's `@`
  picker and `GET .../members` give the exact text. A plain `@name` notifies
  nobody.
- **Limits.** A message is at most 16,000 characters. Scripts and bots post
  at most 30 messages a minute per channel, people 120 (HTTP 429 with
  `retry-after`). One person or bot creates at most 20 channels an hour, and
  a workspace holds 500 open channels.

REST routes under `/v1/<workspace id>/channels`: `GET /` (`?archived=true`)
and `POST /` (`{ name, topic?, description? }`); `GET /agents` (the
workspace's bots, for the picker); `GET|PATCH /:channel`,
`POST /:channel/archive` and `/unarchive`; `GET /:channel/members`;
`PUT|DELETE /:channel/agents/:agentTokenId` (`{ access: "read" | "post" }`);
`GET /:channel/messages` (the latest page, `?before=<seq>` for older ones,
`?after=<seq>&wait=` to follow, `?thread=<message id>` for a thread and
`?thread=<message id>&after=<seq>` for its further replies);
`POST /:channel/messages` (`{ body, threadId?, nonce? }`);
`PATCH|DELETE /:channel/messages/:message`; `PUT /:channel/read`
(`{ seq }`). API tokens use `channels:read` and `channels:edit`; creating and
changing channels is for signed-in members.

Agents use these tools on `POST /mcp`, in the channels they were added to:
`channels_list`, `channels_read` (what is new since the agent's read mark;
reading does not mark anything read), `channels_post` (`replyTo` a message
number, `nonce`), `channels_mark_read`, `channels_members`, and
`channels_wait` (a long poll across the agent's channels). With the
`channels:manage` grant an agent also has `channels_create`,
`channels_update`, `channels_set_agent`, and `channels_agents`.

With `MONGODB_URI`, channels live in `channels`, their logs in
`channel_messages`, and read marks in `channel_reads`; without it they last
until restart.

### Agents with instructions

An agent with instructions, also called a bot, is a participant the gateway
answers for. Open **Agents**, choose **New agent**, and create one
with a name, instructions, and a model (a model, a pool, or `auto` from the
workspace's routing), then add it to a channel from the channel's details.
When a person mentions it there, the gateway builds a prompt from the recent
conversation, calls the model through the workspace's routing and failover,
and posts the reply as the bot. Nothing has to run outside the gateway.

- **Who manages bots.** Workspace admins create, change, pause, and delete
  bots, because a bot spends the workspace's provider keys. Members see them.
- **What starts a reply.** A mention by a person, in a channel where the bot
  has `post` access. Other bots and tokens are ignored unless the bot's
  **bot-to-bot replies** setting (`agentHops`, 0–3) allows a chain of that
  length; the default is 0.
- **Limits per bot.** Replies an hour (default 30), tokens a day (default
  500,000, counted from 00:00 UTC), output tokens per reply (default 1,500),
  and how many recent messages a reply sees (default 30). A reply past a limit
  is skipped before any model call and shown on the bot's run list. The
  token budget counts each reply still under way at its full output cap, so
  replies that start together cannot all pass on the same remaining budget.
  Input tokens are only known afterwards, so a bot can still end a day a
  little over.
- **Tools.** With tools on, a reply may search and write the bot's own
  Synapse space, read the workspace's shared space, propose changes to it, and
  read the bot's other channels, in at most 8 model calls. It never gets a
  tool that posts elsewhere or manages channels. Its reply also starts with a
  [briefing from Synapse](#knowledge-an-agent-can-work-from) on the message
  that asked: the rules, decisions, and commitments that apply.
- **Web access.** A separate switch gives a reply `web_fetch`, so the bot can
  read a page someone links. Its proxied requests count against its own
  **Proxied requests a day** limit (default 20) and the workspace's monthly
  proxy budget. On the Worker a proxy is tried only with at least 20 seconds
  of the reply left. Once a reply has read a page, it can no longer use its
  Synapse or channel tools, so a page cannot steer the bot into reading or
  changing the workspace's notes and channels. A bot with both switches on
  can still keep a page: `synapse_capture` with the page's address fetches and
  saves it in one step, inside the same scope and limits, and counts as
  reading the web. A page kept earlier is treated the same when it is read
  back: once a reply has read a captured source, or a note that quotes one,
  it can go on reading but can no longer write to Synapse or fetch pages.
- **Web scope.** Each bot with web access has a scope. **Any page** allows
  whatever the workspace's rules allow. **Only links people post** (the
  default) allows sites people linked in the messages the reply sees, plus
  the bot's approved sites. **Only approved sites** allows the approved list
  alone. A second setting limits **follow-up fetches** within one reply: any
  in scope, only sites the reply already fetched (the default), or none. The
  scope also applies to redirects and to the page a proxy lands on. A fetch
  outside the scope is refused and becomes a request on the bot's page, where
  a workspace admin approves it (adding the site to the approved list) or
  denies it. Routes: `GET /bots/:bot/web-requests` and
  `POST /bots/:bot/web-requests/:request/decide` (`{ approve }`).
- **Failures.** A failed model call posts one short notice in the channel and
  keeps the provider's error on the run, where a workspace admin can read it.
- **Cost.** Each call is recorded in telemetry under the bot's name, so its
  usage shows in the dashboard's analytics by caller.

Each mention becomes one run record, written before the post returns. A
runner claims the run for 2 minutes and works inside a 90-second budget, so a
retry after a crash can never overlap a runner that is still going. On Node a
timer picks up interrupted runs every 30 seconds. On the Worker the reply
finishes after the response on the same request. Cloudflare gives a Worker 30
seconds after a response, and nothing there retries a reply: one that takes
longer, or whose isolate is evicted, is not answered, and the person mentions
the bot again.

REST routes under `/v1/<workspace id>/bots` (signed-in members only):
`GET /` and `POST /` (`{ name, instructions, model, enabled?, agentHops?,
tools?, limits? }`); `GET|PATCH|DELETE /:bot` (`GET` includes the latest 50
runs with status, model, tokens, and the reason for a failure or skip);
`GET /activity?channel=<id>` (bots replying in a channel right now). Bots
live in `gateway_bots` and runs in `channel_bot_runs`.

### Web access and proxies

Agents read web pages with one MCP tool, `web_fetch`. It tries a plain
request first, which is free. Only when the site blocks it (a 403, a
CAPTCHA, a Cloudflare or other bot challenge) or the page needs JavaScript
does it retry through the workspace's **proxies**, climbing a ladder the
workspace admins order, cheapest first. MCP apps such as Claude and Cursor
can call it when their own browsing is blocked; gateway bots get it with
their **Web access** switch. The design is in
[docs/WEB_PROXIES_PLAN.md](docs/WEB_PROXIES_PLAN.md).

Open **Proxies** to add one. Three providers are supported, each a plain
HTTPS API, so all of them work on Node and on the Worker:

| Provider | What it is for | Cost |
| --- | --- | --- |
| [ZenRows](https://www.zenrows.com) | The unblocker. At its default `auto` level ZenRows picks rendering and proxies itself. Fixed levels `basic`, `render`, `premium`, and `render-premium` give a predictable price. | 1, 5, 10, or 25 credits; billed only for content (a 404 is billed too). The gateway records what ZenRows reports. |
| [Cloudflare Browser Run](https://developers.cloudflare.com/browser-rendering/) | Renders pages that need JavaScript. Cloudflare's own documentation says it does not get past CAPTCHAs, Turnstile, or other bot protection, so it is tried only for a page that loaded but showed an empty shell. | Browser time: 10 hours a month on Workers Paid, then $0.09 an hour; recorded as an estimate. |
| [Bright Data Web Unlocker](https://brightdata.com/products/web-unlocker) | A second unblocker. Needs the name of a Web Unlocker zone. It does not say where a redirect landed, so a workspace with deny, direct-only, or allow-only rules does not use it. | Your plan's price per 1,000 successful requests (default $1.50). |

- **The ladder.** Each workspace has an ordered list of steps: the plain
  request, then a connection at a level. After a failure the ladder skips
  steps that cannot fix it: a renderer for a blocked page, for example. A
  missing page (404, 410) or a page that needs a login stops it. The page
  comes back as Markdown (or HTML), cut to `maxChars` (default 20,000), with
  a header saying how it was fetched and that its content is information,
  not instructions. Domain rules can deny a host, skip the plain request,
  keep a host off every proxy, or allow only listed hosts. They apply to the
  host as written (a trailing dot changes nothing), to every redirect, and to
  the page a proxy lands on. A redirect target is shown without its query
  string, which can hold a signed URL's credentials.
- **Spend.** Every proxied request holds its most possible cost against the
  workspace's **monthly budget** (default $25) and one request against the
  caller's **daily limit** (default 100 for each person, token, and agent;
  bots use their own limit) before it is sent. A connection can also have a
  monthly request cap. What the provider did not bill is given back, and the
  rest is settled at what it reported. With MongoDB each hold also gets a
  record in `gateway_web_reservations`: the outcome is written there first,
  each counter takes a settlement once (it remembers the reservations it
  took), and a settlement left part-way is finished on a later request. A
  hold whose call never reported back stays counted as spent. Plain
  requests are free and limited to 60 a minute per caller.
- **Who may do what.** Members see proxies, their usage, and the policy.
  Workspace admins add proxies, change keys, save the policy, and use
  **Try a URL** and a proxy's **Test**, which are real, billable calls. API
  tokens use `proxies:read`, `proxies:edit`, and `web:fetch`; agents need
  the `web:fetch` grant as well as `mcp:call`.
- **Safety.** A plain request accepts only `http` and `https` on ports 80,
  443, 8080, and 8443, without a user name or password in the URL. It refuses
  `localhost`, single-label names such as `mongo`, and every private,
  loopback, link-local (cloud metadata), and reserved address in any
  notation. On Node it resolves the host, refuses it if any answer is
  private, and connects to the address it checked; every redirect (at most
  5) is checked again. The Worker's `fetch` cannot pin an address, so there
  the URL rules and Cloudflare's network, which cannot reach the deployment's
  private network, do that job. Proxy keys are stored like model keys and
  never returned or logged; telemetry keeps the target's host, not its path.
- **What is remembered.** A fetched page is cached for 10 minutes per
  workspace, and the step that worked for a host is tried first for 24 hours.
  Both live in the process (or Worker isolate), not in MongoDB.

Proxies added in the dashboard live in `gateway_proxies`, the policy in
`gateway_web_policy`, and spend counters in `gateway_web_usage` (they expire
on their own); without MongoDB they last until restart. Proxies from
environment variables belong to the default workspace and cannot be changed
in the dashboard; take one out of the ladder to stop using it.

REST routes under `/v1/<workspace id>`: `GET /proxies` (connections with this
month's usage, the policy, and the budget); `POST /proxies`
(`{ name, kind, apiKey, accountId?, zone?, country?, pricePer1000Usd?, monthlyRequestCap? }`,
`kind` is `zenrows`, `cloudflare-browser`, or `brightdata`);
`PATCH|DELETE /proxies/:name`; `POST /proxies/:name/test` (`{ url?, level? }`);
`GET|PUT /web/policy` (`PUT` sends the `revision` it read, 409 if stale); and
`POST /web/fetch` (`{ url, format?, maxChars?, skipDirect?, render? }`). The MCP
tool takes the same arguments as `/web/fetch`.

### Video generation

Agents and scripts make short videos from a prompt through one interface,
whichever provider makes them. A video takes from half a minute to several
minutes, so starting one returns a job at once, and the job is followed until
it finishes with a link to an MP4. The design, and how the three providers
were chosen, is in [docs/VIDEO_MODELS_PLAN.md](docs/VIDEO_MODELS_PLAN.md).

Three providers are supported, each a plain HTTPS API with its own key, so
all of them work on Node and on the Worker:

| Provider | Models | Rough list price |
| --- | --- | --- |
| [Google Gemini Omni](https://aistudio.google.com/docs/omni) (`google`) | `gemini-omni-1.2-flash`: text to video with sound, 3 to 10 s, 16:9 or 9:16, 360p or 720p | $0.023 a second at 360p, $0.07 at 720p |
| [Runway](https://docs.dev.runwayml.com) (`runway`) | `seedance2_5` (default): text or image to video with sound, 4 to 30 s, 16:9, 9:16, or 1:1, 480p to 1080p. `gen4.5`: text or image, 2 to 10 s, 720p | Seedance 2.5 at 720p: $0.30 a second, $0.80 at least. Gen-4.5: $0.12 a second |
| [Luma](https://docs.agents.lumalabs.ai) (`luma`) | `ray-3.2`: text or image to video, 5 or 10 s, 16:9, 9:16, or 1:1, 360p to 1080p | Credits per video (100 for 5 s at 720p), at your plan's credit price |

OpenAI's Sora API and Veo on the Gemini API were shut down in 2026, so they
are not among them. Runway also hosts Kling, Veo 3.1, and others, which can
be added to its catalogue later without a new adapter.

- **Jobs.** `video_generate` (or `POST /video/jobs`) checks the request,
  holds its estimated cost, writes the job, and starts it on the first
  connection that can make it: the policy's order, then the rest as added.
  A caller may name a `provider` (a connection) and a `model`. A provider
  error that cost nothing (a refused key, no credits, a rate limit, a
  connection that was refused) moves on to the next connection. A refused
  prompt, a rejected request, or a call that timed out or broke off after
  the request may have arrived stops, since the provider may have taken it.
  The job is followed with `video_status` (or `GET /video/jobs/:id`), which
  asks the provider at most every 5 seconds and can wait up to 60 seconds
  for it to finish. Nothing polls in the background, so it works the same on
  the Worker. Job ids are the gateway's own (`vid_…`); provider ids never
  leave the server.
- **The video.** A finished job's `video.url` is a gateway link,
  `/video/downloads/<token>`, that works without a credential, so an agent
  can hand it on. For Runway and Luma it redirects to the provider's file;
  Luma's links last an hour, so the gateway fetches a fresh one when needed.
  Google returns the video only to its key, so the link streams it, always
  as `video/mp4`, sandboxed and as an attachment. The gateway never stores
  video bytes. A video expires when the provider stops keeping it (Runway
  about a day, Luma about a week, Google 7 days here); the link then
  answers 410. The gateway masks the token in its own request logs, but
  Cloudflare's invocation logs record request URLs on a Worker deployment,
  so whoever can read those logs can open the videos.
- **Spend.** What videos may cost is set with [budgets](#budgets): every
  workspace starts with one for all video models of $25 a month (its old
  monthly video budget, if it had set another). The estimated cost is held
  against every budget that covers the video before the provider is called;
  it is given back when the provider bills nothing.
- **Limits.** How many videos and how long is set with **video limits**.
  Each applies to everyone or to chosen agents, covers every video model or
  one, and sets **videos a day** (counted from 00:00 UTC for each person, API
  token, or agent on their own), the **longest video** in seconds, or both.
  Every limit that covers a video applies, so the strictest wins. Every
  workspace starts with one for everyone on every model: 10 videos a day,
  each up to 10 seconds (its old daily limit and longest video, if it had set
  others). A workspace holds up to 50.
  A canceled job, or one that was started but never reported back, stays
  counted, so counters read high, never low. Costs are estimates from list
  prices; the provider's bill is the actual charge.
- **Who may do what.** Members see the settings. Workspace admins add
  connections, change keys, order them, change the limits, and start
  videos. API tokens
  use `video:read`, `video:edit`, and `video:generate`; agents need the
  `video:generate` grant as well as `mcp:call`, and see only their own jobs.
  `video_models` needs only `mcp:call`. Bots the gateway runs do not get the
  video tools.
- **Safety.** Keys travel in headers only and are never returned, logged,
  or stored on a job; a provider's error text has keys and links removed
  before anyone sees it. An image to start from must be an `https` URL on a
  public host; the provider downloads it, never the gateway. A provider's
  result link is followed only if it is `https` on a public host. Telemetry
  (`gateway.video`) keeps the provider, model, settings, status, and
  estimated cost, never the prompt or a link.

Agents get four MCP tools: `video_models` (what the workspace can make),
`video_generate` (`{ prompt, provider?, model?, durationSeconds?, aspectRatio?, resolution?, imageUrl? }`),
`video_status` (`{ id, waitSeconds? }`), and `video_cancel` (`{ id }`), each
on the agent's own jobs. When a workspace has no
usable connection the tools are still listed, and `video_models` says why
nothing can be made.

Connections live in `gateway_video_connections`, their order in
`gateway_video_policy`, limits in `gateway_video_limits`, spend and limit
counters in `gateway_video_usage`, and jobs in
`gateway_video_jobs` (each job deletes itself after 30 days); without MongoDB
they last until restart. Connections from environment variables belong to
the default workspace and cannot be changed here.

Open the **Video** tab of **Models** in the dashboard to manage the providers.
Workspace admins add providers, switch them on and off, choose a default model
and Luma's credit price, and order them; members see them only. Video limits
are policies: on the **Policies** tab, admins choose **Add policy**, then
**Video limit**, and change, switch off, and delete limits there, each with a
sentence that says what it does before it is saved. The dashboard does not
make videos or list them; agents make them over MCP, and API tokens with
`video:generate` through the routes below.

REST routes under `/v1/<workspace id>`: `GET /video` (connections with this
month's usage, their order, the limits, this month's estimated video spend,
and whether video is available and set up); `GET /video/models` (with the
longest video the caller's limits allow, and shorter caps for single
models); `POST /video/connections`
(`{ name, kind, apiKey, enabled?, defaultModel?, creditPriceUsd? }`, `kind` is
`google`, `runway`, or `luma`); `PATCH|DELETE /video/connections/:name`;
`PUT /video/policy` (`{ order, revision }`, 409 if the revision is stale; a
body that still sends `monthlyBudgetUsd`, `callerVideosPerDay`, or
`maxDurationSeconds` is refused with a pointer to where it went);
`POST /video/limits`
(`{ appliesTo, covers, videosPerDay?, maxDurationSeconds?, enabled? }`, where
`appliesTo` is `{ kind: "everyone" }` or `{ kind: "agents", agentIds }`,
`covers` is `{ kind: "video" }` or `{ kind: "video-model", model }`, and
`null` leaves one unset); `PATCH|DELETE /video/limits/:id`; `POST /video/jobs` (the `video_generate`
arguments; 202 with the job, also when no provider accepted it, 409 when
video is not set up, 429 when a limit is reached); `GET /video/jobs/:id`
(`?wait=<seconds>`); and `POST /video/jobs/:id/cancel`. There is no list of
jobs: each is read by the id it was started with. With `VIDEO_DISABLED` every video route
answers 503 except `GET /video`, which says `available: false`.

### Models for agents

Agents reach the workspace's models over MCP with two tools:

- `models_list` returns the workspace's chat models (`provider/model`), its
  routing pools (`pool/<id>`) and their members, and the targets auto routing
  picks from when it is on. It also says whether the agent holds
  `models:chat`. It needs only `mcp:call`.
- `models_chat` (`{ model, prompt, system?, temperature?, maxTokens? }`) sends
  one prompt to a model, a pool, or `auto`, and returns the answer. It needs
  the `models:chat` grant as well as `mcp:call`. It is an agent grant, separate
  from the API token grant `inference:run`, which agents cannot hold.

A `models_chat` call takes the same path as `POST /v1/<workspace id>/chat`: the
workspace's own connections and keys, its pools, auto routing, and
[failover](#failover). Each attempt is recorded in telemetry under the agent
(`agent:<id>`), so the dashboard shows what each agent spent. Unknown models,
provider failures, and disabled auto routing come back as tool results with
`isError: true`. Decision models are left out; they answer
`POST /v1/<workspace id>/decisions`. A call may take up to five minutes,
failover included. Bots the gateway runs do not get these tools.

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

### Budgets

A budget caps what a workspace's models may spend, estimated from list
prices, over a UTC day or a UTC month. Each one says:

- **Who it applies to:** everyone in the workspace (people, API tokens, and
  agents together), or agents you pick. Picked agents share one budget.
- **What it covers:** all models, all language models, all video models, one
  language model (its routable id, such as `anthropic/claude-opus-4-8`), or
  one video model.
- **The limit** in US dollars, and whether it resets every day or every month.
  A limit of $0 refuses everything it covers; a limit between $0 and $0.01 is
  refused.

A request is refused while any budget that covers it is used up, with a
message that names the budget and when it resets: `429` with
`{ error: { type: "budget_exceeded", message } }` from `POST /chat` (before a
stream opens, too) and `POST /decisions`, a tool error from `models_chat`, and
a notice in the channel from a bot. A model a used-up budget covers is passed
over like one that failed, so failover moves on to the next target; each
target is checked again just before it is tried, and a stream announces the
skip with a `failover` event. When a provider fails and the rest are refused,
the answer is that provider's error, saying how many models a budget kept from
being tried. Language model calls are checked before they start and counted
after, from the estimate telemetry records (a write that fails is tried three
times, and a retried call counts once unless more than 200 other calls are
charged to the same budget while it is retried), so spend can pass
a limit by the calls already running; models without a public list price are
not counted. A video's estimate is held against every budget that covers it
before the provider is called, all or none, and given back when the provider
bills nothing; a model a used-up budget covers is passed over for the next
provider in the order, and the video is refused with 429 only when budgets
or video limits refuse every one (otherwise the failed job says why each
provider was not used). A used-up budget refuses even a video estimated at $0.

Spend counts from when a budget is added, or last changed who it applies to,
what it covers, or when it resets; a new limit keeps what was spent. Every
workspace starts with one budget, for all video models at $25 a month, carrying
over the monthly video budget and this month's video spend it had before
budgets existed. A video started before budgets that later fails unbilled gives
its estimate back to that budget.

Budgets cap what videos cost; how many videos a day and how long they may be
are [video limits](#video-generation). Both are policies, set on the same tab.

Open the **Policies** tab of **Models** to see each budget, what it has spent
in the period now running, and when it resets, and below them the video
limits. Workspace admins choose **Add policy** and then **Budget** or **Video
limit**, and change, switch off, and delete policies in their lists; the form
says in one sentence what a policy will do before it is saved. Members see
them only. API tokens use
`budgets:read` and `budgets:edit`.

REST routes under `/v1/<workspace id>`: `GET /budgets` (each budget with its
`usage`: `period`, `spentUsd`, `resetsAt`); `POST /budgets`
(`{ appliesTo, covers, limitUsd, period, enabled? }`, where `appliesTo` is
`{ kind: "everyone" }` or `{ kind: "agents", agentIds }` and `covers` is
`{ kind: "all" | "llm" | "video" }` or
`{ kind: "llm-model" | "video-model", model }`); `PATCH /budgets/:id` (any of
those fields); and `DELETE /budgets/:id`. A workspace holds at most 50
budgets, and a budget names at most 100 agents. Budgets live in
`gateway_budget_policies` and their spend in `gateway_budget_usage`; without
MongoDB they last until restart.

### Routing

Open the **Routing** tab in **Models** to configure these features and send a
test request using **Auto**, a pool, or a specific model. The tester uses saved
settings and makes real provider calls. Add models and account connections in
the **LLM** tab first.

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

### Dashboard

Each workspace opens on its dashboard (`#/w/<workspace id>/dashboard`), which
has two tabs. Both refresh every 30 seconds while visible and keep the last
good answer, with a notice, when a refresh fails. The header names the
workspace and reports health: whether settings are saved to MongoDB, whether
usage history is being written, and whether web access is on.

**Overview** answers what needs you, what your agents are doing, and what it
costs:

- **Needs you** lists, most severe first, each with a link to where it is
  dealt with: model connections that failed at least half of their calls in
  the period (five or more), bots whose replies keep failing, proxy problems,
  a proxy budget at 80% or used up, your unread mentions, Synapse proposals
  to review, sites bots asked to fetch, bots at their hourly or daily limit,
  agent tokens that expire within 7 days, and for org owners and admins,
  expiring API tokens and the team's unused invite links. What only a
  workspace admin can act on is listed apart for members.
- **Totals** for the period: spend (models and proxies), model calls, agent
  replies by outcome, web fetches and the share that needed a proxy, and
  active agents.
- **Agents**, each with its status, its limits as meters, and its spend.
- **Spend by source** across model connections and proxies, with the proxy
  budget for the month; **Recent** failed replies, unread channels, changed
  shared notes, and decided proposals; and the activity chart.

It reads `GET /v1/:workspace/overview`, which answers what is waiting for
everyone and says in `can` what the signed-in person may act on. A section
whose store cannot be read (Synapse, channels, proxies, and so on) is named
in `unavailable` and shown as missing, not as empty; the rest still loads.
When usage covers only part of the period, or cannot be loaded, the Overview
says so instead of showing zeros. The sidebar reads the overview too, to
count the Synapse proposals and site requests the person can decide, and
**Workspaces** shows what needs you in each workspace, with team-wide items
such as invites listed once above the table.

**Usage** (`#/w/<workspace id>/dashboard/usage`) reports model calls, token
usage, estimated spending, active callers, success rates, and successful-call
latency. Choose a 24-hour, 7-day, 30-day, or 90-day window, filter by
connection/model/caller, inspect hourly or daily trends, sort and page the
model/caller tables, or export the filtered report as CSV. Below them, web
fetches are reported apart from model calls: totals, requests and cost by
connection, how fetches ended (blocked, needed JavaScript, and so on), the
sites fetched most (hosts only), and who fetched. A proxy step that was
skipped (a spent budget, a missing key) made no request and is not counted.
Fetches recorded before the gateway kept their outcome and cost are left out
and counted separately. Configuration, including failover, remains on the
Models page's LLM, Budget, and Routing tabs.

Calls include chat completions, decisions, routing selectors, and failed
fallback attempts; they are not a count of end-user requests. Caller attribution
uses the identity the gateway recorded: API token IDs (stable across token
rotation), team members, the owner credential, and agents (agent tokens,
OAuth apps, and the bots the gateway runs), which show by name and link to
their page. Unauthenticated history falls back to a client-reported `agentId`.
Calls without identity are shown as unattributed, not counted as unique users.
No credentials or prompts are stored in these analytics.

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
events from this process (model calls and web fetches together), independently
of the short recent-event feed. The
response and dashboard disclose memory coverage and durable-storage failures;
missing history is never silently presented as complete. Durable queries that
exceed 100,000 time/model/caller/operation groups also fall back with this notice.

## Deployment

The development configuration serves static dashboard assets at the edge and forwards API routes to a full Node gateway in Cloudflare Containers at <https://dev.autonomo.us>. OAuth, MCP, API paths and the existing MongoDB remain unchanged. A Cron Trigger wakes the container every minute for durable MCP delivery retries, independently of user traffic.

Deployment runs automatically through `deploy-development` on **every push to `main`, including PR merges**. Manual `workflow_dispatch` remains available, and the existing `development` environment protections still apply. Read [Cloudflare Containers deployment, migration and rollback](docs/CLOUDFLARE-CONTAINERS.md) before provisioning secrets or deploying. The retained `wrangler.legacy.jsonc` runs the previous Worker implementation, which intentionally does not advertise MCP Events.

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

`test:worker` starts the retained legacy entry in the actual Workers runtime and
requires MongoDB. It checks cold startup, both health endpoints, schema
validation, logging, automatic configuration creation, concurrent requests,
database writes, and failure recovery. It uses temporary databases and removes
them afterward. Set `MONGODB_TEST_URL` to use a different test MongoDB server.

Without a reachable MongoDB the integration suites skip with a warning;
everything else still runs. The default test URL is
`mongodb://autonomous:autonomous@localhost:27017/autonomous?authSource=admin`.

## License

MIT

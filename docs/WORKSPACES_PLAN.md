# Workspaces plan

*Status: proposal v0.1, November 2026. Owner: Jared Wray.*

Nothing in this document is code. It answers whether the gateway has workspaces
(it does not), proposes how to add them, and orders the work into reviewable
PRs. Each implementation PR is opened separately after the decisions in
[section 10](#10-decisions-needed) are made.

## Contents

1. [What exists today](#1-what-exists-today)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Concept model](#3-concept-model)
4. [Data model](#4-data-model)
5. [Request scoping architecture](#5-request-scoping-architecture)
6. [Authorization](#6-authorization)
7. [API surface](#7-api-surface)
8. [Dashboard](#8-dashboard)
9. [Migration, rollout, and rollback](#9-migration-rollout-and-rollback)
10. [Decisions needed](#10-decisions-needed)
11. [Security invariants](#11-security-invariants)
12. [Testing](#12-testing)
13. [PR sequence](#13-pr-sequence)
14. [Relationship to the MVP plan](#14-relationship-to-the-mvp-plan)
15. [Out of scope and follow-ups](#15-out-of-scope-and-follow-ups)

## 1. What exists today

There are no workspaces. A gateway deployment is one flat scope. The only
matches for "workspace" in the repository are the pnpm workspace and a Slack
workspace mentioned in the MVP plan.

| Area | Where it lives | Scope today |
| --- | --- | --- |
| Provider connections and API keys | `ProviderSettingsStore` → `gateway_providers` (`_id` = connection name); environment providers from `configFromEnv` | Gateway-wide. One `ProviderRegistry` singleton per process. |
| Routing (Auto, pools, rules, default failover) | `RoutingSettingsStore` → `gateway_routing` (`_id: "default"`); `FailoverPolicyStore`; `ModelRouter` balancing state | Gateway-wide singletons. |
| API tokens, agent tokens | `TokenStore` → `gateway_api_tokens`, `gateway_agent_tokens` | Gateway-wide grants (`models:read`, `inference:run`, …). |
| Telemetry and analytics | `TelemetryService` in-memory aggregates; `MongoTelemetrySink` → `telemetry_events` | Gateway-wide. Caller attribution by token or member id only. |
| Team | `AccountStore` → `gateway_users`, `gateway_invites`, `gateway_setup` | One team; roles `owner`, `admin`, `member` apply to everything. |
| Model catalog | `ModelCatalogService` | Public metadata; correctly gateway-wide. |

The closest existing ideas are named connections (several accounts for one
provider, e.g. `openai-work` and `openai-personal`) and the MVP plan's
`BusinessUnit` (`hyphen | oss | film | personal | platform`) for cost
attribution, which is not implemented.

Constraints from the codebase that shape this plan:

- **MongoDB is standalone** (compose runs `mongo:8` without a replica set) and
  no code uses transactions. Every invariant must hold with single-document
  atomicity and compare-and-swap on a `revision` field, the pattern
  `AccountStore` and `TokenStore` already use.
- **Settings are loaded once per process.** `ProviderSettingsStore` and
  `RoutingSettingsStore` guard loading with a `loaded` flag. On Workers, each
  isolate keeps its own copy, so a model added through one isolate (or one
  compose replica) is invisible to the others until they restart. This is a
  latent bug today; the cache design in [5.3](#53-workspace-runtime-cache)
  fixes it as a side effect.
- **Workers rules.** Routes compile at module start, database I/O is deferred
  to requests (`deferPersistence`), and Mongo clients are request-scoped
  through `requestMongoClient` and `withMongoRequestScope`.
- **Deny by default.** `registerApiAccess` maps exact routes to permissions and
  denies unlisted routes for tokens. Workspace scoping extends that table.

## 2. Goals and non-goals

Goals:

1. **Isolation inside one deployment.** A workspace owns its provider
   connections and credentials, routing, API and agent tokens, and telemetry.
   Nothing configured in one workspace is readable, routable, or billable from
   another.
2. **One identity per person.** Team accounts stay gateway-level. A person is
   granted access to specific workspaces with a workspace role.
3. **No breaking change for existing clients.** Every current API call, token,
   and dashboard bookmark keeps working against a `default` workspace that
   holds everything that exists today.
4. **A home for future MVP records.** Agents, routines, approvals, storage
   prefixes, and budgets get a `workspaceId` from their first PR instead of a
   retrofit.

Non-goals:

- Multi-tenant SaaS. A deployment is one organization with one set of owners;
  the design doc's non-goal stands. Workspaces partition one owner's
  businesses, the way workspaces work in the Anthropic Console or Portkey.
- Sharing a connection across workspaces (see
  [section 15](#15-out-of-scope-and-follow-ups)).
- Per-workspace budgets and rate limits (follow-up; the MVP cost meter is the
  natural place).
- Resource-scoped grants inside a workspace. That is the next phase of the
  [API token permissions plan](./API_TOKEN_PERMISSIONS_PLAN.md) and composes
  with this plan.

## 3. Concept model

```
Gateway deployment (the organization)
├── Team accounts           one identity per person; org role owner | admin | member
├── Model catalog           public metadata, shared
└── Workspaces
    ├── default             created by migration; holds everything that exists today
    │   ├── connections + credentials (environment providers seed only this one)
    │   ├── routing (Auto, pools, rules, default failover)
    │   ├── API tokens, agent tokens
    │   ├── telemetry
    │   └── memberships     account → workspace role admin | member
    └── hyphen, oss, film, …   same shape, start empty
```

| Instance-level | Workspace-level |
| --- | --- |
| Team accounts, sessions, password changes | Provider connections and credentials |
| Invites (an invite may carry a workspace membership) | Routing config, failover policy, pool balancing state |
| Workspace list and lifecycle | API tokens and agent tokens |
| Model catalog | Telemetry events, summaries, analytics |
| First-run setup | Workspace memberships |
| `/health` | Future: agents, routines, approvals, storage prefixes, budgets |

Every workspace-level record belongs to exactly one workspace, and a request
operates on exactly one workspace. There are no cross-workspace references.

## 4. Data model

### 4.1 Shared types (`@autonomo.us/common`, new `workspaces.ts`)

```ts
export const DEFAULT_WORKSPACE_ID = "default";

export const WORKSPACE_ROLES = { admin: "Admin", member: "Member" } as const;
export type WorkspaceRole = keyof typeof WORKSPACE_ROLES;

export type Workspace = {
	/** "default" for the migrated workspace, otherwise a UUID. Immutable. */
	id: string;
	/** Unique, URL-safe (^[a-z][a-z0-9-]{0,47}$), used in dashboard URLs. */
	slug: string;
	name: string;
	description: string;
	createdAt: string;
	createdBy: string | null;
	updatedAt: string;
	archivedAt: string | null;
};

export type WorkspaceMembership = { workspaceId: string; role: WorkspaceRole };

/** A workspace as one caller sees it. */
export type WorkspaceAccess = Workspace & {
	role: WorkspaceRole;
	/** True for org owners and admins, who are admins of every workspace. */
	implicit: boolean;
};
```

Additions to existing types:

| Type | Change |
| --- | --- |
| `TeamMember` | `workspaces: WorkspaceMembership[]` (empty for org owners and admins, whose access is implicit). |
| `CurrentSession` | `workspaces: WorkspaceAccess[]`, so the dashboard can render the switcher from one call. |
| `TeamInvite`, `CreateTeamInviteRequest`, `AddTeamMemberRequest` | Optional `workspace?: WorkspaceMembership`, granted when the account is created. |
| `ApiToken` | `workspaceId: string`, immutable after creation. |
| `TelemetryEvent` | `workspaceId?: string` (absent only on history recorded before this change). |

### 4.2 Collections

| Collection | Today | Change |
| --- | --- | --- |
| `gateway_workspaces` | — | New. `{ _id, slug, name, description, createdAt, createdBy, updatedAt, archivedAt, revision, configRevision }`. Unique index on `slug`. The `default` document is created with `$setOnInsert` upsert, the same way `RoutingSettingsStore` creates its default document, so concurrent startups agree. |
| `gateway_providers` | `_id` = connection name, `{ config }` | `_id: "<workspaceId>:<connection>"` plus a `workspaceId` field and an index on it. Connection names cannot contain `:`, so the key is unambiguous and `replaceOne(..., { upsert: true })` stays idempotent. Legacy documents move into `default` ([9.2](#92-backfills)). |
| `gateway_routing` | `_id: "default"` | `_id: <workspaceId>`. The default workspace's id is `"default"`, so the existing document is already correct and needs no migration. |
| `gateway_api_tokens`, `gateway_agent_tokens` | no workspace | `workspaceId` field and index. Legacy tokens are backfilled to `default`. The secret format (`aut_<id>_…`) is unchanged; `authenticate` already reads the record by id and gets `workspaceId` from it. |
| `telemetry_events` | no workspace | `workspaceId` on new events; index `{ workspaceId: 1, timestamp: 1, type: 1 }`. History is not rewritten: queries for `default` match `{ workspaceId: { $in: ["default", null] } }`, which also matches missing fields. |
| `gateway_users` | `role` | `workspaces: [{ workspaceId, role }]` and a multikey index on `workspaces.workspaceId` for member listings. Kept in the user document so session authentication stays one read. |
| `gateway_invites` | `role` | Optional `workspace: { workspaceId, role }`. |
| `gateway_migrations` | — | New. One marker document per completed backfill (`{ _id: "workspaces-v1", completedAt }`) so Worker isolates do not re-run backfills on every cold start. |
| `gateway_setup` | — | Unchanged. |

`configRevision` on the workspace document is the cache-coherence counter
described in [5.3](#53-workspace-runtime-cache). `revision` remains the
compare-and-swap counter for edits to the workspace document itself.

## 5. Request scoping architecture

### 5.1 Route scope table

Every `/v1` route declares one scope in a central table next to
`routePermissions` in `auth/access.ts`:

| Scope | Routes |
| --- | --- |
| `public` | `GET /v1/auth/status`, `POST /v1/auth/session`, `POST /v1/invites/preview`, `POST /v1/invites/accept` |
| `setup` | `POST /v1/setup`, `GET /v1/setup/token` |
| `instance` | `GET/DELETE /v1/auth/session`, `PUT /v1/auth/password`, `/v1/team*`, `/v1/workspaces` (list, create), `/v1/workspaces/:id` (rename, archive, unarchive), `GET /v1/models/catalog` |
| `workspace` | `/v1/models`, `/v1/providers`, `/v1/routing`, `/v1/failover`, `/v1/chat`, `/v1/decisions`, `/v1/telemetry/*`, `/v1/api-tokens*`, `/v1/agent-tokens*`, `/v1/workspaces/:id/members*` |

An `onRoute` hook throws at startup when a `/v1` route has no scope entry, so a
new endpoint cannot ship unscoped. This runs during route compilation, which is
allowed at Worker module start.

### 5.2 Workspace resolution

`registerApiAccess` gains one step after authentication, for `workspace`-scoped
routes only:

1. **API or agent token:** the workspace is the token's `workspaceId`. If the
   request also sends `X-Autonomous-Workspace` with a different id, reject with
   403 ("This token belongs to another workspace.") rather than ignore it, so a
   misconfigured client cannot believe it is writing somewhere it is not.
2. **Signed-in member:** the workspace is the `X-Autonomous-Workspace` header,
   or `default` when it is absent (keeps the current dashboard and scripts
   working during rollout).
3. Read the workspace document. This adds one indexed `_id` read per request,
   which is deliberate: like token revocation today, archiving must take effect
   on the next request on every replica.
4. Unknown workspace, or a member with no access to it → **404 "Workspace not
   found."** for both, so the API is not an oracle for workspace ids. Archived
   workspace (to a caller who has access) → 409 "This workspace is archived."
5. Set `request.workspace = { id, role, configRevision }`. Org owners and
   admins get role `admin` with `implicit: true`.

Handlers never read a workspace id from a request body or query string.

### 5.3 Workspace runtime cache

Today `createServer` builds one `ProviderRegistry`, `ProviderSettingsStore`,
`RoutingSettingsStore`, `FailoverPolicyStore`, and `ModelRouter`. These become
per-workspace:

```ts
type WorkspaceContext = {
	workspaceId: string;
	registry: ProviderRegistry;
	settings: ProviderSettingsStore; // reads/writes only this workspace's documents
	routing: RoutingSettingsStore; // gateway_routing document _id = workspaceId
	failover: FailoverPolicyStore;
	router: ModelRouter; // balancing state is per workspace
};

class WorkspaceRuntime {
	/** Bounded LRU keyed by workspace id; entries remember the configRevision they loaded. */
	get(workspace: { id: string; configRevision: number }): Promise<WorkspaceContext>;
}
```

- A `preHandler` on workspace-scoped routes sets
  `request.ctx = await runtime.get(request.workspace)`. Route plugins stop
  capturing singletons in their options and read `request.ctx` instead. This is
  the largest mechanical change (models, failover, routing, chat, decisions,
  telemetry routes).
- **Coherence.** Every provider or routing write increments the workspace's
  `configRevision` with `$inc` after the settings write is acknowledged. Each
  request already reads the workspace document, so a cached context whose
  revision differs is rebuilt on the next request on every replica and isolate.
  If the increment fails after the settings write succeeded, the write still
  stands; a 60-second maximum context age is the backstop. This replaces the
  load-once behavior that causes the staleness described in section 1.
- **Concurrency.** The cache stores the context promise, so concurrent first
  requests for one workspace share a single load. Writes stay serialized per
  store instance as they are today; two replicas writing the same workspace
  rely on the existing last-writer-wins semantics of `replaceOne`.
- **Memory.** The LRU is bounded (default 64 contexts). Evicting a context
  never breaks in-flight work: streams hold their own resolved models and
  release closures.
- **Environment providers** (`ANTHROPIC_API_KEY`, …, `OPENAI_COMPAT_*`) and
  `FAILOVER_*` seed the **default workspace only**. Other workspaces start with
  no connections and the default failover policy. This matches the existing
  rule that credentials are never inherited by a new connection.
- **Workers.** Per-workspace stores use `requestMongoClient` like the current
  ones, so their clients join the request scope that `withMongoRequestScope`
  closes. A request touches one workspace, so the client count per request does
  not grow with the number of workspaces.

### 5.4 Telemetry

- `recordChat` takes `workspaceId` and stamps it on the event.
- The pricing resolver currently closes over the global registry to find a
  connection's implementation kind. Chat, decisions, and the Auto selector
  already hold the resolved provider when they record (a selector whose
  decision model fails to resolve is unpriced anyway), so pass `provider.kind`
  in and make the resolver `(kind, model)`. It then needs no registry at all.
- In-memory aggregates (`recent`, `byModel`, `totals`) become a map of
  per-workspace partitions. The 50,000-event analytics ring stays shared and is
  filtered by `workspaceId` at query time; memory-mode coverage can then be
  reduced by another workspace's traffic, so `coverageFrom` and `partial` are
  computed per workspace. Memory mode is the no-Mongo fallback, so this is an
  acceptable trade.
- `MongoTelemetrySink.querySummary` and `queryAnalytics` take the workspace
  filter. The analytics `options` lists (models, connections, callers) come
  from the filtered data, so they never leak another workspace's names.

### 5.5 Health and initialization

`initialize()` (and `initializePersistence` in the Worker) becomes: ensure the
`default` workspace document, run pending backfills behind their
`gateway_migrations` markers, then warm the default workspace's context. The
`initialized` flag on `/healthz` keeps its meaning (saved settings for the
default workspace loaded, routing document present), so
`pnpm check:deployment` needs no change.

## 6. Authorization

Two layers, both required:

1. **Credential → workspace.** Section 5.2. A token is bound to one workspace;
   a member needs a membership (or an org owner/admin role).
2. **Action within the workspace.** Unchanged token permissions for tokens; the
   workspace role for members.

| Action | Org owner | Org admin | Workspace admin | Workspace member | Token in that workspace |
| --- | --- | --- | --- | --- | --- |
| Create, archive, unarchive a workspace | ✓ | ✓ | – | – | – |
| Rename or describe a workspace | ✓ | ✓ | ✓ | – | – |
| Add or remove workspace members (existing accounts) | ✓ | ✓ | ✓ | – | – |
| Create team accounts and invites | ✓ | ✓ (not owners) | – | – | – |
| Models and connections: read, add, update keys | ✓ | ✓ | ✓ | ✓ | `models:*` |
| Routing and failover: read, edit | ✓ | ✓ | ✓ | ✓ | `routing:*` |
| Chat, decisions, routing tester | ✓ | ✓ | ✓ | ✓ | `inference:run` |
| Telemetry | ✓ | ✓ | ✓ | ✓ | `telemetry:read` |
| API and agent tokens | ✓ | ✓ | ✓ | – | – |

Notes:

- Workspace members keep today's org Member semantics inside their workspaces
  (models, routing, dashboard; no tokens), so nobody gains or loses ability by
  migration.
- Org owners and admins are implicit admins everywhere. Because they always
  exist, there is no "last workspace admin" invariant to protect, and no
  owner-lock equivalent is needed for memberships.
- A workspace admin manages memberships of org `member` accounts only; org
  owners and admins are implicit and cannot be added or removed per workspace.
- An org `member` with no memberships can sign in and change their password,
  and sees an empty state asking an admin for access.
- Token management remains signed-in only: a token can never create or edit
  tokens, in any workspace.

## 7. API surface

New:

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /v1/workspaces` | Any signed-in member; tokens get their own workspace | Accessible workspaces with the caller's role. |
| `POST /v1/workspaces` | Org owner/admin | Create `{ name, slug?, description? }`. Slug defaults from the name; duplicates return 409. |
| `PATCH /v1/workspaces/:id` | Org owner/admin, workspace admin | Update `{ name, slug, description }` with compare-and-swap on `revision`. |
| `POST /v1/workspaces/:id/archive`, `POST /v1/workspaces/:id/unarchive` | Org owner/admin | Soft archive. `default` cannot be archived. |
| `GET /v1/workspaces/:id/members` | Workspace admin and above | Members with workspace roles, including implicit admins. |
| `PUT /v1/workspaces/:id/members/:userId` | Workspace admin and above | Set `{ role }` for an existing org member. |
| `DELETE /v1/workspaces/:id/members/:userId` | Workspace admin and above | Remove access. |

Changed:

- `GET /v1/auth/session` returns `workspaces: WorkspaceAccess[]`.
- `POST /v1/team`, `POST /v1/team/invites`, `POST /v1/invites/accept` accept and
  apply an optional `workspace` membership.
- Every workspace-scoped route accepts `X-Autonomous-Workspace`. Responses from
  those routes include the same header so clients and logs can confirm scope.
- Token list, create, roll, and revoke operate on the current workspace only.
  `workspaceId` is set from the request at creation and is not accepted in any
  body.
- `GET /v1/telemetry/*` and `GET /v1/providers` return only the current
  workspace's data.

Archive semantics: archiving sets `archivedAt`. Because every workspace-scoped
request reads the workspace document (5.2), all its tokens and sessions stop
working on the next request without touching token documents, which avoids a
non-atomic multi-document write on standalone MongoDB. An archived
workspace's provider credentials stay in `gateway_providers`, stored exactly as
they are today (plaintext server-side until the MVP vault lands). Purging an
archived workspace's data, credentials first, is a follow-up with its own
confirmation flow.

The `X-Autonomous-Workspace` header must be allowed by CORS. Set
`allowedHeaders` explicitly in the `@fastify/cors` registration
(`authorization`, `content-type`, `x-autonomous-workspace`) instead of relying
on reflection. The dashboard is same-origin in production and behind the Vite
proxy in development, so this only matters for third-party browser clients.

## 8. Dashboard

- **Switcher.** The top of the sidebar shows the current workspace name with a
  menu of accessible workspaces and, for org owners and admins, **Manage
  workspaces**. It collapses to an initial when the sidebar is collapsed.
- **URLs.** Workspace views move to `#/w/<slug>/<view>` (`dashboard`, `models`,
  `routing`, `api-tokens`, `agent-tokens`). `team`, `profile`, and
  `workspaces` stay instance-level (`#/team`). Legacy `#/models`-style
  fragments redirect to the last-used workspace (a `localStorage` convenience,
  wrapped in try/catch like the sidebar setting) or `default`. An unknown slug
  falls back the same way with a notice.
- **Requests.** `apiFetch` in `api.ts` sets `X-Autonomous-Workspace` from a
  module-level current workspace id that `App` sets on navigation.
- **No cross-workspace bleed.** Workspace views render with
  `key={workspace.id}`, so switching unmounts the old view; a response for the
  previous workspace cannot land in the new one.
- **Workspaces view** (org owners and admins): list with status, create,
  rename, archive and unarchive, and a members panel. Workspace admins see the
  members panel for their workspaces from the switcher menu.
- **Team view:** a workspaces column per member; **Invite member** and **Add
  member** gain an optional workspace and role.
- **Empty states:** a new workspace's Models view says it has no connections
  and that environment keys belong to the Default workspace. Token views name
  the workspace in their heading ("API tokens in Hyphen").
- **Single-workspace polish:** while only `default` exists, the switcher shows
  the name without a menu, so nothing changes visually for current users.

## 9. Migration, rollout, and rollback

### 9.1 Expand, then enable

The work ships in two halves:

1. **Expand (W1–W4).** Schema, scoping, runtime cache, token binding,
   telemetry partitioning, and memberships ship while only `default` can
   exist. Tests create extra workspaces through `WorkspaceStore` directly. The
   behavior visible to users is unchanged.
2. **Enable (W5–W6).** The lifecycle API and dashboard let people create a
   second workspace.

### 9.2 Backfills

Each runs once behind a `gateway_migrations` marker, is idempotent, and is safe
when several isolates run it at once:

| Backfill | Method |
| --- | --- |
| Default workspace | `findOneAndUpdate({ _id: "default" }, { $setOnInsert: … }, { upsert: true })`. |
| Provider documents | For each legacy document (`_id` without `:`): `updateOne({ _id: "default:<name>" }, { $setOnInsert: newDoc }, { upsert: true })`, then delete the legacy `_id`. `$setOnInsert` means a late migrator can never overwrite a newer write to the migrated document. For one release, reads also accept legacy-shaped documents as `default`, preferring the new shape on conflict, so a crash between insert and delete (or an old replica writing during a rolling deploy) cannot hide a connection. The legacy read path is removed in a later release. |
| Tokens | `updateMany({ workspaceId: { $exists: false } }, { $set: { workspaceId: "default" } })` on both token collections. Until the marker exists, `authenticate` treats a missing field as `default`. |
| Users | `updateMany({ role: "member", workspaces: { $exists: false } }, { $set: { workspaces: [{ workspaceId: "default", role: "member" }] } })`, so existing org members keep their current access. Owners and admins need nothing. Until the marker exists, a missing field on a member is read as default membership. |
| Routing | None: the `default` document already has the right `_id`. |
| Telemetry | None: query-time `$in: ["default", null]`. |

### 9.3 Rollback

- Rolling back within W1–W4 is safe: only `default` exists, and pre-workspace
  code reads migrated provider documents by `config.name`, ignores
  `workspaceId`, and finds the routing document where it always was.
- **Rolling back to pre-workspace code after a second workspace exists is not
  safe.** Old code loads every document in `gateway_providers` into one
  registry and authenticates every token with gateway-wide grants, which
  collapses isolation. Rolling back from W6 to W4 code is safe because W4 code
  is workspace-aware. The README will state this one-way door in the W5 PR.

## 10. Decisions needed

Positions are what the PR sequence assumes.

| # | Question | Position | Blocks |
| --- | --- | --- | --- |
| D1 | Is a workspace the business-unit boundary from the MVP plan (Hyphen, OSS, Film, Personal)? | **Yes.** The MVP's `BusinessUnit` enum becomes `workspaceId`, and the cost rollup "by business unit" becomes "by workspace." Confirm this does not conflict with the design doc's multi-tenancy non-goal (it is one organization). | W1 (naming), MVP PRs 4–15 |
| D2 | How does a signed-in member choose a workspace: header or path prefix (`/v1/w/:id/...`)? | **Header.** Routes, the permission table, and every token client stay unchanged; tokens imply their workspace anyway. A path prefix doubles the route surface during migration. | W1 |
| D3 | May workspace admins create and manage tokens? | **Yes, in their workspace.** A token is bound to the workspace, so the blast radius matches the admin's own access. | W3 |
| D4 | May workspace members add connections and change keys? | **Yes,** matching today's org Member. Tightening it is a separate change. | W4 |
| D5 | Do environment providers belong only to `default`? | **Yes.** Otherwise any workspace could spend the deployment's environment keys. | W2 |
| D6 | May workspace admins invite new people? | **No in v1.** Account creation stays with org owners and admins; workspace admins assign existing accounts. | W4 |
| D7 | Archive only, purge later? | **Yes.** Purge (credentials first) is a follow-up with explicit confirmation. | W5 |

## 11. Security invariants

Each is a test, not a review note:

1. A workspace-scoped handler cannot run without `request.workspace` and
   `request.ctx` set by the access hook; no handler reads a workspace id from a
   body or query string.
2. A token's `workspaceId` is fixed at creation; update and roll cannot change
   it, and a mismatching header returns 403.
3. No read path returns another workspace's data: models, connections,
   providers, routing, failover, tokens and their action logs, telemetry
   events, summaries, analytics option lists, or members.
4. Routing validation resolves every target (pool members, Auto targets and
   decision model, rules, failover) only against the workspace's own registry.
   Runtime failover cannot reach another workspace because the registry is per
   workspace.
5. An unknown workspace and an inaccessible one return identical 404s.
6. Environment credentials are reachable only from `default`.
7. Archiving blocks every token and session request to the workspace on the
   next request, on every replica.
8. Connection names are per workspace: `openai` in two workspaces is two
   credentials, and neither request ever reaches the other's provider.
9. Every `/v1` route has a declared scope; startup fails otherwise.

## 12. Testing

Following the repository's rule of real services, not mocks:

- **Isolation matrix** (`workspace-isolation.integration.test.ts`, real MongoDB
  and two `openai-stub` servers): workspaces A and B each have a connection
  named `openai` pointing at a different stub. Assert chat in A reaches only
  stub A; A's token with B's header gets 403; a member of A gets 404 for B;
  telemetry in A excludes B; a routing pool in A naming a model that exists
  only in B is rejected; archiving B blocks B's token on the next request.
- **Route-scope completeness:** start the server and assert every `/v1` route
  has a scope entry; a test-only unscoped route makes startup throw.
- **Migration:** seed pre-workspace documents (providers keyed by name, tokens
  and members without the new fields) into a unique test database, boot, and
  assert the backfills; boot again and assert nothing changes; simulate a crash
  between provider insert and delete and assert no connection disappears;
  assert a legacy token still authenticates in `default`.
- **Coherence:** two `createServer` instances on one database. Add a model in
  instance 1; instance 2 serves it on its next request without a restart. This
  is also a regression test for today's load-once staleness.
- **Worker runtime:** extend `pnpm test:worker` with requests to two
  workspaces in one isolate.
- **Dashboard:** `core/ux` tests boot the real server: the switcher sends the
  header, switching resets views, legacy fragments redirect, and a member with
  no memberships sees the empty state.

## 13. PR sequence

Each PR updates the README for the surface it changes, keeps `pnpm lint`,
`pnpm build`, and `pnpm test` green, and lists its acceptance criteria with
evidence in the description.

### W1: Workspace foundation (no behavior change)

- Common types; `WorkspaceStore` over `gateway_workspaces` with the `default`
  upsert; `gateway_migrations` markers.
- Route scope table, `onRoute` completeness check, and `request.workspace`
  resolution. Only `default` resolves; any other header value is 404.
- CORS `allowedHeaders`.

**Accept:** every existing suite passes untouched; completeness test; two
servers starting concurrently create one `default` document.

### W2: Workspace-scoped runtime

- `WorkspaceContext`, `WorkspaceRuntime` with `configRevision` coherence and
  LRU; route plugins read `request.ctx`.
- Provider documents keyed by workspace, with the backfill and the
  one-release legacy read path. Environment providers and `FAILOVER_*` seed
  `default` only. Pricing resolver takes the provider kind.

**Accept:** migration and coherence tests; existing chat, routing, failover,
and provider suites pass against `default`; a second workspace created through
the store starts empty.

### W3: Workspace-bound tokens and telemetry

- `workspaceId` on tokens with backfill, header-mismatch 403, token management
  scoped to the current workspace.
- `workspaceId` on telemetry events, the new index, sink query filters,
  per-workspace in-memory partitions, scoped analytics options.

**Accept:** the token and telemetry rows of the isolation matrix (using
store-created workspaces); legacy events count in `default`.

### W4: Memberships and workspace roles

- `workspaces` on user records with backfill; role resolution and the
  authorization matrix; memberships on invites and **Add member**;
  `GET /v1/auth/session` returns accessible workspaces; member management
  routes.

**Accept:** every row of the authorization matrix as a test; existing members
keep their access after migration; a member without memberships gets 404 on
workspace routes but can still sign in and change their password.

### W5: Workspace lifecycle API (the one-way door)

- `GET/POST /v1/workspaces`, `PATCH /v1/workspaces/:id`, archive and
  unarchive.
- README: workspaces section, endpoint list, and the rollback warning.

**Accept:** the full isolation matrix passes through public APIs only; slug
conflicts return 409; `default` cannot be archived.

### W6: Dashboard

- Switcher, `#/w/<slug>/…` routes and legacy redirects, header injection,
  Workspaces view, Team memberships, empty states.

**Accept:** the dashboard tests in section 12, plus screenshots in the PR.

```
W1 foundation ─► W2 runtime ─► W3 tokens + telemetry ─► W4 memberships ─► W5 lifecycle API ─► W6 dashboard
```

W3 and W4 touch different stores and can be developed in parallel after W2;
they merge in order.

## 14. Relationship to the MVP plan

- **Business units.** With D1, `Agent.businessUnit` becomes `workspaceId`, and
  `CostRollup.by: "businessUnit"` becomes `"workspace"`. Platform-wide costs
  (Captain, the gateway itself) belong to `default` or a dedicated `platform`
  workspace.
- **New MVP records** (agents, scope grants, routines, jobs, approvals,
  incidents, stored objects, budgets) carry `workspaceId` from their first PR,
  and their routes declare `workspace` scope in the table from W1. Storage
  prefixes become `${class}/${workspaceId}/${agentId}/`.
- **Agent tokens** are already workspace-bound after W3, which is what the
  future MCP server needs: an agent's `tools/list` and every tool call are
  evaluated inside its workspace.
- **Postgres.** The MVP plan proposes replacing MongoDB; the code still uses
  MongoDB, so this plan targets MongoDB. If Postgres lands, `workspace_id` is a
  column on every scoped table, part of every unique key (e.g.
  `(workspace_id, name)` for connections), and row-level security keyed by a
  per-request `SET LOCAL` is a natural second layer behind the access hook.

## 15. Out of scope and follow-ups

- Per-workspace budgets, spend limits, and rate limits.
- Organization-level shared connections (one provider key used by several
  workspaces), with explicit grants and per-workspace attribution.
- An "All workspaces" analytics view for org owners and admins.
- Purging an archived workspace.
- Workspace-scoped viewer role.
- Resource-scoped token grants within a workspace (API token permissions plan,
  next phase).
- Multi-organization tenancy.

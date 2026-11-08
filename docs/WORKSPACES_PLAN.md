# Workspaces plan

*Status: proposal v0.2, November 2026, revised after an independent architecture review ([section 16](#16-review-log)). Owner: Jared Wray.*

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
16. [Review log](#16-review-log)

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
  compose replica) is invisible to the others until they restart. Writes also
  merge from that in-memory copy (`addModel` reads `this.configs`;
  `updateFailover` reads the cached routing config), so two replicas writing at
  once can lose an update. These are latent bugs today; reading configuration
  per request ([5.3](#53-per-request-workspace-configuration)) fixes both.
- **Workers rules.** Routes compile at module start, database I/O is deferred
  to requests (`deferPersistence`), and Mongo clients are request-scoped
  through `requestMongoClient` and `withMongoRequestScope`. Each store keys its
  own request client, so every store a request touches opens its own
  connection, and Workers allow six simultaneous connections per request,
  including the outbound provider call.
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
| `gateway_workspaces` | — | New. `{ _id, slug, name, description, createdAt, createdBy, updatedAt, archivedAt, revision, actions }`. Unique index on `slug`; the slug is immutable in v1 so dashboard links never break. `actions` holds the latest 100 lifecycle and membership changes with actor and time, committed atomically with the change, like token `actions`. The `default` document is created with a `$setOnInsert` upsert, the same way `RoutingSettingsStore` creates its default document, so concurrent startups agree. Metadata edits use `$set` on named fields with a `revision` check, never a whole-document replace. |
| `gateway_providers` | `_id` = connection name, `{ config }` | Add a `workspaceId` field and an index on it. **`default` keeps its existing `_id` = connection name**; other workspaces use `_id: "<workspaceId>:<connection>"`. Saved connection names cannot contain `:`, so the two key spaces never collide, and no existing document is rewritten. |
| `gateway_routing` | `_id: "default"` | `_id: <workspaceId>`, plus a `revision` field for compare-and-swap (missing counts as 0). The default workspace's id is `"default"`, so the existing document is already correct. |
| `gateway_api_tokens`, `gateway_agent_tokens` | no workspace | `workspaceId` field and index, set on every new token. The secret format (`aut_<id>_…`) is unchanged; `authenticate` already reads the record by id and gets `workspaceId` from it. |
| `telemetry_events` | no workspace | `workspaceId` on new events; index `{ workspaceId: 1, timestamp: 1, type: 1 }`. History is not rewritten. |
| `gateway_users` | `role` | `workspaces: [{ workspaceId, role }]` and a multikey index on `workspaces.workspaceId` for member listings. Kept in the user document so session authentication stays one read. |
| `gateway_invites` | `role` | Optional `workspace: { workspaceId, role }`. |
| `gateway_setup` | — | Unchanged. |

**Permanent read rules instead of backfills.** A missing `workspaceId` on a
provider, token, or telemetry document means `default`, and a `member` account
with no `workspaces` field is a member of `default`. These are permanent read
rules, not pre-migration fallbacks, so a document written by an older replica
during a rolling deploy, or while rolled back, still resolves correctly. Every
write from new code sets the field explicitly. Every filter for `default`,
in reads and in writes, uses `{ workspaceId: { $in: ["default", null] } }`,
which also matches missing fields; filters for any other workspace use the
exact id. A write filter that used `workspaceId: "default"` alone would miss
every record saved before this change. No data is rewritten,
so there is no backfill to order, crash, or re-run.

**Indexes** (slug unique, `workspaceId` on providers, tokens, and telemetry,
the users multikey) are created by an `ensureIndexes` step in `initialize()`,
once per process or isolate, alongside the telemetry indexes created today.

## 5. Request scoping architecture

### 5.1 Route scope table

Every `/v1` route declares one scope in a central table next to
`routePermissions` in `auth/access.ts`:

| Scope | Routes |
| --- | --- |
| `public` | `GET /v1/auth/status`, `POST /v1/auth/session`, `POST /v1/invites/preview`, `POST /v1/invites/accept` |
| `setup` | `POST /v1/setup`, `GET /v1/setup/token` |
| `instance` | `GET/DELETE /v1/auth/session`, `PUT /v1/auth/password`, `/v1/team*`, `GET/POST /v1/workspaces` (list, create), `GET /v1/models/catalog` |
| `workspace` | `/v1/models`, `/v1/providers`, `/v1/routing`, `/v1/failover`, `/v1/chat`, `/v1/decisions`, `/v1/telemetry/*`, `/v1/api-tokens*`, `/v1/agent-tokens*` |
| `workspace-path` | `PATCH /v1/workspaces/:id`, `POST /v1/workspaces/:id/archive`, `POST /v1/workspaces/:id/unarchive`, `/v1/workspaces/:id/members*` |

`workspace-path` routes name their target workspace in the URL. For them the
`:id` path parameter, not the header, selects the workspace, and it goes
through the same resolution and role checks as the header does (5.2). A route
that names a workspace in its path is never classified `instance`, so no
handler can act on a path-named workspace without that resolution.

An `onRoute` hook throws at startup when a `/v1` route has no scope entry, so a
new endpoint cannot ship unscoped. This runs during route compilation, which is
allowed at Worker module start. Fastify registers a `HEAD` route for every
`GET`, so the check normalizes `HEAD` to `GET` exactly as `registerApiAccess`
already does.

`GET/POST /v1/workspaces` are signed-in only. A token's workspace is implied by
the token, so tokens get the existing 403 ("Sign in to the dashboard for this
action.") there.

### 5.2 Workspace resolution

`registerApiAccess` gains one step after authentication, for `workspace` and
`workspace-path` routes:

1. **API or agent token:** the workspace is the token's `workspaceId`. If the
   request also sends `X-Autonomous-Workspace` with a different id, reject with
   403 ("This token belongs to another workspace.") rather than ignore it, so a
   misconfigured client cannot believe it is writing somewhere it is not.
   `workspace-path` routes are signed-in only, so tokens get 403 there.
2. **Signed-in member, `workspace` route:** the workspace is the
   `X-Autonomous-Workspace` header, or `default` when it is absent (keeps the
   current dashboard and scripts working during rollout).
3. **Signed-in member, `workspace-path` route:** the workspace is
   `request.params.id` (Fastify has matched the route and parsed parameters
   before `onRequest`). If the header is also present and names a different
   workspace, reject with 400 rather than pick one, so a caller authorized for
   workspace A can never act on workspace B by sending header A with B in the
   path.
4. Read the workspace document. This adds one indexed `_id` read per request,
   which is deliberate: like token revocation today, archiving must take effect
   on the next request on every replica.
5. Unknown workspace, or a member with no access to it → **404 "Workspace not
   found."** for both, so the API is not an oracle for workspace ids. Archived
   workspace (to a caller who has access) → 409 "This workspace is archived.",
   except on `POST /v1/workspaces/:id/unarchive`, which must resolve an
   archived workspace.
6. Set `request.workspace = { id, role, implicit }`. Org owners and admins get
   role `admin` with `implicit: true`. The role matrix in
   [section 6](#6-authorization) is then checked against this resolved
   workspace, so a workspace admin can rename or manage members of only the
   workspaces they administer.

Handlers read the target workspace only from `request.workspace`: never from a
body or query string, and never from `request.params` directly.

**By-id operations carry the workspace filter.** Resolving the workspace is not
enough on its own: `TokenStore.read(id)` is `findOne({ _id })` today and backs
`update`, `roll`, and `revoke`, so scoping only the token list would leave
`PATCH /v1/api-tokens/:id` usable from workspace A against B's token id. Every
by-id read or write on a workspace-level collection filters on
`{ _id, workspaceId }` (with the default read rule from 4.2) and returns the
same 404 as a missing record on a miss. Membership routes look up the account
by id and act only on its entry for the resolved workspace.

### 5.3 Per-request workspace configuration

Today `createServer` builds one `ProviderRegistry`, `ProviderSettingsStore`,
`RoutingSettingsStore`, `FailoverPolicyStore`, and `ModelRouter`, and the two
stores load once per process. Workspace configuration is instead **read on
every request that needs it**. With MongoDB, nothing but pool balancing state
is kept between requests; without it, the in-memory storage described below is
kept too:

```ts
/** Built per request, memoized on the request, never shared across requests. */
type WorkspaceContext = {
	workspaceId: string;
	/** Saved connections for this workspace; for `default`, plus environment providers. */
	registry: ProviderRegistry;
	/** This workspace's routing document, including its default failover policy. */
	routing: RoutingConfig;
	/** Workspace-bound writers. */
	providers: ProviderSettingsStore;
	routingStore: RoutingSettingsStore;
	router: ModelRouter;
};
```

- **Loading.** A request helper `workspaceContext(request)` reads the
  workspace's provider documents and routing document and builds the registry.
  Only routes that need configuration call it (models, providers, routing,
  failover, chat, decisions); telemetry and token routes do not. Those reads can
  be issued concurrently with the workspace document read from 5.2, and nothing
  loaded is used until access is confirmed. For a token, the workspace is known
  only after the token read, so a chat request costs the token read, then one
  round trip for the workspace, provider, and routing reads together: the same
  number of round trips as a cached design that must read the workspace document
  anyway. Building a registry is cheap: provider factories are closures over a
  config.
- **Memory mode.** Without MongoDB, the provider and routing stores are the
  storage itself: today `addModel` and `RoutingSettingsStore.save` keep changes
  only in the store instances. The workspace-bound stores therefore read and
  write a process-wide in-memory backend keyed by workspace, the same pattern
  as the memory side of `AccountStore`'s `Documents`. That backend is never
  evicted or rebuilt, so a successful change lasts until the process restarts,
  as it does today. Only the derived registry and context are rebuilt per
  request.
- **Why not a cache.** A cache keyed by a revision counter on the workspace
  document saves two small reads per request but needs a load-tag ordering
  rule, invalidation on every write path, an LRU, and an age backstop, and it
  shares one load promise across requests, which on Workers runs on whichever
  request's scoped client started it. Per-request reads have none of those
  failure modes and also fix the cross-replica staleness from section 1. If
  measurement under `pnpm test:worker` shows the reads matter, a cache can be
  added later. It must then tag each entry with the revision read *before* its
  load starts, and every write must bump that counter with `$inc`.
- **Writes.** They no longer merge from process memory. Adding a model is a
  field-level update on the connection document (`$addToSet` on
  `config.models`, `$set` for a new key or Cloudflare account) filtered by
  `{ _id, workspaceId, "config.kind" }`, where for `default` the workspace
  clause is `{ $in: ["default", null] }` so connections saved before this
  change match. The update also sets `workspaceId`, and a zero matched count is
  a 404, never a silent in-memory success. Creating a connection is an insert,
  so a duplicate name returns 409 from the unique `_id`. Routing writes
  (`PUT /v1/routing`, `PUT /v1/failover`) read the document, then
  `replaceOne({ _id, revision })` and increment `revision`; a lost race returns
  409 "Routing changed during your request. Refresh and try again." This
  replaces today's per-process write queue, which cannot serialize writes
  across replicas.
- **Balancing state** is the one thing kept across requests. `ModelRouter`'s
  active-request counts and smooth-weighted scores move into a process-wide map
  keyed by workspace. Model ids are keyed `<workspaceId>|<connection/model>`,
  because `openai/gpt-x` in two workspaces is two credentials: shared counts
  would let one workspace's traffic steer another's least-requests choice. The
  map is bounded, and the existing pool-signature check already resets state
  when membership changes.
- **Environment providers** (`ANTHROPIC_API_KEY`, …, `OPENAI_COMPAT_*`) and
  `FAILOVER_*` seed the **default workspace only**, at the same precedence as
  today (a saved connection with the same name wins; `FAILOVER_*` seeds the
  default routing document when it is first created). Other workspaces start
  with no connections and the default failover policy, which matches the
  existing rule that credentials are never inherited by a new connection. The
  `registry` and `failover` options that tests pass to `createServer` play the
  same role: they become the `default` workspace's environment providers and
  seed policy, so existing suites keep working unchanged.
- **Workers connections.** Per-request reads mean more stores touch MongoDB in
  one request (account or token, workspace, providers, routing, telemetry),
  and each store keys its own request client today. With the provider call,
  that reaches the six-connection limit. All stores therefore share one
  request-scoped client (`requestMongoClient` keyed by a shared owner rather
  than by each store) with a small pool cap. This lands before per-request
  reads, in W2a, and `pnpm test:worker` asserts the connection count.
- **In-flight work.** A stream keeps the model it resolved. Removing a
  membership, demoting a member, or archiving the workspace stops new requests
  immediately and lets admitted requests finish, matching token revocation
  today.

### 5.4 Telemetry

- `recordChat` takes `workspaceId` and stamps it on the event.
- The pricing resolver currently closes over the global registry to find a
  connection's implementation kind. Chat, decisions, and the Auto selector
  already hold the resolved provider when they record (a selector whose
  decision model fails to resolve is unpriced anyway), so pass `provider.kind`
  in and make the resolver `(kind, model)`. It then needs no registry at all.
- In-memory aggregates (`recent`, `byModel`, `totals`) become a bounded map of
  per-workspace partitions (least recently used evicted first, default 64; an
  evicted partition's memory-only aggregates restart from zero and say so
  through `coverageFrom`). The 50,000-event analytics ring stays shared and is
  filtered by `workspaceId` at query time; memory-mode coverage can then be
  reduced by another workspace's traffic, so `coverageFrom` and `partial` are
  computed per workspace. Memory mode is the no-Mongo fallback, so this is an
  acceptable trade.
- `MongoTelemetrySink.querySummary` and `queryAnalytics` take the workspace
  filter. The analytics `options` lists (models, connections, callers) come
  from the filtered data, so they never leak another workspace's names.

### 5.5 Health and initialization

`initialize()` (and `initializePersistence` in the Worker) becomes: ensure
indexes, ensure the `default` workspace document and the `default` routing
document (both `$setOnInsert` upserts), and read the default workspace's
provider documents once to prove they load. The `initialized` flag on
`/healthz` keeps its meaning (saved settings for the default workspace
readable, routing document present), so `pnpm check:deployment` needs no
change. A per-request configuration read that fails returns 503, as chat does
today when routing cannot load.

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
- Org role changes keep stored memberships. Promoting a member to admin leaves
  their `workspaces` entries dormant (implicit access covers everything);
  demoting an admin to member restores exactly those entries. When a demotion
  would leave the account with no memberships, the Team view warns before
  saving, so a demotion is never a silent lockout.
- Token management remains signed-in only: a token can never create or edit
  tokens, in any workspace.

## 7. API surface

New:

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /v1/workspaces` | Any signed-in member (tokens get 403) | Accessible workspaces with the caller's role. |
| `POST /v1/workspaces` | Org owner/admin | Create `{ name, slug?, description? }`. Slug defaults from the name, is immutable afterwards, and duplicates return 409. |
| `PATCH /v1/workspaces/:id` | Org owner/admin, workspace admin | Update `{ name, description }` with `$set` and a `revision` check. |
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
  Streaming chat hijacks the reply and writes its own headers with
  `raw.writeHead`, bypassing hooks, so the header is added there next to the
  manual CORS header.
- Every workspace lifecycle and membership change is appended to the
  workspace's `actions` with the acting member, like token action logs.
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

1. **Expand (W1–W4).** Scoping, per-request configuration, token binding,
   telemetry partitioning, and memberships ship while only `default` can
   exist. Tests create extra workspaces through `WorkspaceStore` directly. The
   behavior visible to users is unchanged.
2. **Enable (W5–W6).** The lifecycle API and dashboard let people create a
   second workspace.

### 9.2 No backfills

Nothing existing is rewritten. The only write at upgrade is the `default`
workspace document, a `$setOnInsert` upsert that concurrent startups agree on.
Everything else relies on the permanent read rules in 4.2:

| Data | Upgrade behavior |
| --- | --- |
| Provider documents | Stay at `_id` = connection name, read as `default` while `workspaceId` is missing. New code sets the field on its writes; an older replica's `replaceOne` that drops it is still read as `default`. |
| Tokens | Read as `default` while `workspaceId` is missing; new tokens set it. A token created by an older replica during a rolling deploy keeps working. |
| Users | A `member` with no `workspaces` field is a member of `default`, so existing members keep their access, including members added by an older replica. Owners and admins need nothing. |
| Routing | The `default` document already has the right `_id`; a missing `revision` counts as 0. |
| Telemetry | Query-time `$in: ["default", null]`. |

This removes the failure modes a rewrite would bring: a crash between copying
and deleting a document, a late migrator overwriting a newer write, and an
older replica recreating a legacy document that a "prefer the new shape" rule
would then hide.

### 9.3 Rollback

- Rolling back within W1–W4 is safe in both directions. Only `default` exists.
  Pre-workspace code reads provider documents at their unchanged `_id` by
  `config.name`, ignores `workspaceId`, and finds the routing document where it
  always was. Writes made while rolled back drop the new fields, and the read
  rules treat them as `default` after upgrading again.
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
| D5 | Do environment providers belong only to `default`? | **Yes.** Otherwise any workspace could spend the deployment's environment keys. | W2b |
| D6 | May workspace admins invite new people? | **No in v1.** Account creation stays with org owners and admins; workspace admins assign existing accounts. | W4 |
| D7 | Archive only, purge later? | **Yes.** Purge (credentials first) is a follow-up with explicit confirmation. | W5 |

## 11. Security invariants

Each is a test, not a review note:

1. A workspace-scoped handler cannot run without `request.workspace` set by
   the access hook; no handler reads a workspace id from a body, query string,
   or path parameter directly.
2. A route that names a workspace in its path resolves and authorizes that
   workspace; a disagreeing header returns 400, and a workspace admin of A
   targeting B in the path gets 404.
3. A token's `workspaceId` is fixed at creation; update and roll cannot change
   it, and a mismatching header returns 403.
4. Every by-id operation on a workspace-level record filters on the resolved
   workspace: A's credentials naming B's token, connection, or member id get
   the same 404 as a missing record.
5. No read path returns another workspace's data: models, connections,
   providers, routing, failover, tokens and their action logs, telemetry
   events, summaries, analytics option lists, or members.
6. Routing validation resolves every target (pool members, Auto targets and
   decision model, rules, failover) only against the workspace's own registry.
   Runtime failover cannot reach another workspace because the registry is
   built per workspace.
7. Balancing state is keyed by workspace: one workspace's traffic never changes
   another's pool selection.
8. An unknown workspace and an inaccessible one return identical 404s.
9. Environment credentials are reachable only from `default`.
10. Archiving blocks every token and session request to the workspace on the
    next request, on every replica.
11. Connection names are per workspace: `openai` in two workspaces is two
    credentials, and neither request ever reaches the other's provider.
12. Every `/v1` route has a declared scope; startup fails otherwise.

## 12. Testing

Following the repository's rule of real services, not mocks:

- **Isolation matrix** (`workspace-isolation.integration.test.ts`, real MongoDB
  and two `openai-stub` servers): workspaces A and B each have a connection
  named `openai` pointing at a different stub. Assert chat in A reaches only
  stub A; A's token with B's header gets 403; A's token naming B's token id in
  `PATCH`, roll, and revoke gets 404; a member of A gets 404 for B; a workspace
  admin of A sending header A with B in the path of a member or rename route
  gets 400, and with only B in the path gets 404; telemetry and analytics
  options in A exclude B; a routing pool in A naming a model that exists only
  in B is rejected; a least-requests pool in A is unaffected by concurrent
  streams in B; archiving B blocks B's token on the next request.
- **Route-scope completeness:** start the server and assert every `/v1` route
  (with `HEAD` folded into `GET`) has a scope entry; a test-only unscoped route
  makes startup throw.
- **Upgrade from pre-workspace data:** seed documents in the current shape
  (providers keyed by name, tokens and members without the new fields, a
  routing document without `revision`) into a unique test database, boot, and
  assert they resolve as `default` with unchanged behavior and that no document
  was rewritten. Write a provider document the way old code does (whole-document
  `replaceOne` without `workspaceId`) and assert it still resolves as `default`.
  Add a model and rotate a key on a pre-workspace connection, then restart and
  assert both changes persisted.
- **Coherence and concurrent writes:** two `createServer` instances on one
  database. Add a model in instance 1; instance 2 serves it on its next request
  without a restart (a regression test for today's load-once staleness). Add
  two different models to one connection from both instances at once and
  assert both are saved. Race `PUT /v1/routing` against `PUT /v1/failover` and
  assert one wins and the other gets 409, never a silent merge.
- **Worker runtime:** extend `pnpm test:worker` with requests to two
  workspaces in one isolate, and assert a chat request stays within the
  per-request connection limit.
- **Dashboard:** `core/ux` tests boot the real server: the switcher sends the
  header, switching resets views, legacy fragments redirect, and a member with
  no memberships sees the empty state.

## 13. PR sequence

Each PR updates the README for the surface it changes, keeps `pnpm lint`,
`pnpm build`, and `pnpm test` green, and lists its acceptance criteria with
evidence in the description.

### W1: Workspace foundation (no behavior change)

- Common types; `WorkspaceStore` over `gateway_workspaces` with the `default`
  upsert, `actions`, and `ensureIndexes`.
- Route scope table with `HEAD` normalization, `onRoute` completeness check,
  and `request.workspace` resolution (header and path). Only `default`
  resolves; any other id is 404.
- CORS `allowedHeaders`; the response header, including on the streaming path.

**Accept:** every existing suite passes untouched; completeness test; two
servers starting concurrently create one `default` document.

### W2a: Per-request configuration (default only)

- One shared request-scoped MongoDB client for all stores, with a pool cap.
- `ProviderSettingsStore` and `RoutingSettingsStore` become workspace-bound
  readers and writers: per-request reads, field-level provider updates, and
  `revision` compare-and-swap on routing. `workspaceContext(request)`; route
  plugins read it instead of captured singletons. `ModelRouter` balancing state
  keyed by workspace. The `registry` and `failover` options of `createServer`
  become the `default` workspace's environment providers and seed policy.
- No schema change yet: everything is still `default`.

**Accept:** coherence and concurrent-write tests; the Worker connection-count
check; existing chat, routing, failover, provider, and dashboard suites pass
unchanged.

### W2b: Provider workspace keys

- `workspaceId` on provider writes, the default read rule,
  `<workspaceId>:<connection>` keys outside `default`, environment providers
  and `FAILOVER_*` seeding `default` only, pricing resolver by provider kind.

**Accept:** the upgrade test's provider rows; a second workspace created
through the store starts empty and cannot see environment providers; the
connection rows of the isolation matrix.

### W3: Workspace-bound tokens and telemetry

- `workspaceId` on tokens with the default read rule, by-id filters on
  `update`, `roll`, and `revoke`, header-mismatch 403, token management scoped
  to the current workspace.
- `workspaceId` on telemetry events, the new index, sink query filters,
  bounded per-workspace in-memory partitions, scoped analytics options.

**Accept:** the token and telemetry rows of the isolation matrix (using
store-created workspaces); pre-workspace tokens and events count in `default`.

### W4: Memberships and workspace roles

- `workspaces` on user records with the default read rule; role resolution and
  the authorization matrix; org role-change rules; memberships on invites and
  **Add member**; `GET /v1/auth/session` returns accessible workspaces; member
  management routes with `actions` entries.

**Accept:** every row of the authorization matrix as a test; existing members
keep their access with no data rewritten; a member without memberships gets 404
on workspace routes but can still sign in and change their password.

### W5: Workspace lifecycle API (the one-way door)

- `GET/POST /v1/workspaces`, `PATCH /v1/workspaces/:id`, archive and
  unarchive.
- README: workspaces section, endpoint list, and the rollback warning.

**Accept:** the full isolation matrix passes through public APIs only; slug
conflicts return 409; slugs cannot change; `default` cannot be archived.

### W6: Dashboard

- Switcher, `#/w/<slug>/…` routes and legacy redirects, header injection,
  Workspaces view, Team memberships and the demotion warning, empty states.

**Accept:** the dashboard tests in section 12, plus screenshots in the PR.

```
W1 foundation ─► W2a per-request config ─► W2b provider keys ─► W3 tokens + telemetry ─► W4 memberships ─► W5 lifecycle API ─► W6 dashboard
```

W2b, W3, and W4 touch different stores and can be developed in parallel after
W2a; they merge in order. W2a is also worth shipping on its own: it fixes the
existing cross-replica staleness and lost updates whether or not workspaces
follow.

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

## 16. Review log

The plan was reviewed independently against the code before implementation.
Findings and what changed:

| Finding | Source | Disposition |
| --- | --- | --- |
| Rewriting provider `_id`s loses writes from older replicas during a rolling deploy and after rollback | Architecture review, Codex (P2), Aikido (medium) | Fixed: `default` keeps its keys; only new workspaces use composite keys (4.2, 9.2). |
| Marker-gated read fallbacks lock out tokens and members created by older replicas | Architecture review, Codex (P2) | Fixed: missing fields mean `default` permanently; all backfills and `gateway_migrations` removed (4.2, 9.2). |
| Revision-tagged cache: tag-after-load race, whole-document `PATCH` writing back a stale counter, a shared load promise tied to one Workers request | Architecture review | Fixed by design change: configuration is read per request, with no cache (5.3). The ordering rules are recorded in case a cache is added later. |
| Writes merge from process memory, so concurrent replicas lose models or routing changes | Architecture review | Fixed: field-level provider updates and `revision` compare-and-swap on routing (5.3). |
| By-id token operations (`update`, `roll`, `revoke`) would cross workspaces if only lists were scoped | Architecture review | Fixed: by-id filter rule and invariant 4 (5.2, 11). |
| W2 too large to review | Architecture review | Split into W2a and W2b (13). |
| Path-named workspace routes were not bound to the authorized workspace; `PATCH /v1/workspaces/:id` skipped resolution | Aikido (two high findings) and architecture review | Fixed: `workspace-path` scope, path is authoritative, a disagreeing header gets 400 (5.1, 5.2, invariant 2). |
| `GET /v1/workspaces` for tokens contradicted the deny-unlisted rule | Architecture review | Fixed: signed-in only (5.1, 7). |
| Streaming chat bypasses response hooks | Architecture review | Fixed: header written beside the manual CORS header (7). |
| Balancing counts keyed by model id would mix workspaces | Found while revising | Fixed: keyed by workspace (5.3, invariant 7). |
| Per-request client per store exceeds the Workers connection limit | Architecture review | Fixed: one shared request client with a pool cap, in W2a (5.3). |
| Org promotion and demotion effects on memberships unspecified | Architecture review | Fixed: memberships kept; demotion warns when it would leave none (6). |
| `HEAD` routes in the completeness check; index creation; unbounded telemetry partitions; slug mutability; workspace audit trail | Architecture review | Fixed (5.1, 4.2, 5.4, 7). |
| Without MongoDB, rebuilding or evicting configuration would discard saved connections and routing | Codex (P2) | Fixed: a process-wide in-memory backend per workspace that is never evicted; only derived state is rebuilt per request (5.3). |
| Field-level writes filtered by `workspaceId` would miss `default` connections saved before the change | Aikido (medium) | Fixed: the `default` rule applies to write filters too, writes set the field, and a zero match is a 404 (4.2, 5.3, 12). |
| `OPENAI_COMPAT_NAME` is not validated, so an environment connection name could contain `:` | Architecture review | No change: environment connections are never persisted, so they never form a composite key. |

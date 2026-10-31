# API token permissions plan

Status: proposed. Token creation, metadata edits, rolling with overlap, revocation,
expiry enforcement, and the dashboard action log are implemented. Configurable
resource permissions are the next step.

## Current behavior

Tokens have a name, description, and TTL of 1, 7, 30, or 180 days, or Never.
Secrets are generated on the server, returned once, and stored only as SHA-256
digests. Listing tokens and their actions never returns digests or secrets.
MongoDB stores each token and its latest 100 lifecycle actions in one document,
so an acknowledged mutation always includes its audit entry. The dashboard
shows the latest 100 actions across tokens. Without MongoDB, these records last
only until the API restarts. This is a bounded management history, not a permanent
compliance log or a record of every inference request.

Rolling creates a new value and starts a new chosen TTL. The immediate previous
value remains valid for the chosen overlap (0 through 30 days), capped at its
original expiry. Older overlapping values keep their deadlines; another roll
never extends them. Expired values are never revived. At most 20 values can be
live for one token. Revocation invalidates all versions immediately for new
requests; already admitted requests and streams are allowed to finish. The
displayed status is active while any version is valid, and the displayed expiry
is the newest value's expiry. Each still-live previous value is listed separately.

With `OWNER_TOKEN` set, all `/v1/*` requests require bearer authentication.
The owner can administer the gateway. Managed tokens are limited to model
discovery and chat/decisions inference, including existing Auto and pool routes.
Without `OWNER_TOKEN`, the existing unauthenticated local-admin behavior remains;
removing an Authorization header then bypasses token checks. The dashboard
explicitly identifies this mode. Configure the owner credential before exposing
the gateway. `/health` and CORS preflight remain accessible without credentials.

## Resource + action + scope

Cloudflare groups token permissions by resource and separates Read and Edit;
access policies combine permissions with resource selections. Use that shape for
our grants, with an explicit Run permission for inference. References:
[Cloudflare permission groups](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
and [access policies](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/).

| Resource | Read | Edit | Other action | Scope |
| --- | --- | --- | --- | --- |
| Models / connections | List model and connection metadata; never credentials | Add/remove models and update connection credentials | — | Selected connection IDs, or all connections |
| Routing | Inspect Auto, pools, and failover | Change routing settings | — | Gateway initially; selected pools only after safe partial-update endpoints exist |
| Inference | — | — | Run chat or decisions | Selected model/pool IDs, or all inference targets |
| Telemetry | View usage and events | — | — | Gateway initially; per-token access requires attribution/filtering first |
| API Tokens | View metadata | Create, edit, roll, revoke | — | Own tokens; owner-only delegation initially |
| Token action log | Read lifecycle history | — | — | Same token scope as the caller's token access |

Edit includes Read and lifecycle changes for that resource. It never includes
Run, access to credential plaintext, or access to unrelated resources. Run can
incur inference costs and must be selected independently. A future Delete action
can be separated if needed; initially deleting resources is part of Edit.
Outbound tool actions, human approval, and the existing MVP's `send` policy are
separate checks: an API permission must never bypass those gates.

Represent grants as versioned structured data, not role-name strings:

```ts
type Grant = {
  resource: "models" | "routing" | "inference" | "telemetry" | "api_tokens" | "token_logs";
  action: "read" | "edit" | "run";
  scope: { kind: "all" } | { kind: "selected"; ids: string[] };
};
type TokenPolicy = { version: 1; grants: Grant[] };
```

Validate resource/action combinations against a server-owned catalog. Reject
unknown actions, unsupported scopes, empty selections, duplicate grants, and
unrecognized IDs. Do not derive permission names solely from HTTP verbs: POST
chat needs Run, while POST model needs Edit. No grant means deny. A grant applies
only when its resource, action, and scope all match. Multiple matching grants
are additive; defer exclusion rules until their precedence is specified.

## Dashboard experience

Add a Permissions area to Create/Edit token, with rows for Resource, Action, and
Scope. A scope picker offers All or Selected resources. Start with templates:
Gateway client (Models Read + Inference Run), Observer (Models/Routing/Telemetry
Read), and Routing editor (Models Read + Routing Edit). Templates expand to
visible grants and do not silently acquire new permissions as resources evolve.

Show the effective access summary before saving. Explicitly explain that Edit
includes Read, and that Run is separate. Keep full administration owner-only
initially. Do not ship inert checkboxes: launch the editor with server enforcement.

## Enforcement and delegation

1. Authenticate the credential and resolve a principal with stable token ID,
   owner ID, credential version, and effective grants. Keep the environment owner
   as a recovery/bootstrap credential, outside managed-token self-administration.
2. Attach required resource/action metadata to every `/v1` route. A shared
   authorization hook denies routes with no declared policy, except an explicit
   public allowlist. Return 401 for invalid/expired credentials and 403 for valid
   credentials lacking permission. Maintain the local mode only as an explicit
   development opt-out when migrating to enforced-by-default authentication.
3. Filter list responses and aggregates to allowed resources; authorize targeted
   reads and writes before touching provider credentials or making provider calls.
   Gateway-wide configuration replacements require gateway-wide Edit.
4. Evaluate inference scope on the requested alias and each actual selected
   model, decision model, pool member, and fallback. Auto and failover must not
   expand access. A scoped pool grant must either snapshot permitted members or
   require explicit grants on every member; choose the latter initially. Refuse
   a route that has no authorized target before making a billable call.
5. Rolling inherits the token's policy. Keep grants on the logical token record,
   so permission reductions and revocation apply to every overlapping version
   on the next request. Mongo-backed authorization reads already avoid stale
   process-local token caches; any later cache needs versioned invalidation.
6. Initially only the owner can create or edit grants. Before enabling delegated
   API Tokens Edit, prove the proposed grants/scopes/expiry are a subset of the
   caller's effective access. Never permit self-escalation, a longer delegated
   lifetime than the issuer's, or removal of the owner recovery path. Bind each
   delegated token to its issuer and define cascading revocation.

## Delivery and acceptance

1. Add a permission catalog, policy schema, token ownership, and a migration.
   Existing tokens get explicit Models Read + Inference Run grants matching their
   current behavior. Never interpret absent grants as administrator access.
2. Add route policies and authorization tests before exposing permission editing.
   Test every route/action pair, undeclared routes, filtered collections, Auto/
   pool/failover scope escape, and owner-only management.
3. Ship templates, resource selection, and effective-access summaries. Test
   creation, grant reduction, unauthorized edits, and retained policy on rolling.
4. Expand auditing to an append-only collection with retention/pagination,
   authenticated actor ID, target ID, request ID, outcome, and redacted policy
   before/after. Use a transaction or transactional outbox so policy changes
   cannot succeed without their audit record. Never record bearer values or
   authorization headers. Separate denied-request auditing from lifecycle logs
   and rate-limit it to prevent unbounded unauthenticated log writes.
5. Make enforced authentication the deployment default after an owner bootstrap
   and dashboard sign-in migration. Document recovery and rollback. Tests must
   prove read-only cannot mutate, Edit cannot Run, delegated grants cannot grow,
   all rolled credentials obey reductions, and Mongo outages fail closed.

Token lifecycle validation also covers TTL boundaries, Never, zero/custom
overlap, expiry caps, repeated rolls, revocation of every generation, concurrent
mutations, persistence across restart, and atomic audit/storage failures.

# Cloudflare Containers deployment

## Architecture and security

The development Worker keeps the same origin, static dashboard assets, SPA fallback, API routes, CORS and OAuth public URLs. API traffic now reaches the repository's full Node 26.13.1 Linux image through a Durable Object. Existing MongoDB data, sessions, bearer tokens, OAuth grants and collections remain in place. `PUBLIC_URL` is authoritative for HTTPS discovery even though internal container traffic is HTTP.

This uses the native `ctx.container` API, `scheduling_policy: durable_object`, a named digest-pinned image, and SQLite Durable Object exports. HTTP and cron target the fixed DO name `gateway-v1`. This is one routed instance, not autoscaling. Do not allocate a new name per request. Future pools must preserve shared MongoDB state and leases, bound connections, and test overlapping delivery. No application data or callback secrets live on ephemeral disk or in DO storage.

Cloudflare documents a full Linux VM with configurable Internet egress. The image uses `enableInternet: true` with **no outbound intercepts**. The existing Node HTTPS transport connects through a custom DNS `lookup` to the address validated by the callback guard, disables agent reuse, and retains TLS hostname verification through `servername`. The Worker never sends callbacks. HTTPS intercepts that forward with ordinary Worker fetch would change this security guarantee and must not be introduced. The retained Worker fetch transport still refuses MCP Events; its guard is unchanged.

This design is based on documented runtime behavior plus local transport tests. It is not proof of deployed Cloudflare networking. Verify address-pinned direct TLS egress in a synthetic staging deployment before claiming live compatibility.

Official documentation consulted 2026-11-16:

- [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/) — lifecycle, image selection, ports and inactivity timeout.
- [Scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/) — new durable-object policy versus deprecated default policy.
- [Outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/) — Internet access and explicit interception.
- [Cron example](https://developers.cloudflare.com/containers/examples/cron/) and [lifecycle example](https://developers.cloudflare.com/containers/examples/status-hooks/) — external wakeups and readiness.
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) — alarm wall-time and pending I/O keepalive.
- [Environment variables](https://developers.cloudflare.com/containers/configuration/environment-variables/) and [Wrangler configuration](https://developers.cloudflare.com/containers/configuration/wrangler/) — runtime settings and image build context.

## Durable retries and lifecycle

A Workers Cron Trigger calls the same DO every minute, independently of user traffic. It starts a sleeping/stopped container, waits for authenticated readiness at `GET /_internal/maintenance/ready` on the existing API listener (port 3000), then awaits bot/webhook recovery, a bounded MCP sweep, and all background work. All HTTP traffic uses one Fastify server and one port. Maintenance routes enforce a separate high-entropy token in constant time and reject every request marked as public ingress. Concurrent control sweeps coalesce.

Node post-message delivery still starts promptly. Container mode disables detached 30-second interval sweeps: mutating HTTP requests arm a durable alarm before forwarding and re-arm after response headers, and that alarm only drains already-running background work (including bot reply chains) through the maintenance routes before the DO can become inactive. Public GET/HEAD/OPTIONS requests do not arm alarms. Request drains perform no initialization or recovery scans; only cron scans persisted queues. A post-response alarm-write failure is logged without masking a committed API response, and cron remains the independent recovery path. The maintenance invocation allows up to 14 minutes within the platform's scheduled/alarm execution budget. A 45-second inactivity timeout permits sleep only after those invocations finish. Standalone Node keeps its existing interval sweeps. Missed ticks, cold starts, capacity and outages can delay work: there is no hard one-minute SLA. A failed cron invocation rejects with a sanitized error; subsequent ticks revisit persisted Mongo work. Monitor scheduled failures and queue age/attempt counts without exporting callback URLs, bodies or signing keys. A successful sweep does not mean all callbacks returned 2xx.

The control sweep attempts at most one queued event for each of up to 50 due subscriptions. The normal Node sweep can drain more. MongoDB CAS leases coordinate these and other replicas. After a crash, the 60-second lease expires and a later sweep retries the stable event ID/body. A callback might have accepted just before the crash, so delivery is at least once and receivers must deduplicate. Existing backoff, six-attempt limit, expiry, subscription authorization and revocation checks remain intact.

The existing enqueue hook is not a transactional outbox: messages whose hook fails before queue persistence cannot be recovered by this migration. MCP Events has no replay cursor. Reconcile with `channels_read` after interruptions; the existing queue limit and bounded deduplication window still apply. See [MCP Events](MCP-EVENTS.md).

The DO checks the running image digest and runtime-settings fingerprint. On a change it signals SIGTERM, waits up to 20 seconds, then forces termination if necessary. Node has a 15-second graceful-close deadline. Requests can see temporary 503s during replacement; the edge never retries application POSTs that might have committed. Secret changes replace the old process on its next invocation; raw settings are not stored or logged by the DO. Startup fails closed without MongoDB, HTTPS public origin and a control token. Readiness coalesces concurrent initialization, caches success for five seconds, and uses ten-second probes so successful database operations are not discarded by a shorter deadline. Public `/health` and `/healthz` retain their response contract.

## One listener, private maintenance routes

`start.ts` enables maintenance with `CONTAINER_CONTROL_TOKEN` in container mode;
other Node hosts can reuse `createServer({ maintenanceToken, backgroundTimers: false })`
with their own lifecycle/scheduler adapter. `maintenance-control.ts` depends on
Fastify and Node, not Cloudflare. Shared route/header constants are in
`maintenance-protocol.ts`. No second HTTP server or port 3001 remains.

| Method and path | Purpose |
| --- | --- |
| `GET /_internal/maintenance/ready` | Coalesced persistence readiness, five-second success cache |
| `POST /_internal/maintenance/sweep` | Coalesced bounded recovery scan followed by local background completion |
| `POST /_internal/maintenance/drain` | Coalesced wait for already-running local work; no initialization or recovery scan |

These endpoints are outside `/v1` and do **not** inherit user/API-token auth.
Their own `onRequest` guard runs before CORS and body parsing, requires the
control bearer token, and checks the exact raw URL and verb. Queries, suffixes,
encoded aliases and unsupported verbs are rejected. Responses are empty,
non-cacheable 204/404/503; errors and credentials are not returned. Routes are
absent unless maintenance is explicitly enabled. Shutdown closes the shared
listener and awaits maintenance work even if its caller already disconnected,
before closing MongoDB; the existing 15-second process deadline still applies.

The Cloudflare adapter rejects literal `/_internal` paths and forces
`x-autonomo-public-ingress: 1` on **every** forwarded public request, replacing
any caller-supplied value. Maintenance refuses the marker's presence even with
the correct control token. This second fence remains effective if URL decoding
or path normalization causes a request to match an internal route later.
Static-asset fallback never invokes a maintenance handler. The control token is
attached only to fixed, adapter-created maintenance requests, never to an
arbitrary public URL. Public API/OAuth authorization is forwarded unchanged.

Other clouds must keep the origin private and implement the same public-ingress
fence (or a stricter reserved-path denial) in every ingress path, including path
rewrites and encoded variants. Use private authenticated transport/TLS for
cross-host maintenance calls, inject the token from a secret manager, and never
put it in a URL or log. The header is a denial marker, not authentication; a
client cannot gain maintenance access by omitting it because the token is still
required. Do not expose the Node listener directly to the Internet. Public load
balancers should probe `/healthz`; trusted schedulers can use private readiness.

Deploy the edge adapter and its selected image together when moving from the
old two-port revision. Keep the existing token and MongoDB intact. Mixed old/new
adapters and images use incompatible control paths; replacement can briefly
return 503. Roll back the complete previous Worker/image revision together,
not just the port configuration. The edge never retries committed API writes.

## Scaling and portability limits

The current Cloudflare adapter still targets **one named Durable Object** and
one routed container. Multi-container operation is not claimed complete.
Readiness caching and sweep/drain coalescing are process-local, not distributed
locks. A drain only observes work owned by that process; a load-balanced drain
cannot keep another replica alive. A future adapter must address each replica
for lifecycle drains, provide external durable recovery scheduling despite
sleep/restart, and coordinate image/secret rollout and instance routing.

MongoDB is the cross-process authority: MCP subscription version CAS and
60-second leases, agent-webhook version CAS/leases, and bot-run conditional
claims prevent concurrent owners while leases are valid. A new synthetic CI
test starts separate Node sweepers against the same MongoDB, kills a holder,
checks that a live lease is respected, then races recovery after expiry and
checks the stable event ID. This is not a distributed deployment test. Existing
bot/webhook repository tests cover their conditional claims and stale owners.
No in-memory mutex replaces those leases, and the delivery/auth/SSRF code is
unchanged by the listener consolidation.

Leases are time-based; synchronize clocks and budget database/DNS/network time
below lease duration. A paused process or a crash after an accepted callback can
still cause duplicate effects: receiver deduplication remains mandatory.
Callback pinning, TLS verification, revocation checks, retries and the existing
non-transactional enqueue limitation remain unchanged. Before adding replicas,
validate failure/fencing behavior under real network partitions and stalls,
MongoDB connection/scan limits, queue fairness, shared settings/cache freshness,
and bot budgets (counts are not a globally transactional quota reservation).
Bound parallel recovery scans; coalescing here does not limit cluster-wide load.
Cross-cloud networking, scheduler identity, coordinated secret rotation,
per-replica drain/termination and production failover remain operator/design
work. Preserve direct address-pinned Node TLS egress on every platform; ordinary
fetch or an intercepting proxy cannot substitute for it.

## Node LTS support change

This revision drops Node 22/24 support. Only Node `>=26.13.1 <27` is supported,
including published packages and build tools; pnpm enforces the engine range.
The image pins the official Node 26.13.1 Alpine digest. Test, browser, release,
model-update and deploy workflows read `.nvmrc`. Corepack 0.36.0 is installed
explicitly because Node 26 no longer bundles it. Docker uses a SHA-256-verified
Corepack artifact in a shared base stage, without npm or lifecycle scripts; CI
and development setup retain Socket Firewall/Safe Chain. A current BuildKit
with `ADD --checksum` support is required. pnpm remains pinned in
`package.json` and the dependency lockfile is unchanged.

The active repository ruleset requires **`test (26)`**, `docker` and `zizmor`.
Retain these checks when changing deployment tooling. Upgrade host runtimes and reinstall/rebuild;
rebuild development and service images while preserving MongoDB volumes and
secrets. Old installations are not upgraded automatically. No database migration
is needed. For runtime rollback use the previous application/image revision;
the current source and its legacy Worker build tools require Node 26.

Sources: [Node 26.13.1 LTS security release](https://nodejs.org/en/blog/release/v26.13.1)
and [Corepack installation](https://github.com/nodejs/corepack#installation).

## Operator prerequisites and migration

`deploy-development` runs on pushes to `main` and on manual `workflow_dispatch`. **Merging this PR itself triggers the main-push deployment**, subject to the existing `development` environment protections. Later pushes deploy automatically too. Retain those protections. No live credentials belong in the AI workspace or Docker build arguments.

1. Use a Workers Paid account with Containers enabled, a Docker-capable runner, pinned Wrangler from the lockfile and the existing domain zone. The deployment token needs Containers/registry writes plus existing Worker script and domain/zone permissions. Verify the current permission labels in Cloudflare. Account capacity and permissions cannot be established by a dry-run.
2. Record the pre-migration Worker version/configuration and securely back up MongoDB. Preserve the exact database name and all existing data; do not run setup-clear or replace the database. Verify TLS, least-privilege read/write/index permissions and network access from Containers. Do not assume fixed container egress IPs or broadly expose the database to resolve connectivity.
3. Provision the existing Worker's `MONGODB_URI`, existing `SETUP_TOKEN`, and a new `CONTAINER_CONTROL_TOKEN` generated from 32 random bytes. Retain public URL, CORS, timezone and runtime provider/proxy settings. `container-environment.ts` explicitly lists forwarded settings. The existing runtime Workers AI `CLOUDFLARE_API_TOKEN` binding is retained; optional `CLOUDFLARE_AI_API_TOKEN` takes precedence. These are runtime Worker bindings, never the GitHub runner environment. Use a separate runtime Workers AI key, not the deployment credential. Mongo-stored provider settings remain unchanged. Changing Worker secrets is itself a live operation requiring authorization.
4. First use a separate staging Worker/domain/DO namespace with **synthetic MongoDB data** and a synthetic TLS callback. Check direct address pinning, invalid certificate/hostname rejection, callback retry, forced restart with a held lease, subscription refresh, revocation, and cron recovery without traffic. Do not use production MongoDB as a test fixture.
5. After review and environment approval where configured, a push/merge to `main` runs `deploy-development`; manual dispatch remains available. Wrangler builds from repository-root context and uploads the image, Worker and assets. The image selects user `node` (this is not a capability isolation boundary under the Cloudflare durable-object policy); the Docker context excludes environment files, credentials and tests. The workflow checks `/healthz` and MongoDB initialization. The same public origin preserves OAuth client compatibility.
6. Verify Cron Trigger installation/execution and Container status. Review credential-free Worker and Container logs and complete the acceptance checks below.

## Rollback

Keep the recorded pre-migration Worker version and `wrangler.legacy.jsonc`. After approval, roll back to that version (preferred for identical source/assets), or build and deploy the reviewed legacy configuration. The fallback keeps existing routes/data but intentionally does not advertise events.

Stop watches in ChatGPT or arrange an authorized Node delivery service using the same database before retiring the container path; otherwise queued callbacks may be delayed or expire. Disable the new Cron Trigger and verify old container instances are stopped. Do not assume a Worker rollback destroys running containers or removes DO namespaces. Retain the new namespace/application until recovery is settled; deletion is separate operator work. Do not clear subscriptions or restore a stale database over current writes. Already delivered callbacks cannot be recalled. Verify sessions, API tokens and OAuth after rollback.

## Validation and live acceptance

Local/CI checks: `pnpm lint`, `pnpm build`, `pnpm test:ci`, legacy `pnpm test:worker`, Wrangler dry-runs for both configs, `docker compose build server`, and security checks. CI supplies disposable MongoDB and Docker. Container boundary tests use mocked Cloudflare APIs and synthetic secrets. Existing integration tests use an independent local TLS receiver. A dry-run validates the configuration and bundle, not live account capacity or container networking.

After an approved deployment, collect credential-free evidence:

- Connected `/mcp` initialization advertises `capabilities.events`; authenticated `events/list` returns definitions.
- Dashboard sessions, existing API routes, OAuth discovery/authorization/token refresh and model streaming retain behavior on the same origin.
- ChatGPT's actual callback echoes the signed challenge and subscription succeeds with its supplied secret.
- A matching **#general** message produces an accepted signed event **and the intended dot actually wakes**. HTTP 2xx alone is insufficient.
- Nonmatching channel/thread/filter events do not wake it, and unsubscribe stops later deliveries.
- Sleep/restart with queued work recovers through cron without incoming HTTP; refresh works and duplicate delivery does not repeat actions.
- OAuth/token revocation or channel membership removal stops queued delivery. Invalid signatures and failed callbacks behave as specified.

Do not claim end-to-end success before those observations. Provisioning, deployed network validation and ChatGPT/dot wake testing remain operator acceptance work until performed.

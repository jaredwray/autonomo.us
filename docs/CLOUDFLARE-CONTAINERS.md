# Cloudflare Containers deployment

## Architecture and security

The development Worker keeps the same origin, static dashboard assets, SPA fallback, API routes, CORS and OAuth public URLs. API traffic now reaches the repository's full Node 22 Linux image through a Durable Object. Existing MongoDB data, sessions, bearer tokens, OAuth grants and collections remain in place. `PUBLIC_URL` is authoritative for HTTPS discovery even though internal container traffic is HTTP.

This uses the native `ctx.container` API, `scheduling_policy: durable_object`, a named digest-pinned image, and SQLite Durable Object exports. HTTP and cron target the fixed DO name `gateway-v1`. This is one routed instance, not autoscaling. Do not allocate a new name per request. Future pools must preserve shared MongoDB state and leases, bound connections, and test overlapping delivery. No application data or callback secrets live on ephemeral disk or in DO storage.

Cloudflare documents a full Linux VM with configurable Internet egress. The image uses `enableInternet: true` with **no outbound intercepts**. The existing Node HTTPS transport connects through a custom DNS `lookup` to the address validated by the callback guard, disables agent reuse, and retains TLS hostname verification through `servername`. The Worker never sends callbacks. HTTPS intercepts that forward with ordinary Worker fetch would change this security guarantee and must not be introduced. The retained Worker fetch transport still refuses MCP Events; its guard is unchanged.

This design is based on documented runtime behavior plus local transport tests. It is not proof of deployed Cloudflare networking. Verify address-pinned direct TLS egress in a synthetic staging deployment before claiming live compatibility.

Official documentation consulted 2026-11-16:

- [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/) — lifecycle, image selection, ports and inactivity timeout.
- [Scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/) — new durable-object policy versus deprecated default policy.
- [Outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/) — Internet access and explicit interception.
- [Cron example](https://developers.cloudflare.com/containers/examples/cron/) and [lifecycle example](https://developers.cloudflare.com/containers/examples/status-hooks/) — external wakeups and readiness.
- [Environment variables](https://developers.cloudflare.com/containers/configuration/environment-variables/) and [Wrangler configuration](https://developers.cloudflare.com/containers/configuration/wrangler/) — runtime settings and image build context.

## Durable retries and lifecycle

A Workers Cron Trigger calls the same DO every minute, independently of user traffic. It starts a sleeping/stopped container, waits for authenticated readiness on internal port 3001, then awaits a bounded MCP sweep. Public requests only reach port 3000; there is no public sweep route. The control port additionally checks a separate high-entropy token in constant time. Concurrent control sweeps coalesce.

Existing Node post-message delivery and 30-second timers improve latency while alive. They are not required to keep the service awake. A 45-second inactivity timeout permits sleep. Missed ticks, cold starts, capacity and outages can delay work: there is no hard one-minute SLA. A failed cron invocation rejects with a sanitized error; subsequent ticks revisit persisted Mongo work. Monitor scheduled failures and queue age/attempt counts without exporting callback URLs, bodies or signing keys. A successful sweep does not mean all callbacks returned 2xx.

The control sweep attempts at most one queued event for each of up to 50 due subscriptions. The normal Node sweep can drain more. MongoDB CAS leases coordinate these and other replicas. After a crash, the 60-second lease expires and a later sweep retries the stable event ID/body. A callback might have accepted just before the crash, so delivery is at least once and receivers must deduplicate. Existing backoff, six-attempt limit, expiry, subscription authorization and revocation checks remain intact.

The existing enqueue hook is not a transactional outbox: messages whose hook fails before queue persistence cannot be recovered by this migration. MCP Events has no replay cursor. Reconcile with `channels_read` after interruptions; the existing queue limit and bounded deduplication window still apply. See [MCP Events](MCP-EVENTS.md).

The DO checks the running image digest and runtime-settings fingerprint. On a change it signals SIGTERM, waits up to 20 seconds, then forces termination if necessary. Node has a 15-second graceful-close deadline. Requests can see temporary 503s during replacement; the edge never retries application POSTs that might have committed. Secret changes replace the old process on its next invocation; raw settings are not stored or logged by the DO. Startup fails closed without MongoDB, HTTPS public origin and a control token. Readiness rechecks durable initialization. Public `/health` and `/healthz` retain their response contract.

## Operator prerequisites and migration

Deployment is manual (`workflow_dispatch`); merging does not deploy. Retain GitHub environment approval protection. No live credentials belong in the AI workspace or Docker build arguments.

1. Use a Workers Paid account with Containers enabled, a Docker-capable runner, pinned Wrangler from the lockfile and the existing domain zone. The deployment token needs Containers/registry writes plus existing Worker script and domain/zone permissions. Verify the current permission labels in Cloudflare. Account capacity and permissions cannot be established by a dry-run.
2. Record the pre-migration Worker version/configuration and securely back up MongoDB. Preserve the exact database name and all existing data; do not run setup-clear or replace the database. Verify TLS, least-privilege read/write/index permissions and network access from Containers. Do not assume fixed container egress IPs or broadly expose the database to resolve connectivity.
3. Provision the existing Worker's `MONGODB_URI`, existing `SETUP_TOKEN`, and a new `CONTAINER_CONTROL_TOKEN` generated from 32 random bytes. Retain public URL, CORS, timezone and runtime provider/proxy settings. `container-environment.ts` explicitly lists forwarded settings. The existing runtime Workers AI `CLOUDFLARE_API_TOKEN` binding is retained; optional `CLOUDFLARE_AI_API_TOKEN` takes precedence. These are runtime Worker bindings, never the GitHub runner environment. Use a separate runtime Workers AI key, not the deployment credential. Mongo-stored provider settings remain unchanged. Changing Worker secrets is itself a live operation requiring authorization.
4. First use a separate staging Worker/domain/DO namespace with **synthetic MongoDB data** and a synthetic TLS callback. Check direct address pinning, invalid certificate/hostname rejection, callback retry, forced restart with a held lease, subscription refresh, revocation, and cron recovery without traffic. Do not use production MongoDB as a test fixture.
5. After approval, manually run `deploy-development` from the reviewed commit. Wrangler builds from repository-root context and uploads the image, Worker and assets. The image selects user `node` (this is not a capability isolation boundary under the Cloudflare durable-object policy); the Docker context excludes environment files, credentials and tests. The workflow checks `/healthz` and MongoDB initialization. The same public origin preserves OAuth client compatibility.
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

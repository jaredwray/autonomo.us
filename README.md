<div align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="media/logo-light.svg">
    <img alt="AUTONOMO.US" src="media/logo.svg" width="480">
  </picture>
</div>

# autonomo.us

AI platform for gateway, agents, and management.

## Packages

- **@autonomo.us/api** — Fastify AI gateway service
- **@autonomo.us/ux** — React + Vite management dashboard
- **@autonomo.us/common** — Shared types and utilities
- **@autonomo.us/logo** — Animated AUTONOMOUS aurora logo (framework-agnostic SVG)

## Getting Started

Run the whole platform with docker compose — API gateway, dashboard, ClickHouse, and MongoDB:

```bash
docker compose up --build
# Dashboard: http://localhost:8080  ·  API: http://localhost:3000
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
mode). Container startup launches MongoDB and ClickHouse with persistent
volumes. New terminals inherit the database URLs and credentials for the host-run
API. Start the API and UX using the development commands below; the dashboard
uses forwarded port 5173. Port 8080 is also forwarded for the full Compose stack.

For development on the host:

```bash
pnpm install
pnpm build
pnpm test
```

## Development

```bash
# Start the API server
pnpm --filter @autonomo.us/api dev

# Start the UX dashboard (proxies /v1 to the API on :3000)
pnpm --filter @autonomo.us/ux dev

# Lint
pnpm lint

# Lint and fix
pnpm lint:fix
```

## Gateway

The dashboard has a collapsible sidebar with **Dashboard**, **Models**,
**Routing**, and **API Tokens** views.
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

With `MONGODB_URL` configured, model settings and credentials are stored in the
`gateway_providers` collection and restored at startup. Saved provider settings
take precedence over environment settings for the same connection name. Protect this
database as a credential store: keys are stored server-side, are never returned
by management endpoints, and are not saved in browser storage. Without MongoDB,
the UI identifies changes as lasting only until the API restarts. If configured
MongoDB is unavailable, changes fail without activating an unsaved model.

The API service routes chat requests to LLM providers via the [Vercel AI SDK](https://ai-sdk.dev),
records token usage, and ships telemetry to ClickHouse. Providers are configured
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
| `CLICKHOUSE_URL` | Enables the ClickHouse telemetry sink (defaults match `docker-compose.yml`: database/user/password `autonomous`) |
| `CORS_ORIGIN` | Comma-separated browser origins allowed by CORS (default: the Vite dev dashboard on `localhost:5173`; set `*` to allow any) |
| `FAILOVER_ENABLED` | Seeds the failover policy switch (`true`/`1`; default off) — see [Failover](#failover) |
| `FAILOVER_TARGETS` | Comma-separated `provider/model` ids tried, in order, when a request fails |
| `FAILOVER_TIMEOUT_MS` | Per-attempt budget in ms before failing over (default `30000`; `0` disables the timeout) |

### Endpoints

- `GET /health` — API liveness (`status`, `timestamp`) plus `mongodb` and `clickhouse`, each containing `configured` and `connected`. Configured databases are actively probed with bounded timeouts; unavailable databases report `connected: false` while liveness remains HTTP 200. Set `MONGODB_URL` and `CLICKHOUSE_URL` to enable the respective checks.

- `GET /v1/api-tokens` — token metadata, latest 100 lifecycle actions, persistence and authentication mode; never returns secrets or hashes.
- `GET /v1/auth/owner` — verify owner access without reading MongoDB; returns 204. Managed API tokens cannot use this endpoint.
- `POST /v1/api-tokens` — create with `{ name, description, ttlDays, permissions? }`, where TTL is `1`, `7`, `30`, `180`, or `"never"`. Returns `{ token, secret }` once.
- `PATCH /v1/api-tokens/:id` — update `{ name, description, permissions? }`. Omitted permissions stay unchanged; `[]` removes all grants.
- `POST /v1/api-tokens/:id/roll` — issue a new secret with `{ ttlDays, previousTokenTtlSeconds }`. Overlap is 0–2592000 seconds (30 days), capped at the previous value's original expiry.
- `DELETE /v1/api-tokens/:id` — revoke the token and all overlapping values; retains its metadata and action history.

- `POST /v1/chat` — proxy a chat request; body `{ model, messages, stream?, temperature?, maxTokens? }` where `model` is `connection/model`, `auto`, or `pool/<id>`. Returns the assistant message plus `usage` token counts; with `stream: true` responds with SSE (`text-delta` events, then `finish` with usage).
- `GET /v1/models` — routable models and providers.
- `POST /v1/models` — add an active model; body `{ provider, connectionId?, createConnection?, model, apiKey?, accountId? }` (provider IDs: `google`, `xai`, `anthropic`, `openai`, `groq`, `mistral`, `deepseek`, `openrouter`, `cloudflare`, `typesafe`). Omit `connectionId` to use the default provider connection. Set `createConnection: true` to reject an existing name with HTTP 409. The key is required for a new connection and optional for subsequent additions to that connection. Repeated additions are idempotent; replies contain only the model ID and provider.
- `GET /v1/providers` — supported provider names, a `connections` list with IDs, provider kinds, key-configured flags and Cloudflare account IDs, and the settings persistence mode; never includes credentials.
- `GET /v1/models/catalog` — the full multi-provider model catalog (refreshed daily at runtime; bundled `models.json` as the fallback).
- `GET /v1/failover` — current failover policy.
- `PUT /v1/failover` — update the failover policy; body `{ enabled?, targets?, timeoutMs? }` (partial updates keep omitted fields).
- `GET /v1/routing` — routing `{ config, persistence }`, including Auto selection, pools, the default failover policy, and model/pool rules.
- `PUT /v1/routing` — replace the full routing configuration; returns `{ config, persistence }`. Invalid settings are rejected before activation.
- `GET /v1/telemetry/summary` — usage aggregates (ClickHouse when available, in-memory otherwise; `?source=memory|clickhouse` to force).
- `GET /v1/telemetry/events` — recent gateway events and sink status.
- `GET /health` — health check.

```bash
# Host-run API against the compose services
docker compose up -d clickhouse mongo
OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1 \
CLICKHOUSE_URL=http://localhost:8123 \
pnpm --filter @autonomo.us/api dev

curl -X POST http://localhost:3000/v1/chat \
  -H "content-type: application/json" \
  -d '{"model": "local/llama3.3", "messages": [{"role": "user", "content": "Hello"}]}'
```

### API tokens

Open **API Tokens** to create, edit, roll, or revoke gateway credentials. Each
token has a name, description, and a TTL of 1, 7, 30, or 180 days, or Never.
Creation and rolling show the secret once; copy it before leaving the page.
The server stores only its SHA-256 digest. MongoDB persists tokens and their
actions in `gateway_api_tokens`; without MongoDB they last until API restart.

Set `OWNER_TOKEN` on the API (also passed through Docker Compose) to require
`Authorization: Bearer <token>` on every `/v1/*` request. The dashboard prompts
for the owner credential and holds it only in tab memory. Reloading or selecting
**Lock dashboard** clears it. The owner can manage the gateway; generated tokens
receive the permissions chosen in Create/Edit token. `/health` stays public.
Without `OWNER_TOKEN`, the existing unauthenticated local mode remains enabled;
tokens do not protect the gateway from requests without credentials. The token
page displays this mode explicitly.

Permissions apply across the gateway for this initial version:

| Resource | Choices | Access |
| --- | --- | --- |
| Models | None, Read, Edit | Read lists models, the catalog, and provider connection metadata. Edit also adds models and changes connection credentials; secrets are never returned. |
| Routing | None, Read, Edit | Read inspects routing and failover. Edit also saves those settings. |
| Inference | None, Run | Run sends chat and decisions requests, including Auto, pools, and failover. |
| Telemetry | None, Read | Read views usage and events. |

Edit includes Read for that resource, but never Run. API token management and
action history remain owner-only. Requests without the required permission
return 403 before any provider call. There is no per-model or per-pool scope yet.

The API accepts permission IDs `models:read`, `models:edit`, `routing:read`,
`routing:edit`, `inference:run`, and `telemetry:read`. For example, an observer
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

### Jev decisions

Jev is a decision model, marked **Decisions** in Models and excluded from chat
failover. Add `typesafe/jev-latest` using a key from the
[TypeSafe console](https://console.typesafe.ai). The adapter calls the official
[System One API](https://docs.typesafe.ai/api/system-one).

`POST /v1/decisions` accepts native text or JSON state and named `noul`,
`choice`, or `score` questions. It returns the provider's model name, typed
answers (including confidence/probabilities), and usage. Requests time out after
30 seconds. Experimental image/Box inputs and long-context opt-ins are not yet
supported. Decisions contribute to gateway usage and telemetry.

```sh
curl http://localhost:3000/v1/decisions -H 'Content-Type: application/json' -d '{
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

The bundled `core/api/src/models.json` is the baseline the gateway serves
until the first successful refresh. The
[update-models](.github/workflows/update-models.yml) workflow runs the same
collection daily (using repo secrets for whichever provider keys are
configured) and uploads the refreshed catalog as a workflow artifact — it
does not commit back to the repo. Refresh the committed baseline locally
with:

```bash
pnpm --filter @autonomo.us/api models:update
```

To collect another provider, add a spec to `PROVIDERS` in
`core/api/src/model-catalog.ts` (and its key to the workflow env).

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

PUT this object to `/v1/routing`. Auto can choose the coding pool, distribute
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
`MONGODB_URL` is configured, otherwise in memory until restart. The legacy
`/v1/failover` endpoint and dashboard card update the same default policy and
persist it too. Saved policies override environment defaults on startup.
Writes must succeed before a policy becomes active. If routing settings cannot
be loaded at startup, chat requests return 503 until MongoDB is available;
the gateway does not silently bypass saved routing policies.

### Failover

The gateway can retry a failed chat request against other models. The policy —
on/off, an ordered list of fallback models, and a per-attempt timeout — lives
in the API and is configurable at runtime from the dashboard's **Failover
policy** card or directly over HTTP:

```bash
curl -X PUT http://localhost:3000/v1/failover \
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

The UX dashboard polls the telemetry endpoints and shows request/token/latency
totals, per-model usage, and recent gateway events.

## Testing

Tests run against real services, not mocks: chat routes talk to a real
OpenAI-compatible HTTP server over the production provider wire path, and the
telemetry suites run against a real ClickHouse (CI provides one as a service
container). Locally:

```bash
docker compose up -d clickhouse
CLICKHOUSE_USERNAME=autonomous CLICKHOUSE_PASSWORD=autonomous pnpm test
```

Without a reachable ClickHouse the integration suites skip with a warning;
everything else still runs.

## License

MIT

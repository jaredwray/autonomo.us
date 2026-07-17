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

The API service routes chat requests to LLM providers via the [Vercel AI SDK](https://ai-sdk.dev),
records token usage, and ships telemetry to ClickHouse. Providers are configured
through environment variables:

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Registers the `anthropic` provider (`ANTHROPIC_MODELS` overrides the advertised list) |
| `OPENAI_COMPAT_BASE_URL` | Registers an OpenAI-compatible provider — Ollama, LM Studio, vLLM, llama.cpp (`OPENAI_COMPAT_NAME` defaults to `local`, plus optional `OPENAI_COMPAT_API_KEY` / `OPENAI_COMPAT_MODELS`) |
| `CLICKHOUSE_URL` | Enables the ClickHouse telemetry sink (defaults match `docker-compose.yml`: database/user/password `autonomous`) |
| `CORS_ORIGIN` | Comma-separated browser origins allowed by CORS (default: the Vite dev dashboard on `localhost:5173`; set `*` to allow any) |

### Endpoints

- `POST /v1/chat` — proxy a chat request; body `{ model, messages, stream?, temperature?, maxTokens? }` where `model` is `provider/model` (e.g. `anthropic/claude-opus-4-8`, `local/llama3.3`). Returns the assistant message plus `usage` token counts; with `stream: true` responds with SSE (`text-delta` events, then `finish` with usage).
- `GET /v1/models` — routable models and providers.
- `GET /v1/telemetry/summary` — usage aggregates (ClickHouse when available, in-memory otherwise; `?source=memory|clickhouse` to force).
- `GET /v1/telemetry/events` — recent gateway events and sink status.
- `GET /health` — health check.

```bash
# Local example: Ollama + ClickHouse
docker compose up -d clickhouse
OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1 \
CLICKHOUSE_URL=http://localhost:8123 \
pnpm --filter @autonomo.us/api dev

curl -X POST http://localhost:3000/v1/chat \
  -H "content-type: application/json" \
  -d '{"model": "local/llama3.3", "messages": [{"role": "user", "content": "Hello"}]}'
```

The UX dashboard polls the telemetry endpoints and shows request/token/latency
totals, per-model usage, and recent gateway events.

## License

MIT

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

# Start the UX dashboard
pnpm --filter @autonomo.us/ux dev

# Lint
pnpm lint

# Lint and fix
pnpm lint:fix
```

## License

MIT

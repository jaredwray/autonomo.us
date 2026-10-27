# Build context is the repository root:
#   docker build -f core/api/Dockerfile .
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
RUN corepack enable
WORKDIR /repo

# Manifests first so dependency installation caches across source changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json ./
COPY core/api/package.json core/api/
COPY core/common/package.json core/common/
COPY core/logo/package.json core/logo/
COPY core/ux/package.json core/ux/
RUN pnpm install --frozen-lockfile --filter "@autonomo.us/api..."

COPY core/common core/common
COPY core/api core/api
RUN pnpm --filter @autonomo.us/common build && pnpm --filter @autonomo.us/api build

# Runtime: production dependencies only, plus the built output.
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/api/package.json core/api/
COPY core/common/package.json core/common/
COPY core/logo/package.json core/logo/
COPY core/ux/package.json core/ux/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@autonomo.us/api..."
COPY --from=build /repo/core/common/dist core/common/dist
COPY --from=build /repo/core/api/dist core/api/dist

ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "core/api/dist/start.mjs"]

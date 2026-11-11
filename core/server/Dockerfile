# Build context is the repository root:
#   docker build -f core/server/Dockerfile .
# One image runs the whole product: the Node process serves the API and the
# dashboard build (core/ux/dist).
FROM node:22.23.5-alpine@sha256:d6e6d1cae4ed0cda2dc336db1bbea6457c2b5d2a8bcd9ac1d80b909fe1c4f638 AS build
RUN corepack enable
WORKDIR /repo

# Manifests first so dependency installation caches across source changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json ./
COPY core/server/package.json core/server/
COPY core/common/package.json core/common/
COPY core/logo/package.json core/logo/
COPY core/ux/package.json core/ux/
RUN pnpm install --frozen-lockfile --filter "@autonomo.us/server..." --filter "@autonomo.us/ux..."

COPY core/common core/common
COPY core/server core/server
COPY core/ux core/ux
RUN pnpm --filter @autonomo.us/common build \
	&& pnpm --filter @autonomo.us/server build \
	&& pnpm --filter @autonomo.us/ux build

# Runtime: production dependencies only, plus the built output.
FROM node:22.23.5-alpine@sha256:d6e6d1cae4ed0cda2dc336db1bbea6457c2b5d2a8bcd9ac1d80b909fe1c4f638
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/server/package.json core/server/
COPY core/common/package.json core/common/
COPY core/logo/package.json core/logo/
COPY core/ux/package.json core/ux/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@autonomo.us/server..."
COPY --from=build /repo/core/common/dist core/common/dist
COPY --from=build /repo/core/server/dist core/server/dist
# start.mjs finds the dashboard here (override with DASHBOARD_DIR).
COPY --from=build /repo/core/ux/dist core/ux/dist

ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "core/server/dist/start.mjs"]

# Build context is the repository root:
#   docker build -f core/server/Dockerfile .
# One image runs the whole product: the Node process serves the API and the
# dashboard build (core/ux/dist).
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
# Corepack is no longer bundled with Node 26.
RUN npm install --global corepack@0.36.0 && corepack enable
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
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
# Corepack is no longer bundled with Node 26.
RUN npm install --global corepack@0.36.0 && corepack enable
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
USER node
EXPOSE 3000 3001
CMD ["node", "core/server/dist/start.mjs"]

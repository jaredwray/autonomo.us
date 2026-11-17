# Build context is the repository root:
#   docker build -f core/server/Dockerfile .
# One image runs the whole product: the Node process serves the API and the
# dashboard build (core/ux/dist).
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base
# Node 26 no longer bundles Corepack. Verify the exact artifact before extraction
# or execution; no npm install or lifecycle scripts run in this bootstrap.
ADD --checksum=sha256:9128cfe26aee0c99f4fc68c15c6b8b12309a68be0de2c012cdfea2a463cb722f https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz /tmp/corepack.tgz
RUN mkdir -p /usr/local/lib/node_modules/corepack \
	&& tar -xzf /tmp/corepack.tgz -C /usr/local/lib/node_modules/corepack --strip-components=1 \
	&& rm /tmp/corepack.tgz \
	&& ln -s /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
	&& corepack enable

FROM base AS build
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
FROM base
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
EXPOSE 3000
CMD ["node", "core/server/dist/start.mjs"]

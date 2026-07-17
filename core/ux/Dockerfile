# Build context is the repository root:
#   docker build -f core/ux/Dockerfile .
FROM node:22-alpine AS build
RUN npm install -g pnpm@10
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json ./
COPY core/api/package.json core/api/
COPY core/common/package.json core/common/
COPY core/logo/package.json core/logo/
COPY core/ux/package.json core/ux/
RUN pnpm install --frozen-lockfile --filter "@autonomo.us/ux..."

COPY core/common core/common
COPY core/ux core/ux
RUN pnpm --filter @autonomo.us/common build && pnpm --filter @autonomo.us/ux build

FROM nginx:alpine
COPY core/ux/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/core/ux/dist /usr/share/nginx/html
EXPOSE 80

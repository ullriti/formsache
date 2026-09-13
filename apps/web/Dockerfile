# syntax=docker/dockerfile:1
#
# Runtime image of the React frontend.
#
# The build context is the **workspace root**, like the API's:
#
#   docker build -f apps/web/Dockerfile .
#
# The result is a static bundle behind nginx. That nginx is not decoration —
# it is the front door that keeps browser and API on **one origin**: it serves
# the app and passes `/api` through unchanged, so the session cookie travels
# without CORS and without `SameSite=None` (ADR-0005, `app.module.ts`). TLS is
# terminated by whatever runs in front of it in production (Spec 0001 §4); this
# image speaks plain http on 8080.

ARG NODE_IMAGE=node:22.22.2-alpine3.22
# The unprivileged variant runs as uid 101 and listens on 8080 out of the box.
# The stock `nginx` image starts as root to bind port 80 and drops privileges
# for its workers only — its master process would keep uid 0, which is exactly
# what this image avoids by using the unprivileged variant.
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

# --------------------------------------------------------------------------
# build — Vite bundle
# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV COREPACK_HOME=/opt/corepack
WORKDIR /app

COPY package.json ./
RUN corepack enable && pnpm --version

# Every manifest, including the API's and the test provider's: the install layer
# has to see the same workspace graph the lockfile was resolved from. What a
# missing one really costs — a dangling symlink rather than the failed install
# the comment here used to claim — is measured and written down in
# `apps/api/Dockerfile`.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/test-idp/package.json packages/test-idp/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter=@formsache/web...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY tools tools
# The licence page imports this file with `?raw` and ships its text verbatim,
# because the fonts' licence requires it to be viewable by users and a retyped
# copy is a copy that drifts. Without this line the build resolves nothing and
# fails — which is exactly what happened the first time the page shipped, and
# only in the container: on a checkout the file is simply there.
COPY LICENSE ./

# `@formsache/shared` is consumed as the built ESM artifact here, not from source:
# `vite build` keeps the default export conditions (ADR-0007), so the package
# has to be built first or the bundle resolves nothing.
#
# `NODE_ENV` is deliberately not set. Vite derives the build mode from it, and
# a stray `development` produces a development React bundle — measured at
# 388 kB against 191 kB (`tools/env-file.ts`).
RUN pnpm --filter @formsache/shared build && pnpm --filter @formsache/web build

# --------------------------------------------------------------------------
# runtime — static files behind nginx
# --------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime

# Where this image forwards `/api`. A name, not a URL to a host: inside the
# compose network `api` resolves to the API container. nginx resolves it once
# at startup, so the API has to be up first — `docker-compose.yml` says so with
# a health condition rather than leaving it to luck.
ENV API_UPSTREAM=http://api:3000

# The image's entrypoint runs envsubst over everything in `templates/` before
# nginx starts, substituting *only* variables that exist in the environment —
# `$uri` and friends survive untouched.
COPY apps/web/docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080

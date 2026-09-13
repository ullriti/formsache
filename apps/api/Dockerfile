# syntax=docker/dockerfile:1
#
# Runtime image of the NestJS API.
#
# The build context is the **workspace root**, not `apps/api`: pnpm resolves
# `@formsache/shared` through the workspace, so a context that starts inside the app
# could not see the package it depends on.
#
#   docker build -f apps/api/Dockerfile --build-arg APP_VERSION=1.2.3 .
#
# Three stages, and the split is what keeps the runtime image small: `deps`
# installs, `build` compiles and prunes, `runtime` receives nothing but the
# pruned output. The `migrate` stage exists because the pruned output has no
# Prisma CLI — see its own comment.

# Pinned to a patch release: "node:22-alpine" would silently move the runtime
# under a rebuilt image, and the version the tests ran against is part of what
# a green pipeline claims. `engines` in package.json requires >= 22.12.
ARG NODE_IMAGE=node:22.22.2-alpine3.22

# --------------------------------------------------------------------------
# deps — dependencies only, so this layer survives every source change
# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ENV COREPACK_HOME=/opt/corepack
WORKDIR /app

# Corepack provides the pnpm version pinned in package.json (ADR-0006). The
# `--version` call warms the download *now*, as root and into a shared
# location — otherwise the first pnpm call of a later stage would fetch it
# again, and a non-root stage could not write the cache at all.
COPY package.json ./
RUN corepack enable && pnpm --version

# Manifests before sources: only these decide the dependency graph, so editing
# a controller does not invalidate the install layer.
#
# **All of them**, including `@formsache/web`, which this image never builds, and
# `@formsache/test-idp`, which it never runs — the latter is a devDependency of
# `@formsache/api` and `--prod` drops it again in the deploy stage below.
#
# The reason used to be stated as: a missing manifest reads as a workspace that
# was removed, and `--frozen-lockfile` fails as out of date. **Measured, that
# is not what happens.** `apps/api/package.json` gained a
# `workspace:*` dependency on `@formsache/test-idp`, whose manifest was not copied,
# and the install ran through — leaving `apps/api/node_modules/@formsache/test-idp`
# as a **dangling symlink** into a directory that is not in this image. An
# install that ends with a broken link is worse than one that fails, because
# nothing says so.
#
# So the rule stays „every manifest", with the honest reason behind it: the
# install layer has to see the same workspace graph the lockfile was resolved
# from, and one more manifest costs nothing but a line in the same cache layer.
# A manifest whose sources are never copied is deliberate — the package's *code*
# is test infrastructure and has no business in a runtime image; only its place
# in the graph does.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/test-idp/package.json packages/test-idp/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# `apps/api` runs `prisma generate` on postinstall, which needs the schema and
# the config that points at it. Both change rarely; keeping them in this layer
# is deliberate.
COPY apps/api/prisma/schema.prisma apps/api/prisma/
COPY apps/api/prisma.config.ts apps/api/

# `--frozen-lockfile` is the same guarantee CI gives: the image
# is built from the resolved graph in the lockfile or not at all. The filter
# leaves out `@formsache/web` — its toolchain has no business in this image, not even
# in a discarded build stage.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter=@formsache/api...

# --------------------------------------------------------------------------
# build — compile, then prune to what the runtime actually needs
# --------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @formsache/shared build && pnpm --filter @formsache/api build

# --------------------------------------------------------------------------
# deploy — the pruned tree the runtime image receives, and nothing else
# --------------------------------------------------------------------------
#
# **A stage of its own since Review-Runde 4 Nr. 2 („Image Size reduzieren").**
# `pnpm deploy` used to run inside `build`, and `migrate` is `FROM build` — so
# the one-shot migration image carried a full second copy of the deployed tree
# that it never runs. Ein eigener Zwischenschritt kostet nichts (BuildKit baut
# ihn ohnehin nur einmal) und nimmt dem `migrate`-Image genau diese Kopie.
FROM build AS deploy

# `pnpm deploy` writes a self-contained package tree: production dependencies
# only, workspace links resolved into real directories.
#
# `--legacy` is required by pnpm 10 for a workspace that does not inject its
# dependencies; without it the command refuses to run at all.
#
# The `prisma generate` afterwards is not redundant. The generated client is
# written *into the `@prisma/client` package* of the tree it was generated in,
# and `pnpm deploy` builds a fresh tree — so the deployed copy contains the
# stock package and the application dies at startup with "Cannot find module
# '.prisma/client/default'". Measured before this line existed. The CLI is
# taken from the build tree (`/app`), the output lands in the deploy tree
# because Prisma resolves the client relative to the schema it is pointed at.
RUN pnpm deploy --filter=@formsache/api --prod --legacy /out \
    && cd /out \
    && /app/apps/api/node_modules/.bin/prisma generate

# **Was ein laufender Node-Server dieser Anwendung nie anfasst**
# (Review-Runde 4 Nr. 2).
#
# Nichts davon ist geraten; jede Zeile hat einen nachgelesenen Grund, und der
# steht dabei. Wer eine Zeile ändert, prüft ihn nach — ein zu eifriges `rm`
# hier bricht den Start, und zwar erst im Container.
#
# 1. **Fremde Datenbanken.** Prisma 7 übersetzt Abfragen mit einem
#    WebAssembly-Compiler und liefert je einen für PostgreSQL, MySQL, SQLite,
#    SQL Server und CockroachDB mit — jeden noch einmal als `.mjs`. Diese
#    Installation spricht `provider = "postgresql"` (`schema.prisma`), und ein
#    MySQL-Compiler wird niemals nachgeladen: die Datei wird unter ihrem
#    festen Namen verlangt, nicht über ein Verzeichnis gesucht. Allein das
#    sind rund 35 MB.
# 2. **Der Edge-/Browser-Zweig des erzeugten Clients.** `index.js` — der
#    Einstieg, den die `node`-Bedingung der `exports` wählt — lädt
#    `query_compiler_fast_bg.wasm-base64.js`. Die rohe `.wasm` daneben lädt
#    ausschließlich `wasm-edge-light-loader.mjs` bzw. `wasm-worker-loader.mjs`,
#    und die erreicht man nur über die Bedingungen `edge-light`, `workerd` und
#    `worker`. In einem Node-Container gibt es keine davon.
# 3. **Typdeklarationen und Quellkarten.** `.d.ts`/`.d.mts` liest nur der
#    Übersetzer, `.map` nur ein Debugger mit Quelltext daneben — den es hier
#    nicht gibt. Allein `.prisma/client/index.d.ts` sind knapp 2 MB.
#
# ⚠️ **Lizenzdateien bleiben, ausnahmslos.** Sie sind der Grund, warum
# `/licences` existiert (ADR-0028 §10): die MIT-Lizenz verlangt, den fremden
# Copyright-Vermerk mitzuliefern. Ein `rm` auf `*.md` oder `LICENSE*` wäre
# hier gespart und dort ein Lizenzverstoß.
#
# Gesucht wird jeweils **unter `node_modules`** und über `-path`, nicht direkt
# im vermuteten Verzeichnis: ein `find` auf einen Pfad, den es nicht gibt,
# bricht ab und nähme eine Änderung an der Baumform von `pnpm deploy` als
# Baufehler mit. So löscht ein nicht mehr passendes Muster schlicht nichts.
#
# Die Zeile danach ist die Gegenprobe und der Grund, warum dieser Block
# überhaupt vertretbar ist: sie lädt den erzeugten Client genau so, wie der
# Server es beim Start tut. Ein zu eifriges Löschen scheitert damit **hier**,
# im Bau, statt später im Container.
RUN cd /out \
    && find node_modules -type f -path '*/@prisma/client/runtime/*' \
         \( -name 'query_compiler_*.mysql.*' \
         -o -name 'query_compiler_*.sqlite.*' \
         -o -name 'query_compiler_*.sqlserver.*' \
         -o -name 'query_compiler_*.cockroachdb.*' \) -delete \
    && find node_modules -type f -path '*/.prisma/client/*' \
         \( -name 'query_compiler_fast_bg.wasm' \
         -o -name 'wasm-edge-light-loader.mjs' \
         -o -name 'wasm-worker-loader.mjs' \
         -o -name 'index-browser.js' \) -delete \
    && find node_modules -type f \
         \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
         -o -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' \) -delete \
    && node -e "if (typeof require('@prisma/client').PrismaClient !== 'function') { throw new Error('Der erzeugte Prisma-Client laedt nicht mehr.'); }"

# --------------------------------------------------------------------------
# migrate — one-shot image for `prisma migrate deploy` and the development seed
# --------------------------------------------------------------------------
#
# Separate on purpose. `pnpm deploy --prod` drops the Prisma CLI (it is a dev
# dependency), so the runtime image cannot migrate — and it should not: an
# application container that migrates on start races with itself as soon as
# there is more than one of them. This stage reuses the `build` layers, so it
# costs no additional download for anyone who builds the API image anyway.
#
# ⚠️ **`FROM build` und nicht `FROM deploy`** (Review-Runde 4 Nr. 2): der
# `deploy`-Zweig hängt unter `build`, also erbt dieses Bild dessen Ebenen
# nicht. Genau das ist der Zweck — der ausgelieferte Baum unter `/out` hat in
# einem Bild, das nur `prisma migrate deploy` ausführt, nichts zu suchen.
# Umgekehrt braucht dieses Bild den vollen Baum: der Entwicklungs-Seed läuft
# über `@swc-node/register` auf `prisma/seed.ts`, und der ist Quelltext.
#
#   docker compose run --rm migrate                # migrate deploy (the CMD)
#   docker compose run --rm migrate db seed        # development seed
FROM build AS migrate
WORKDIR /app/apps/api
# The Prisma CLI is invoked through its module entry rather than through
# `pnpm exec`: pnpm's bin shims want a writable home, and this stage runs as
# `node`.
USER node
ENTRYPOINT ["node", "/app/apps/api/node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy"]

# --------------------------------------------------------------------------
# runtime — the image that ships
# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# The version GitVersion derived for this build. It reaches `GET /api/health`
# through the environment, so the running application answers with the same
# string the image is tagged with.
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=${APP_VERSION}

# **No `NODE_ENV` here.** It decides whether the session cookie is `Secure` and
# what it is called, so it is a required variable without a default
# (`docs/kb/04-build-run.md`). Baking `production` into the image would look
# tidy and would break every local `docker compose up` over http — silently, by
# handing out a cookie the browser then drops.

WORKDIR /app
# `node` (uid 1000) ships with the base image; the files belong to it so a
# future writable path does not need a second decision.
COPY --from=deploy --chown=node:node /out ./

# The upload directory of ADR-0014, created and handed over **before**
# `USER node` — and this order is the whole point rather than style.
#
# `docker-compose.yml` mounts a named volume here. Docker copies the ownership
# and content of the image's directory onto a *fresh* named volume, so a path
# that exists in the image and belongs to `node` produces a volume `node` can
# write to. A path that does **not** exist in the image produces a root-owned
# volume instead: every test stays green, the stack comes up healthy, and the
# first upload answers 500 because the process runs as `node`. That is the
# failure this line exists against.
#
# The value has to agree with `FILE_STORAGE_DIR` of the `api` service; it is
# not baked in as an `ENV` on purpose — the variable decides where personal
# attachments are written, and a default in the image would take that decision
# away from the deployment (ADR-0014 Nr. 2).
RUN mkdir -p /var/lib/formsache/files && chown -R node:node /var/lib/formsache

USER node

EXPOSE 3000
# `node dist/main.js`, not `pnpm start`: pnpm is not installed here, and a
# package manager between the init process and the server only buys an extra
# process that does not forward signals.
CMD ["node", "dist/main.js"]

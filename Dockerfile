# syntax=docker/dockerfile:1

# ---- manifests: the built-in modules' package.json files, and nothing else ----
# Each modules/<id> is a workspace package, so `pnpm install` needs its manifest. Copying the
# tree and deleting everything else keeps the install layer cached until a manifest changes,
# without a COPY line per module.
FROM --platform=$BUILDPLATFORM node:22-alpine AS manifests
WORKDIR /src
COPY modules modules
RUN find modules -type f ! -name package.json -delete

# ---- builder: install workspace deps and build the web bundle ----
# pnpm drives the workspace install + web build (vite). The server and
# @deck/schema run from TypeScript source under Bun at runtime, so there is
# nothing to compile for them here — only the web bundle is built.
# The builder always runs on the build machine's own platform, even for a cross-arch
# image: its output (the web bundle and pure-JS node_modules; the server runs from TS
# source under Bun) is architecture-independent at runtime, and running `pnpm install`
# under QEMU is slow and has crashed with "Illegal instruction". The only native modules
# it installs (lightningcss, esbuild) are build tools the runtime never loads.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable

# Manifests + lockfile first so `pnpm install` is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/package.json
COPY packages/module-sdk/package.json packages/module-sdk/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/drift/package.json packages/drift/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY examples/modules/hello/package.json examples/modules/hello/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY --from=manifests /src/modules modules
RUN pnpm install --frozen-lockfile

# Source, then build the web app to apps/web/dist.
COPY . .
RUN pnpm --filter @deck/web build

# ---- runtime: Bun serves the built dist + /api from one process ----
# The tag must match .bun-version, which CI installs; a server test fails if they differ.
FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DECK_CONFIG_DIR=/config \
    DECK_WEB_DIST=/app/apps/web/dist \
    DECK_PORT=8080

# Carry the fully installed + built workspace across. Keeping the same /app path
# preserves pnpm's node_modules/.pnpm symlink store so `@deck/schema` and the
# server's deps resolve unchanged under Bun.
COPY --from=builder /app /app

EXPOSE 8080

# Container is healthy while the API health endpoint answers (busybox wget is in
# the alpine base). Shell form so ${DECK_PORT} expands.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${DECK_PORT}/api/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]

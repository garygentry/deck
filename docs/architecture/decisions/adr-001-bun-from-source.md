# ADR-001: Run the server and schema from TypeScript source under Bun

- Status: accepted
- Date: 2026-09-20

## Context

Deck is a pnpm workspace with three packages: a schema library (`@deck/schema`), an HTTP server
(`@deck/server`), and a web app (`@deck/web`).
The web app is a Vite-built single-page application and must be compiled to static assets before it
can be served.
The server and the schema library are plain TypeScript.

The build tooling makes a deliberate asymmetry observable.
The workspace `build` script is `pnpm --filter @deck/web build` — it builds only the web app.
The server package declares no build script; it exposes its public entry directly as TypeScript
(`"exports": { ".": "./src/contract/index.ts" }`) and its `deck` bin points at
`./src/cli/deck.ts`.
The `dev` and `start` scripts run the server with `bun apps/server/src/server/boot.ts`, executing
the TypeScript entrypoint with no compile step in between.
The Dockerfile encodes the same split: the `node:22-alpine` builder installs the workspace and runs
only `pnpm --filter @deck/web build`, and the `oven/bun` runtime image serves the app by running
`boot.ts` under Bun.

## Decision

Run `@deck/server` and `@deck/schema` directly from their TypeScript source under the Bun runtime,
and compile only `@deck/web`.
There is no separate build, emit, or bundling step for the server or the schema library; Bun
executes their `.ts` files as-is at runtime, in development, in the container, and in the CLI.

## Consequences

The runtime toolchain is split by necessity: Bun is the server runtime, while Node and Vite are
build-time tools for the web bundle.
The container reflects this — a Node builder stage produces the web `dist`, and a Bun runtime stage
runs the source.
Because the same `/app` tree (including pnpm's symlinked module store) is carried across stages, the
server's and schema's dependencies resolve unchanged under Bun without a rebuild.

Skipping a server compile step removes a build artifact, a source-map concern, and a class of
build-vs-runtime drift; the source that is reviewed is the source that runs.
The cost is a hard coupling to a runtime that executes TypeScript: the server cannot be run under
plain Node without adding a compile or loader step, so Bun is a required part of the deployment, and
the deployable unit is the source tree rather than a compiled bundle.
Because the server exports TypeScript directly, its consumers within the workspace likewise operate
on source, and the CLI bin is a TypeScript file executed by Bun.

## Related

- [System context and containers](../context-and-containers.md)
- [Building-block view: engine subsystems](../building-blocks.md)

# deck

The human control plane for a home estate: one entry point for launch portal + service
status, inventory beside reality (drift), monitoring overview, docs and configs — with a slot
for governed actions and an LLM agent surface later. Generic engine, config-driven; an estate
repo projects its facts into deck's schema.

deck pairs with [`pulse`](https://github.com/garygentry/pulse) for monitoring. It was built
for, and is run against, one real home-lab estate; everything estate-specific lives in that
estate's own repo, never here.

## Quickstart

Requirements: [Bun](https://bun.sh) (server runtime), Node 22, and [pnpm](https://pnpm.io) 10.

```bash
pnpm install
pnpm dev        # API + web with hot reload; opens on http://127.0.0.1:5173
```

`pnpm dev` runs two processes via `concurrently`: the Bun API (`:8788`) against the
example estate in [`examples/estate/`](examples/estate/), and the Vite dev server, which
proxies `/api` to the API. If `5173` is taken, Vite moves to the next free port and prints
the URL.

The example estate ships with data on every surface out of the box — no network
required. Hosts, Services, and Drift are populated from a bundled snapshot, and the
Docs and Configs surfaces read from local example sources
([`examples/estate/docs/`](examples/estate/docs/) and
[`examples/estate/configs/`](examples/estate/configs/)). Because deck derives host
freshness from the wall clock, `pnpm dev`/`pnpm start` regenerate the snapshot with
now-relative timestamps (`pnpm snapshot:example`, from
[`examples/estate/snapshot.template.json`](examples/estate/snapshot.template.json)) into
the gitignored `examples/estate/.runtime/snapshot.json` before booting.

For a single-process production-style run (build the web app and let the server serve it):

```bash
pnpm start      # vite build, then Bun serves the app + /api on http://127.0.0.1:8080
```

Point deck at your own estate instead of the example, and override ports, with env vars:

| Var | Default | Purpose |
| --- | --- | --- |
| `DECK_CONFIG_DIR` | `examples/estate` | Directory of estate `*.yaml` config layers |
| `DECK_PORT` | `8788` (dev) / `8080` (start) | API / server port |
| `DECK_WEB_DIST` | _(unset)_ | When set, the server serves this built web dir (single-process) |
| `DECK_SNAPSHOT_SOURCE` | `examples/estate/.runtime/snapshot.json` | Observed-reality snapshot: a file path or `http(s)` URL. Feeds Hosts/Services/Drift |
| `DECK_PROXY_TARGET` | `http://127.0.0.1:8788` | Vite dev proxy target (set when the API runs on a non-default port) |

Validate or render an estate config directly with the CLI:

```bash
bun apps/server/src/cli/deck.ts validate examples/estate
bun apps/server/src/cli/deck.ts render   examples/estate --out rendered.json
```

Documentation lives under [`docs/`](docs/), organized by reader need:

- **Get started:** [`docs/get-started.md`](docs/get-started.md) — clone to a running deck on the example estate
- **How-to guides:** [`docs/guides/`](docs/guides/) — configure your estate, connect monitoring, serve docs & configs, governed actions, produce a snapshot, deploy, private-repo sources, LLM plan usage, build a dashboard without code, customise the UI
- **Extending deck:** write a [sidecar](docs/guides/write-a-sidecar-module.md), a [module](docs/guides/write-a-module.md) or a [runtime module](docs/guides/runtime-modules.md); start from [Kernel and modules](docs/explanation/kernel-and-modules.md) to choose
- **Reference:** [`docs/reference/`](docs/reference/) — estate config, snapshot contract, provider kinds, environment variables, CLI, HTTP API, module manifest, widget types, remote provider protocol
- **Explanation:** [`docs/explanation/`](docs/explanation/) — engine vs. estate, drift & coverage, kernel & modules; plus [`docs/security.md`](docs/security.md) (access model)
- **Architecture:** [`docs/architecture/`](docs/architecture/) — context & containers, building blocks, deployment view, per-feature notes, and [decisions](docs/architecture/decisions/)
- **Changelog:** [`CHANGELOG.md`](CHANGELOG.md) — release history

## License

[MIT](LICENSE)

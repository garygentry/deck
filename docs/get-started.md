# Get started with deck

This tutorial takes you from a fresh checkout to a running deck showing live data on every
inventory surface.
You use the estate that ships with the repository, so everything works with no network and no
configuration of your own.
By the end you will have deck running locally and will have toured the portal, hosts,
services, drift, and the docs and configs surfaces, all populated from the example estate.

## Prerequisites

Install these exact tools before you start:

- [Bun](https://bun.sh) — the runtime that runs the deck server.
- Node.js 22.
- [pnpm](https://pnpm.io) 10 — the package manager for the workspace.

Confirm each one is on your path:

```bash
bun --version
node --version
pnpm --version
```

You also need a local checkout of the deck repository.
Run every command in this tutorial from the root of that checkout.

## Install and run

Install the workspace dependencies:

```bash
pnpm install
```

Start deck in development mode:

```bash
pnpm dev
```

This one command does three things: it regenerates the example snapshot with fresh
timestamps, starts the Bun API against the example estate on port 8788, and starts the Vite
web server that proxies the API.
When it is ready, the terminal prints the web address.

Open it in your browser:

```text
http://127.0.0.1:5173
```

If port 5173 is already in use, Vite moves to the next free port and prints that URL instead —
open whichever address the terminal shows.
Leave `pnpm dev` running while you work through the rest of this tutorial.

## Tour the surfaces

deck loads with the **Portal** at the root path.
You see two groups, Overview and Infrastructure, holding service tiles such as Portal, Files,
and Jellyfin, plus plain links like Gateway.
This layout comes straight from the example estate.

Open **Hosts** from the navigation.
Five hosts appear — gateway, nas, apps, media, and sensor — each with its kind, purpose, and
addresses.
Select a host to see its detail page.

Open **Services**.
Six services appear — portal, reverse-proxy, files, backups, router-ui, and jellyfin — each
tied to the host it runs on.

Open **Drift**.
This surface puts your declared inventory beside the observed snapshot and reports the
difference.
The example is stamped so that most hosts read as freshly collected, the `nas` host reads as
stale because its observation is older than the estate's freshness window, and the `sensor`
host reads as never collected because the snapshot omits it.
This gives you every coverage state on one screen.

Open **Docs**.
The Runbooks source renders the Markdown files bundled in the example estate, read-only.

Open **Configs**.
The Host configs source browses the example config files, again read-only.

Open **Monitoring**.
The surface loads, but it shows no monitoring backends: the example estate declares no
integrations, so there is nothing to poll yet.
Connecting a real monitoring backend is a separate task — see
[Connect monitoring and alerts](guides/connect-monitoring.md).

## Where the data came from

Everything you just toured came from the example estate in
[`examples/estate/`](../examples/estate/): the inventory and portal layout are declared in the
YAML layers `00-base.yaml` and `10-overlay.yaml`, while the observed data on Hosts, Services,
and Drift comes from a snapshot that `pnpm dev` regenerates from
`examples/estate/snapshot.template.json` into `examples/estate/.runtime/snapshot.json`.
To build an estate of your own, continue with
[Configure your estate](guides/configure-your-estate.md) and
[Produce and refresh a snapshot](guides/produce-a-snapshot.md).

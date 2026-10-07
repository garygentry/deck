# Configure your estate

This guide walks you through authoring your own estate config: the hosts and services in your
lab, how they lay out on the portal, and how to split stable inventory from presentation.
It assumes you are comfortable with YAML and a terminal.
For the full description of every key, see
[Estate configuration reference](../reference/estate-config.md).

## Set up the config directory and layers

An estate is a directory of `*.yaml` files, not a single file.
deck loads every `.yaml` or `.yml` file in the directory, sorts them by filename, and merges
them in that order.
Use zero-padded numeric prefixes so the order is deterministic; the convention is a base layer
`00-base.yaml` followed by overlays such as `10-overlay.yaml`.

Create the directory and a base layer:

```bash
mkdir -p my-estate
```

```yaml
# my-estate/00-base.yaml
schemaVersion: 1
estate:
  name: my-estate
```

Every layer must start with the same `schemaVersion`, and all layers must agree on it.

Put stable identity and topology in the base layer, and put presentation and cross-cutting
data in overlays.
The base layer owns what exists — estate identity, hosts, and services — and an overlay
cannot override those facts.
Overlays own the portal `groups`, per-host and per-service `links`, and the `sources`,
`integrations`, and `actions` sections.

deck finds the config directory in this order: the `--config` flag, then the
`DECK_CONFIG_DIR` environment variable, then `./config`.
Point deck at your estate by setting the environment variable:

```bash
export DECK_CONFIG_DIR=/path/to/my-estate
```

## Declare hosts and services

Add your machines under `hosts`.
Each host requires `name`, `kind`, and `purpose`:

```yaml
# my-estate/00-base.yaml (continued)
hosts:
  - name: nas
    kind: bare-metal
    purpose: Storage and backup target
    addresses:
      - { network: lan, address: 192.0.2.10, primary: true }
    access: { reachable: true, method: ssh, port: 22, user: admin }
  - name: apps
    kind: vm
    purpose: Application host running the home services
    hypervisor: nas
    vmid: 100
    addresses:
      - { network: lan, address: 192.0.2.20, primary: true }
    access: { reachable: true, method: ssh, port: 22, user: admin }
```

A guest declares `hypervisor` and `vmid` together, or neither.

Add what runs on those hosts under `services`.
Each service requires `name`, `host`, `kind`, and `purpose`:

```yaml
services:
  - { name: files, host: nas, kind: systemd, purpose: File sharing, status: active }
  - { name: portal, host: apps, kind: docker-compose, purpose: Home dashboard, status: active }
```

A service is identified by `host` plus `name`, so the same service name can exist on different
hosts.
For the full set of host and service fields and their allowed values, see the
[inventory reference](../reference/estate-config.md#inventory-hosts-and-services).

## Lay out the portal

Arrange the launch portal with `groups`, in an overlay layer so you can iterate on layout
without touching inventory:

```yaml
# my-estate/10-overlay.yaml
schemaVersion: 1
groups:
  - id: overview
    title: Overview
    order: 1
    items:
      - { type: service, host: apps, name: portal, title: Portal }
      - { type: service, host: nas, name: files, title: Files }
      - { type: link, title: Gateway, href: "https://gateway.home.example/" }
```

Each item is a service tile (`type: service`, referencing a declared service by `host` and
`name`), a plain link (`type: link`, with `title` and `href`), or a one-level subgroup
(`type: group`).
For the item shapes in full, see the
[portal reference](../reference/estate-config.md#portal-groups-and-items).

## Validate before you run

Validate the directory before you start deck against it.
Validation runs the same load, merge, and schema checks the server runs at boot, so a clean
result means the estate will boot:

```bash
bun apps/server/src/cli/deck.ts validate /path/to/my-estate
```

A clean estate exits 0; findings exit 1; a tool error such as a missing directory or a YAML
parse failure exits 2.
To see exactly what your base and overlays merged into, render the resolved document:

```bash
bun apps/server/src/cli/deck.ts render /path/to/my-estate --out rendered.json
```

For the full command, flags, and exit classes, see the [CLI reference](../reference/cli.md).

## Next steps

- Serve your runbooks and config files inside deck:
  [Serve docs and configs from your estate](serve-docs-and-configs.md).
- Wire monitoring backends into the monitoring surface:
  [Connect monitoring and alerts](connect-monitoring.md).
- Turn on governed actions:
  [Enable and define governed actions](governed-actions.md).

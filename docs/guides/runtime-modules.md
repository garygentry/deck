# Run a runtime module

A runtime module adds a capability to deck without rebuilding it: you drop the module's directory
into `DECK_MODULES_DIR`, switch runtime modules on, and restart deck. The module uses the same
contract as deck's built-in modules. It can add pages, nav entries, header pills, provider data,
HTTP routes under `/api/m/<id>`, health and a config section of its own.

Runtime modules are off by default. A runtime module's server code runs **inside the deck
process, with every privilege deck has**: it can read deck's environment and files and make any
network call deck can. Install only modules you would run as deck itself. For deck's wider
posture, see [Security & access posture](../security.md).

This guide installs the example module in [`examples/modules/maintenance`](../../examples/modules/maintenance),
which lists planned maintenance windows. It adds:

- a page at `/maintenance`, with a nav entry in the Operate group;
- a header pill;
- a provider, `maintenance`, that says which window is in progress and which is next;
- a route, `GET /api/m/maintenance/windows`;
- a config section, `modules.maintenance`, with a schema and a config rule.

This release loads a runtime module's server half only. The web shell skips pages, nav
entries and pills whose components no loaded web code provides, and the page path shows "not
found". Their declarations are still served in `GET /api/ui`.

## Lay out the modules directory

`DECK_MODULES_DIR` holds one subdirectory per module. Each subdirectory is named by the module's
id:

```text
modules/
  maintenance/
    deck-module.json   # the manifest: required
    server.mjs         # the server entry: optional
```

- `deck-module.json` is the module's manifest, the same shape built-in modules declare: `id`,
  `version`, `deckApi`, `enabledBy`, `config`, `contributes`, and so on (see the
  [`@deck/module-sdk` README](../../packages/module-sdk/README.md)). Its `id` must be the
  directory's name.
- The server entry is `server.js`, `server.mjs` or `server.ts`. A module has at most one. Its
  default export is the server module, `{ manifest, init, configRules?, kinds? }`, and its
  `manifest` must equal `deck-module.json`. A module without an entry contributes its manifest
  only.
- The entry imports nothing from deck at runtime: everything it uses comes through the `ctx`
  passed to `init`, so `@deck/module-sdk` is imported for types only. Bundle any other
  dependency into the module directory.
- Directories whose names start with `.` and plain files are ignored.

## Switch runtime modules on

Mount the directory read-only and set both variables:

```yaml
services:
  deck:
    environment:
      DECK_MODULES_DIR: /modules
      DECK_MODULES_ENABLED: "true"
    volumes:
      - ./modules:/modules:ro
```

The example is switched on by its config section (`enabledBy: { config: true }`), so add one to
an overlay layer:

```yaml
modules:
  maintenance:
    windows:
      - name: kernel upgrades
        start: 2026-10-10T02:00:00Z
        durationMinutes: 60
```

`deck validate` checks the section against the module's schema when `DECK_MODULES_DIR` is set.
It reads manifests only and runs no module code, so the module's config rules (here, that
`start` has an offset) run at boot.

## Pin the module's contents

To make deck refuse a module directory that has changed since you reviewed it, pin its digest in
the config:

```bash
bun apps/server/src/cli/deck.ts module digest examples/modules/maintenance
```

```yaml
moduleIntegrity:
  maintenance: sha256-…   # the line the command printed
```

deck computes the digest over every file in the directory before it imports anything, so a
module that does not match runs no code. Update the pin whenever you update the module. See
[Runtime module integrity](../reference/estate-config.md#runtime-module-integrity).

## When a module's code is loaded

deck reads every `deck-module.json` at boot, whether or not runtime modules are on. That way it
always knows each module's config section and says why a module is off. It imports a module's
server entry only when all of these hold:

1. `DECK_MODULES_ENABLED` is on.
2. The manifest is usable and its `deckApi` range matches this deck.
3. The module's own `enabledBy` switches are on.
4. The directory matches its pin, if it has one.

Otherwise the module is off and none of its code runs. `GET /api/ui` lists it with the reason,
and with the setting that would switch it on.

## When a module fails

A runtime module that cannot be loaded is disabled and boot continues. This covers:

- a missing or invalid `deck-module.json`, or an `id` that is not its directory's name;
- a directory that does not match its pin;
- an entry that throws or does not finish importing within 10 seconds;
- an entry that does not export a module whose manifest equals `deck-module.json`.

deck logs a `module.disabled` warning with the code `MODULE_LOAD_FAILED` and the reason, and
`GET /api/health` reports the module as `disabled`. Other failures follow the rules for every
module: a manifest the host refuses is `MODULE_MANIFEST_INVALID`, and a `deckApi` mismatch is
`MODULE_API_INCOMPATIBLE`.

There is one exception: config you wrote for the module is still checked. If the module's
section is present and invalid against the schema in its `deck-module.json`, boot fails as it
would if the module had loaded.

Once loaded, a runtime module runs under the same lifecycle as a built-in. If its `init` throws,
boot fails with exit class 2, and its stop hooks run at shutdown.

## Check that it runs

At boot, deck logs a `modules.runtime` line naming the directory and the modules it loaded and
failed to load. Then:

```bash
curl -s localhost:8080/api/ui | jq '.modules[] | select(.id == "maintenance")'
curl -s localhost:8080/api/providers/maintenance | jq .data
curl -s localhost:8080/api/health | jq .modules.maintenance
```

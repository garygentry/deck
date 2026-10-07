# CLI reference

The `deck` binary loads an estate config directory and either reports its findings or writes the
canonical merged document, and can rewrite a schemaVersion 1 config directory as version 2.
This page covers `validate`, `render` and `config migrate`.

The general form is:

```text
deck <validate|render> [dir] [--config <dir>] [--out <file>] [--advisory-disabled]
deck config migrate <dir> [--dry-run]
```

An unrecognized subcommand prints the usage line to standard error and exits with class 2.

The source runs from TypeScript under Bun, so invocations below use `bun` against the entry
point.

```bash
bun apps/server/src/cli/deck.ts validate examples/estate
```

## Arguments

Argument parsing is shared by both subcommands.

| Argument | Meaning |
| --- | --- |
| `[dir]` | Positional config directory. Used as the config directory when `--config` is not given. |
| `--config <dir>` | Config directory. When present it sets the config directory. |
| `--out <file>` | Output file for `render`. Ignored by `validate`. |
| `--advisory-disabled` | `validate` only: report problems in a switched-off module's section as advisory instead of at their real severity (see below). |

When no directory is supplied, the config directory is resolved from the environment
(`DECK_CONFIG_DIR`), falling back to `config`; see [Environment variables](./environment-variables.md).

## deck validate

`deck validate` loads the config directory, runs the schema validator across the base, overlay,
and merged layers, and reports the outcome.
It writes nothing to disk.

- On a clean load, it writes `clean` to standard output and exits 0.
- On a clean load that carries advisory (non-blocking) findings, it writes the findings followed
  by `clean (advisory only)` to standard output and exits 0.
- On blocking findings, it writes the findings to standard error and exits 1.
- On a tool error (unreadable, empty, unparseable, or unmergeable config), it writes the tool
  error to standard error and exits 2. A schemaVersion 1 config is the tool error
  `CONFIG_MIGRATION_REQUIRED`, whose message names the `deck config migrate` command to run.

Which modules are enabled is decided as at boot, from the config and the environment `deck
validate` runs in. A section for a module that is installed but not enabled there (for example,
one switched on by an environment variable that is unset where you validate, as
`DECK_ACTIONS_ENABLED` usually is in CI) is still checked as if the module were on: against its
schema, rules, identities, host/service references and layer ownership, at their **real
severity**, so an error fails the run (exit 1) exactly as it would fail deck's boot once the
module is switched on. An info `MODULE_SECTION_DISABLED` finding notes that the section is not
in effect where you validated.

With `--advisory-disabled`, those problems are instead reported as info `MODULE_SECTION_DISABLED`
findings, `would fail when "<id>" is enabled: <CODE> <message>`, and do not fail the run (layer
ownership is not checked for such a section). This is how deck itself treats the section at boot:
a module that is switched off never blocks boot.

A binding or integration of a provider kind that only a module that is not running provides
(switched off, or refused because its manifest is unusable) is reported as
`PROVIDER_KIND_DISABLED`, naming the module. Boot reports it at info and ignores the reference,
so an off data-source module never stops deck from starting; `deck validate` reports it as a
warning (exit 1) unless `--advisory-disabled` is given.

```bash
bun apps/server/src/cli/deck.ts validate --config examples/estate
```

## deck render

`deck render` loads the config directory and, on a clean load, writes the canonical merged config
document as JSON to the output file.
It loads exactly as boot does, so it renders what boot would serve: the findings boot treats as
advisory (`PROVIDER_ID_SHARED`, `MODULE_CREDENTIAL_ENV_REFUSED`) do not stop it, though
`deck validate` reports them as warnings and exits 1.

- The output path comes from `--out`; when omitted it defaults to `deck.config.json` in the
  working directory.
- On any non-clean load, no file is written: the diagnostic goes to standard error and the exit
  class is returned unchanged (1 for findings, 2 for a tool error).

```bash
bun apps/server/src/cli/deck.ts render examples/estate --out deck.config.json
```

## deck config migrate

`deck config migrate <dir>` rewrites every YAML layer in a config directory from schemaVersion 1
to schemaVersion 2, in place:
`groups` moves to `modules.portal.groups`, `actions` to `modules.actions.actions`, `llmUsage` to
`modules.llm-usage`, `agents` is dropped, and `schemaVersion` becomes 2.
See [Migrating from schemaVersion 1](./estate-config.md#migrating-from-schemaversion-1) for the
mapping in full.

- Each layer is rewritten on its own, so every key stays in the layer it was in. Comments
  (including those of a dropped `agents` list), formatting and line endings are kept.
- A layer already at version 2 is left untouched, so a second run is a no-op.
- `--dry-run` prints the change to standard output as a unified diff per layer (it applies
  with `patch`) and writes nothing. Any other option is refused with the usage line, exit 2.
- A layer that is a symlink is migrated at its target, so the link is kept; the output names
  both (`layer -> target`).
- The rewritten file keeps the original's mode, and its owner and group where the user may
  set them (otherwise a warning says so).
- Every layer is migrated and staged before any is replaced. If one cannot be migrated or
  staged, nothing is written. If replacing one fails, the layers already replaced get their
  original text back. Either way the command reports `CONFIG_MIGRATE_FAILED` on standard error
  and exits 2.
- A file the line-preserving rewrite cannot carry (for example, an alias it would move before
  its anchor) is refused with "migrate this file by hand".
- A dropped `agents` list that had entries is reported as a warning on standard error.
- It exits 0 when the directory was migrated or already current, and 2 for a missing directory,
  a bad argument, or a layer it cannot migrate.

```bash
bun apps/server/src/cli/deck.ts config migrate examples/estate --dry-run
bun apps/server/src/cli/deck.ts config migrate examples/estate
```

## Exit classes

`validate` and `render` share one exit-class scheme, defined by the config loader.

| Code | Class | Meaning |
| --- | --- | --- |
| `0` | clean | Config loaded and validated; `render` wrote its output. Advisory findings may be present. |
| `1` | findings | Blocking validation findings; diagnostics on standard error. |
| `2` | tool error | Config directory missing or empty, YAML parse failure, merge conflict, a schemaVersion 1 config, a module conflict, or an unknown subcommand. |

## Related references

- [Environment variables](./environment-variables.md) — `DECK_CONFIG_DIR` and other deployment settings.
- [HTTP API reference](./http-api.md) — the running server's routes.

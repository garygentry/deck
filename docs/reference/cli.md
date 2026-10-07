# CLI reference

The `deck` binary loads an estate config directory and either reports its findings or writes the
canonical merged document.
It exposes two subcommands, `validate` and `render`, and no others.

The general form is:

```text
deck <validate|render> [dir] [--config <dir>] [--out <file>]
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
  error to standard error and exits 2.

```bash
bun apps/server/src/cli/deck.ts validate --config examples/estate
```

## deck render

`deck render` loads the config directory and, on a clean load, writes the canonical merged config
document as JSON to the output file.

- The output path comes from `--out`; when omitted it defaults to `deck.config.json` in the
  working directory.
- On any non-clean load, no file is written: the diagnostic goes to standard error and the exit
  class is returned unchanged (1 for findings, 2 for a tool error).

```bash
bun apps/server/src/cli/deck.ts render examples/estate --out deck.config.json
```

## Exit classes

Both subcommands share one exit-class scheme, defined by the config loader.

| Code | Class | Meaning |
| --- | --- | --- |
| `0` | clean | Config loaded and validated; `render` wrote its output. Advisory findings may be present. |
| `1` | findings | Blocking validation findings; diagnostics on standard error. |
| `2` | tool error | Config directory missing or empty, YAML parse failure, merge conflict, or an unknown subcommand. |

## Related references

- [Environment variables](./environment-variables.md) — `DECK_CONFIG_DIR` and other deployment settings.
- [HTTP API reference](./http-api.md) — the running server's routes.

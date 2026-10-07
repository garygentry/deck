# ADR-002: Layered estate config merged into one document

- Status: accepted
- Date: 2026-09-20

## Context

Deck reads its estate configuration from a directory rather than a single file.
The directory resolver (`apps/server/src/config/resolve-dir.ts`) selects every `*.yaml` /
`*.yml` file in the configured directory and returns them sorted lexically, so file naming controls
order — a `00-base` file is read before a `10-overlay` file.
The loader (`apps/server/src/config/load.ts`) treats the first file as the base and the rest as
overlays applied in order.

The merge itself (`packages/schema/src/merge.ts`) is not a blind deep-merge.
It assigns ownership per field, so a value is designated base-owned, overlay-owned, or a shared
container, and it combines layers according to that ownership rather than letting the last writer
win everywhere.
It also enforces preconditions before producing any output: both layers must carry a matching
`schemaVersion`, inputs must be objects, and elements matched across layers must carry their
identity keys — a failed precondition throws and no partial document is produced.
The layer validation rule (`packages/schema/src/validate/rules/layers.ts`) checks the same split
from the validator's side: an overlay-owned value in the base, or a base-owned value in the
overlay, is a finding, and overlay references that do not resolve against the base are flagged as
dangling.

## Decision

Author estate configuration as ordered YAML layers in a directory, and merge them — with per-field
ownership and strict preconditions — into a single canonical document that the rest of the engine
consumes.
Base layers carry generated inventory; overlay layers carry hand-authored presentation and intent,
and merging is validated on both sides so the split is enforced, not merely conventional.

## Consequences

A machine can regenerate the base layer without destroying hand-authored overlay content, because
ownership keeps presentation values out of the base and inventory values out of the overlay, and
the validator reports a value that lands in the wrong layer.
Load is all-or-nothing: a version mismatch, a missing identity, or a merge precondition failure
aborts the load and maps to a tool-error exit rather than emitting a half-merged document, so
downstream code only ever sees a complete, validated document.

The costs are the ones inherent to layering.
Authors must know which layer a given key belongs in, and the lexical-ordering convention means file
names carry meaning — an out-of-order or mis-named file changes how layers combine.
Overlays can only refine identities that exist in the base, so a dangling overlay reference is an
error rather than an implicit create.
Every consumer works against the merged canonical document, keeping the layering concern contained
to load time.

## Related

- [Engine and estate: the config-driven contract](../../explanation/engine-and-estate.md)
- [Estate configuration reference](../../reference/estate-config.md)

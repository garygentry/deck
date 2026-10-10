# ADR-003: Separate declared intent from observed reality

- Status: accepted
- Date: 2026-09-20

## Context

Deck models an estate with two separate, independently authoritative documents, each with its own
JSON Schema.
The config document (`packages/schema/schema/deck.schema.json`) describes declared intent: it
requires `schemaVersion` and `estate` and carries the declared hosts, services, portal groups,
sources, integrations, and actions.
The snapshot document (`packages/schema/schema/snapshot.schema.json`) describes observed reality:
it requires `schemaVersion` and a `generatedAt` timestamp and carries observed hosts and services,
per-host coverage, and drift findings.
Its own description names it "observed reality projected from observation and drift outputs without
a fresh or stale judgement" — the snapshot records what was seen and when, and leaves the freshness
judgement to the reader.

The two documents are joined only at derivation time.
`deriveDriftProjection` (`packages/drift/src/derive.ts`) consumes a snapshot generation and an
explicit clock and produces an immutable projection — findings grouped by host and service,
coverage rows per host, waiver state judged against the clock, and summary counts.
Deck reads both documents and derives the difference; it never writes estate facts back into either.

## Decision

Keep declared intent and observed reality as two documents — config and snapshot — with distinct
schemas, and derive drift and coverage from their difference rather than storing a single merged
estate state.
Each document is produced independently of the other, and deck's role is to read them and project
the comparison.

## Consequences

Drift is expressible because there are two inputs to compare: a declared host with no observation, or
an observed state that diverges from intent, becomes a finding rather than being folded into one
ambiguous record.
Coverage and freshness come from the reality document without the config having to know anything
about observation — the snapshot carries how completely each host was seen and when, and derivation
judges freshness against an explicit clock, so the same snapshot can read as fresh or stale
depending on when it is derived.
Because deck only reads, neither document is corrupted by the other, and each can be regenerated on
its own cadence.

The costs are two artifacts to produce and keep in step, and a dependence on snapshot freshness: a
stale snapshot can misrepresent a healthy estate, which is why freshness is derived and surfaced
rather than assumed.
Comparison requires stable join keys between the two documents — an observed host is matched to its
declared counterpart by name — so the two schemas must stay aligned on identity for the projection
to be meaningful.

## Related

- [Engine and estate: the config-driven contract](../../explanation/engine-and-estate.md)
- [Inventory beside reality: how drift and coverage work](../../explanation/drift-and-coverage.md)
- [Snapshot contract reference](../../reference/snapshot-contract.md)

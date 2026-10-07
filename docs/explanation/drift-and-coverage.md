# Inventory beside reality: how drift and coverage work

Deck's central idea is to hold two pictures of an estate side by side and let the gap between
them speak.
One picture is **declared intent** — the hosts, services, and groups you author in estate
config, the way the estate is *supposed* to be.
The other is **observed reality** — a snapshot that some collector you run has actually seen, the
way the estate *is* right now.
Deck itself observes nothing; it reads both documents and derives what their difference means.
Drift, coverage, and freshness are the three ways it reports on that difference, and each answers
a distinct question: *what disagrees*, *how much can we trust the observation*, and *how old is
it*.

This is an explanation of the model, not a procedure.
To produce and refresh the observed snapshot, see
[Produce and refresh a snapshot](../guides/produce-a-snapshot.md); for the exact shape of the
snapshot document, see the [snapshot contract reference](../reference/snapshot-contract.md).

## What drift is

A drift finding is a recorded discrepancy between what the estate declares and what was observed
— a service that should be running but is not, a config that has diverged from its intended form,
a port that answers where none was expected.
Crucially, deck does not compute these discrepancies field by field on its own.
The collector that inspects your estate is what knows enough to compare a specific expectation to
a specific observation, so the findings are authored *into* the snapshot, in its drift list,
alongside the observed hosts and services.

Deck's role is to make that list legible and honest.
It takes each finding exactly as the collector wrote it — its severity, its category, its plain-
language message, and the optional expected/observed values being compared — and presents them
grouped by host and then by service, so a reader sees everything wrong with one host in one
place.
It counts active risk by severity, and it deliberately keeps that count independent of findings
that have been waived, so an acknowledged issue stops inflating the "still broken" tally without
ever disappearing.

Waivers are how deck reconciles "we know about this" with "don't lose track of it."
A finding can carry a waiver — a reason, who set it, and an optional expiry — and deck evaluates
that expiry at display time against the current clock.
A waiver in force reads as active and lifts the finding out of the active-risk counts; an expired
or malformed one lets the finding count as risk again.
A waiver never removes a finding or edits its severity; it only labels it, so the underlying
reality the collector reported stays visible.

## Coverage states

Drift tells you what disagrees, but a finding is only as trustworthy as the observation behind
it — and an observation can be complete, partial, or missing entirely.
Coverage is deck's account of that trust, computed for every host across the union of what the
config declares and what the snapshot observed.
This is the one comparison deck makes itself: it walks the declared hosts and the observed hosts
together and assigns each a single collection state.

Five states cover every case.
A host that was fully observed reads **fresh** or **stale** depending on its age (the next
section).
A host whose collector reports only partial success — some probes succeeded, others failed —
reads **partial**, and stays partial regardless of age, because an incomplete observation is a
different kind of uncertainty than an old one.
A host the collector could not reach at all reads **unreachable**.
And a host that the config declares but the snapshot never mentions reads **never-collected** —
declared intent with no observation to set beside it.

The distinction that matters for trust is between *silence* and *evidence of a problem*.
A never-collected host is not a healthy host; it is a host deck knows nothing observed about, and
its absence of drift findings means nothing.
A partial host's findings are real but may be incomplete.
Only a fresh, fully collected host offers an observation you can lean on without an asterisk.
Reading coverage first, then drift, keeps you from mistaking a blind spot for a clean bill of
health.

## Freshness

The last question is age, and deck answers it from the wall clock rather than trusting any
"healthy" flag inside the snapshot.
Each observed host carries the time it was collected, and deck compares that timestamp to now.
If the age exceeds a threshold, the host reads stale; otherwise it reads fresh.
Because the judgement is clock-relative, a collector that quietly stops running does not leave the
estate looking healthy — its hosts simply age past the threshold and surface as stale, which is
exactly the signal you want.

The threshold is a single estate-level setting, an ISO-8601 duration named
`snapshotStaleAfter`, defaulting to a day when you do not set one.
It is deliberately one knob for the whole estate rather than a per-host dial, keeping "how old is
too old" a single, legible policy.
The snapshot also carries a top-level generation time describing when the whole document was
produced, which is a coarser, document-wide companion to each host's own collection time.

It is worth separating two notions of freshness that can look alike.
One is whether deck's own polling of the snapshot source is succeeding — whether it can read the
file or reach the URL at all.
The other is how old the *observation inside* the snapshot is.
Deck keeps these distinct: it can be polling a reachable source perfectly well while every host
inside that snapshot reads stale because the collector behind it has fallen behind.
The first is a plumbing question about deck; the second is the real question about your estate,
and it is the one coverage and freshness are built to answer.

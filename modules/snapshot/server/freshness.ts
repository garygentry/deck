import { parse, pattern, toSeconds } from "iso8601-duration";

import type { DeckConfigDocument, ObservedHost, SnapshotDocument } from "@deck/schema";

import type { HostCollectionState, HostState } from "@deck/contract";
import { SNAPSHOT_READ_MESSAGES, SnapshotReadFailure } from "./errors.js";

/** Default collection stale threshold used when config omits the field. */
export const DEFAULT_SNAPSHOT_STALE_AFTER = "PT24H";

// The library's exported pattern matches anywhere in a string, so leading/trailing
// junk or a sign (e.g. "-PT5H") would parse to a bogus positive value. Anchor the
// library's own pattern to reject anything that is not a whole ISO-8601 duration —
// this reuses the package grammar rather than inventing a feature-local one.
const WHOLE_DURATION = new RegExp(`^${pattern.source}$`);

/**
 * Parse a positive ISO-8601 duration into finite milliseconds.
 *
 * Defaults an absent value to {@link DEFAULT_SNAPSHOT_STALE_AFTER}. A present but
 * malformed, zero, negative, overflowing, or non-finite duration throws
 * `STALE_THRESHOLD_INVALID`; the default is never silently substituted for an
 * invalid present value.
 *
 * @throws {SnapshotReadFailure} `STALE_THRESHOLD_INVALID` for invalid/non-positive values.
 */
export function parseStaleAfterMs(value: string | undefined): number {
  const raw = value ?? DEFAULT_SNAPSHOT_STALE_AFTER;
  let seconds: number;
  try {
    // Match the library's own comma normalization before the anchored check.
    if (!WHOLE_DURATION.test(raw.replace(/,/g, "."))) throw new RangeError("invalid duration");
    seconds = toSeconds(parse(raw));
  } catch {
    throw invalidStaleThreshold();
  }
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw invalidStaleThreshold();
  }
  return ms;
}

function invalidStaleThreshold(): SnapshotReadFailure {
  return new SnapshotReadFailure(
    "STALE_THRESHOLD_INVALID",
    SNAPSHOT_READ_MESSAGES.STALE_THRESHOLD_INVALID,
  );
}

/** Build a frozen null-timestamp state (never-collected or unreachable). */
function nullState(state: "never-collected" | "unreachable"): HostState {
  return Object.freeze({
    state,
    collectedAt: null,
    ageMs: null,
    pastStaleThreshold: false,
  });
}

/** Derive a state from one observed host's coverage and timestamp. */
function deriveObserved(observed: ObservedHost, nowMs: number, staleAfterMs: number): HostState {
  const coverage = observed.coverage;

  if (coverage === "unreachable") return nullState("unreachable");
  // Defensive: an unexpected coverage value degrades to unreachable rather than
  // discarding an otherwise classification-1 snapshot.
  if (coverage !== "collected" && coverage !== "partial") return nullState("unreachable");

  const collectedAt = observed.collectedAt;
  const collectedMs = typeof collectedAt === "string" ? Date.parse(collectedAt) : Number.NaN;
  if (typeof collectedAt !== "string" || !Number.isFinite(collectedMs)) {
    // Missing or non-finite timestamp on a collected/partial coverage is a
    // defensive invalid combination.
    return nullState("unreachable");
  }

  // Future timestamps clamp the age to zero.
  const ageMs = Math.max(0, nowMs - collectedMs);
  const pastStaleThreshold = ageMs > staleAfterMs;

  const state: HostCollectionState =
    coverage === "partial" ? "partial" : pastStaleThreshold ? "stale" : "fresh";

  return Object.freeze({ state, collectedAt, ageMs, pastStaleThreshold });
}

/**
 * Derive one immutable state for every name in declared-host ∪ observed-host.
 *
 * Declared hosts come first, then observed-only hosts; each name appears exactly
 * once. The first observation for a duplicated name wins defensively — duplicate
 * observations remain visible as validator findings, not here. Returns a
 * null-prototype record frozen with `Object.freeze`.
 */
export function deriveHostStates(
  config: DeckConfigDocument,
  snapshot: SnapshotDocument,
  now: Date,
  staleAfterMs: number,
): Readonly<Record<string, HostState>> {
  const observedByName = new Map<string, ObservedHost>();
  for (const host of snapshot.hosts ?? []) {
    if (host && typeof host.name === "string" && !observedByName.has(host.name)) {
      observedByName.set(host.name, host);
    }
  }

  const result: Record<string, HostState> = Object.create(null) as Record<string, HostState>;
  const nowMs = now.getTime();

  const emit = (name: string): void => {
    if (name in result) return;
    const observed = observedByName.get(name);
    result[name] = observed ? deriveObserved(observed, nowMs, staleAfterMs) : nullState("never-collected");
  };

  for (const host of config.hosts ?? []) {
    if (host && typeof host.name === "string") emit(host.name);
  }
  for (const name of observedByName.keys()) {
    emit(name);
  }

  return Object.freeze(result);
}

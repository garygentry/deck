import { describe, expect, it } from "vitest";

import type { DeckConfigDocument, ObservedHost, SnapshotDocument } from "@deck/schema";

import type { HostState } from "../src/contract/snapshot.js";
import { SnapshotReadFailure } from "../src/providers/snapshot/errors.js";
import {
  DEFAULT_SNAPSHOT_STALE_AFTER,
  deriveHostStates,
  parseStaleAfterMs,
} from "../src/providers/snapshot/freshness.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Build a minimal declared-config document from host names. */
function configWith(...hostNames: string[]): DeckConfigDocument {
  return {
    schemaVersion: 1,
    estate: { name: "fixture-estate" },
    hosts: hostNames.map((name) => ({ name, kind: "vm", purpose: "Fixture host" })),
  };
}

/** Build a minimal snapshot document from observed host records. */
function snapshotWith(...hosts: ObservedHost[]): SnapshotDocument {
  return {
    schemaVersion: 1,
    generatedAt: "2030-01-02T00:00:00.000Z",
    hosts,
  };
}

/** Compose an observed host with defaults, overridable per test. */
function observed(partial: Partial<ObservedHost> & { name: string }): ObservedHost {
  return { coverage: "collected", ...partial } as ObservedHost;
}

describe("parseStaleAfterMs", () => {
  it("defaults an absent value to PT24H", () => {
    expect(parseStaleAfterMs(undefined)).toBe(DAY_MS);
    expect(DEFAULT_SNAPSHOT_STALE_AFTER).toBe("PT24H");
  });

  it("accepts supported ISO-8601 duration forms", () => {
    expect(parseStaleAfterMs("PT24H")).toBe(DAY_MS);
    expect(parseStaleAfterMs("PT30M")).toBe(30 * 60 * 1000);
    expect(parseStaleAfterMs("PT1H30M")).toBe(90 * 60 * 1000);
    expect(parseStaleAfterMs("P1D")).toBe(DAY_MS);
    expect(parseStaleAfterMs("P1W")).toBe(7 * DAY_MS);
    expect(parseStaleAfterMs("PT0.5H")).toBe(30 * 60 * 1000);
  });

  it("throws STALE_THRESHOLD_INVALID for malformed input", () => {
    for (const bad of ["", "24h", "P", "not-a-duration", "PT"]) {
      let thrown: unknown;
      try {
        parseStaleAfterMs(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SnapshotReadFailure);
      expect((thrown as SnapshotReadFailure).code).toBe("STALE_THRESHOLD_INVALID");
    }
  });

  it("throws STALE_THRESHOLD_INVALID for a zero duration", () => {
    expect(() => parseStaleAfterMs("PT0S")).toThrowError(SnapshotReadFailure);
    expect(() => parseStaleAfterMs("P0D")).toThrowError(SnapshotReadFailure);
  });

  it("throws STALE_THRESHOLD_INVALID for a negative duration", () => {
    // ISO-8601 durations cannot express negatives; the parser rejects the sign.
    expect(() => parseStaleAfterMs("-PT5H")).toThrowError(SnapshotReadFailure);
    expect(() => parseStaleAfterMs("PT-5H")).toThrowError(SnapshotReadFailure);
  });

  it("throws STALE_THRESHOLD_INVALID for overflow/non-finite durations", () => {
    // A year count beyond the representable Date range yields a non-finite result.
    expect(() => parseStaleAfterMs("P1000000Y")).toThrowError(SnapshotReadFailure);
  });

  it("never silently substitutes the default for an invalid present value", () => {
    let thrown: unknown;
    try {
      parseStaleAfterMs("bogus");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SnapshotReadFailure);
    expect((thrown as SnapshotReadFailure).code).toBe("STALE_THRESHOLD_INVALID");
  });
});

describe("deriveHostStates", () => {
  const now = new Date("2030-01-02T00:00:00.000Z");
  const nowMs = now.getTime();
  const stale = DAY_MS; // 24h threshold

  function iso(offsetMs: number): string {
    return new Date(nowMs - offsetMs).toISOString();
  }

  it("maps a declared-absent host to never-collected", () => {
    const states = deriveHostStates(configWith("h-never"), snapshotWith(), now, stale);
    expect(states["h-never"]).toEqual({
      state: "never-collected",
      collectedAt: null,
      ageMs: null,
      pastStaleThreshold: false,
    } satisfies HostState);
  });

  it("treats a collection at exactly the threshold as fresh", () => {
    const collectedAt = iso(stale); // age === threshold
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "collected", collectedAt })),
      now,
      stale,
    );
    expect(states["h1"]).toEqual({
      state: "fresh",
      collectedAt,
      ageMs: stale,
      pastStaleThreshold: false,
    } satisfies HostState);
  });

  it("treats one millisecond past the threshold as stale", () => {
    const collectedAt = iso(stale + 1);
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "collected", collectedAt })),
      now,
      stale,
    );
    expect(states["h1"]).toEqual({
      state: "stale",
      collectedAt,
      ageMs: stale + 1,
      pastStaleThreshold: true,
    } satisfies HostState);
  });

  it("keeps a current partial collection as partial", () => {
    const collectedAt = iso(HOUR_MS);
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "partial", collectedAt })),
      now,
      stale,
    );
    expect(states["h1"]).toEqual({
      state: "partial",
      collectedAt,
      ageMs: HOUR_MS,
      pastStaleThreshold: false,
    } satisfies HostState);
  });

  it("keeps an old partial as partial while recording pastStaleThreshold", () => {
    const collectedAt = iso(stale + HOUR_MS);
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "partial", collectedAt })),
      now,
      stale,
    );
    expect(states["h1"]).toEqual({
      state: "partial",
      collectedAt,
      ageMs: stale + HOUR_MS,
      pastStaleThreshold: true,
    } satisfies HostState);
  });

  it("maps an unreachable host to unreachable with null timestamp and age", () => {
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "unreachable", collectedAt: iso(0) })),
      now,
      stale,
    );
    expect(states["h1"]).toEqual({
      state: "unreachable",
      collectedAt: null,
      ageMs: null,
      pastStaleThreshold: false,
    } satisfies HostState);
  });

  it("covers observed-only hosts absent from the declaration", () => {
    const collectedAt = iso(HOUR_MS);
    const states = deriveHostStates(
      configWith(),
      snapshotWith(observed({ name: "obs-only", coverage: "collected", collectedAt })),
      now,
      stale,
    );
    expect(states["obs-only"]).toEqual({
      state: "fresh",
      collectedAt,
      ageMs: HOUR_MS,
      pastStaleThreshold: false,
    } satisfies HostState);
  });

  it("clamps a future collection timestamp to zero age", () => {
    const collectedAt = new Date(nowMs + DAY_MS).toISOString();
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "collected", collectedAt })),
      now,
      stale,
    );
    expect(states["h1"]).toEqual({
      state: "fresh",
      collectedAt,
      ageMs: 0,
      pastStaleThreshold: false,
    } satisfies HostState);
  });

  it("defensively maps an invalid timestamp to unreachable", () => {
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "collected", collectedAt: "not-a-date" })),
      now,
      stale,
    );
    expect(states["h1"]).toEqual({
      state: "unreachable",
      collectedAt: null,
      ageMs: null,
      pastStaleThreshold: false,
    } satisfies HostState);
  });

  it("defensively maps a missing timestamp on collected coverage to unreachable", () => {
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "collected" })),
      now,
      stale,
    );
    expect(states["h1"]?.state).toBe("unreachable");
  });

  it("defensively maps an unexpected coverage value to unreachable", () => {
    const bogus = { name: "h1", coverage: "bogus", collectedAt: iso(0) } as unknown as ObservedHost;
    const states = deriveHostStates(configWith("h1"), snapshotWith(bogus), now, stale);
    expect(states["h1"]?.state).toBe("unreachable");
  });

  it("covers the declared ∪ observed union exactly once with declared first", () => {
    const config = configWith("declared-fresh", "declared-never");
    const snapshot = snapshotWith(
      observed({ name: "declared-fresh", coverage: "collected", collectedAt: iso(HOUR_MS) }),
      observed({ name: "obs-only", coverage: "collected", collectedAt: iso(HOUR_MS) }),
    );
    const states = deriveHostStates(config, snapshot, now, stale);

    expect(Object.keys(states)).toEqual(["declared-fresh", "declared-never", "obs-only"]);
    expect(states["declared-fresh"]?.state).toBe("fresh");
    expect(states["declared-never"]?.state).toBe("never-collected");
    expect(states["obs-only"]?.state).toBe("fresh");
  });

  it("uses the first observation defensively for a duplicated host name", () => {
    const snapshot = snapshotWith(
      observed({ name: "dup", coverage: "collected", collectedAt: iso(HOUR_MS) }),
      observed({ name: "dup", coverage: "unreachable" }),
    );
    const states = deriveHostStates(configWith(), snapshot, now, stale);
    expect(Object.keys(states)).toEqual(["dup"]);
    expect(states["dup"]?.state).toBe("fresh");
  });

  it("returns a frozen null-prototype record", () => {
    const states = deriveHostStates(
      configWith("h1"),
      snapshotWith(observed({ name: "h1", coverage: "collected", collectedAt: iso(HOUR_MS) })),
      now,
      stale,
    );
    expect(Object.getPrototypeOf(states)).toBeNull();
    expect(Object.isFrozen(states)).toBe(true);
    expect(() => {
      (states as Record<string, HostState>)["injected"] = {
        state: "fresh",
        collectedAt: null,
        ageMs: null,
        pastStaleThreshold: false,
      };
    }).toThrowError();
  });
});

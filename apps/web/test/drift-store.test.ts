// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installEnv, resetInventoryTestEnv, type Env } from "./inventory-harness.js";
import type { InventoryGeneration } from "../src/features/hosts-and-services/inventory-store.js";
import type { DriftDiagnosticEvent } from "../src/features/drift-and-coverage/diagnostics.js";
import type { DriftGenerationState } from "../src/features/drift-and-coverage/store.js";

// ---------------------------------------------------------------------------
// The drift store and diagnostics are module singletons. Each case loads a fresh
// module set (vi.resetModules + dynamic import) over a controllable mock inventory
// store so its retained bundle, listener set, and dedupe records are isolated.
// All fixtures are invented; identities use the reserved `.invalid` TLD.
// ---------------------------------------------------------------------------

const INVENTORY_STORE_PATH =
  "../src/features/hosts-and-services/inventory-store.js";
const STORE_PATH = "../src/features/drift-and-coverage/store.js";
const DIAGNOSTICS_PATH = "../src/features/drift-and-coverage/diagnostics.js";
const HOOK_PATH = "../src/features/drift-and-coverage/use-drift-generation.js";

const FIXED = "2030-05-31T23:00:00.000Z";
const DERIVATION_FAILED = "Drift data could not be prepared.";

/** A controllable stand-in for the singleton inventory generation store. */
interface MockInventory {
  getInventoryGeneration: () => InventoryGeneration;
  subscribeInventoryGeneration: (listener: () => void) => () => void;
  set(next: InventoryGeneration): void;
  emit(): void;
  listenerCount(): number;
  subscribeCount(): number;
}

function createMockInventory(initial: InventoryGeneration): MockInventory {
  let current = initial;
  const listeners = new Set<() => void>();
  let subscribeCount = 0;
  return {
    getInventoryGeneration: () => current,
    subscribeInventoryGeneration: (listener) => {
      subscribeCount += 1;
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    set(next) {
      current = next;
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
    subscribeCount: () => subscribeCount,
  };
}

type StoreModule = typeof import("../src/features/drift-and-coverage/store.js");
type DiagnosticsModule =
  typeof import("../src/features/drift-and-coverage/diagnostics.js");
type HookModule =
  typeof import("../src/features/drift-and-coverage/use-drift-generation.js");

interface Loaded {
  mock: MockInventory;
  store: StoreModule;
  diagnostics: DiagnosticsModule;
  hook: HookModule;
  // Bound to the same freshly-imported React graph as the hook so effect and
  // re-render flushing stay consistent across the reset module registry.
  h: typeof import("react").createElement;
  mount: typeof import("./support/render.js").mount;
  act: typeof import("./support/render.js").act;
}

async function load(initial: InventoryGeneration = pendingGen(0)): Promise<Loaded> {
  vi.resetModules();
  const mock = createMockInventory(initial);
  vi.doMock(INVENTORY_STORE_PATH, () => ({
    getInventoryGeneration: mock.getInventoryGeneration,
    subscribeInventoryGeneration: mock.subscribeInventoryGeneration,
  }));
  const store = (await import(STORE_PATH)) as StoreModule;
  const diagnostics = (await import(DIAGNOSTICS_PATH)) as DiagnosticsModule;
  const hook = (await import(HOOK_PATH)) as HookModule;
  const react = await import("react");
  const render = await import("./support/render.js");
  return {
    mock,
    store,
    diagnostics,
    hook,
    h: react.createElement,
    mount: render.mount,
    act: render.act,
  };
}

// ---------------------------------------------------------------------------
// Inventory generation fixtures.
// ---------------------------------------------------------------------------

function driftFinding(id = "d-1"): Record<string, unknown> {
  return {
    id,
    severity: "error",
    location: { host: "alpha.invalid" },
    category: "cat.a",
    message: "Invented mismatch",
  };
}

const HOST_STATES = {
  "alpha.invalid": {
    state: "fresh",
    collectedAt: FIXED,
    ageMs: 1_000,
    pastStaleThreshold: false,
  },
} as const;

function availableEnvelope(over: {
  drift?: unknown[];
  hostStates?: Record<string, unknown>;
  generatedAt?: string;
  snapshotBroken?: boolean;
}): unknown {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "fresh", observedAt: FIXED, ageMs: 0, ttlMs: 30_000 },
    data: {
      snapshot: over.snapshotBroken
        ? null
        : {
            schemaVersion: 1,
            generatedAt: over.generatedAt ?? FIXED,
            hosts: [],
            drift: over.drift ?? [],
          },
      findings: [],
      hostStates: over.hostStates ?? {},
      lastReadAt: FIXED,
      readError: null,
    },
    error: null,
  };
}

function baseGen(
  refreshGeneration: number,
  snapshot: unknown,
  transientError: string | null = null,
): InventoryGeneration {
  return Object.freeze({
    config: null,
    configError: null,
    snapshot,
    model: null,
    loading: false,
    refreshGeneration,
    transientError,
  }) as unknown as InventoryGeneration;
}

/** A healthy available generation carrying one finding and one host state. */
function availableGen(
  refreshGeneration: number,
  over: { drift?: unknown[]; hostStates?: Record<string, unknown>; generatedAt?: string } = {},
  transientError: string | null = null,
): InventoryGeneration {
  return baseGen(
    refreshGeneration,
    Object.freeze({
      status: "available",
      envelope: availableEnvelope({
        drift: over.drift ?? [driftFinding()],
        hostStates: over.hostStates ?? HOST_STATES,
        generatedAt: over.generatedAt,
      }),
    }),
    transientError,
  );
}

/** An available generation whose envelope forces deriveDriftProjection to throw. */
function malformedAvailableGen(refreshGeneration: number): InventoryGeneration {
  return baseGen(
    refreshGeneration,
    Object.freeze({
      status: "available",
      envelope: availableEnvelope({ snapshotBroken: true }),
    }),
  );
}

function pendingGen(refreshGeneration = 0, transientError: string | null = null): InventoryGeneration {
  return baseGen(
    refreshGeneration,
    Object.freeze({
      status: "pending",
      envelope: Object.freeze({
        id: "snapshot",
        kind: "snapshot",
        freshness: { state: "pending", observedAt: null, ageMs: null, ttlMs: null },
        data: null,
        error: null,
      }),
    }),
    transientError,
  );
}

function notConfiguredGen(refreshGeneration: number): InventoryGeneration {
  return baseGen(refreshGeneration, Object.freeze({ status: "not-configured" }));
}

function failedEmptyGen(refreshGeneration: number): InventoryGeneration {
  return baseGen(
    refreshGeneration,
    Object.freeze({
      status: "failed-empty",
      envelope: Object.freeze({
        id: "snapshot",
        kind: "snapshot",
        freshness: { state: "unreachable", observedAt: null, ageMs: null, ttlMs: null },
        data: null,
        error: { message: "upstream first-read failed" },
      }),
    }),
  );
}

/** Collect emitted diagnostics through the injectable sink. */
function captureSink(diagnostics: DiagnosticsModule): DriftDiagnosticEvent[] {
  const events: DriftDiagnosticEvent[] = [];
  diagnostics.setDriftDiagnosticSink((event) => events.push(event));
  return events;
}

function deriveEvents(events: DriftDiagnosticEvent[]): DriftDiagnosticEvent[] {
  return events.filter((event) => event.event === "drift.derive");
}

afterEach(() => {
  vi.doUnmock(INVENTORY_STORE_PATH);
  vi.resetModules();
  resetInventoryTestEnv();
});

// ---------------------------------------------------------------------------
// Lazy lifecycle and shared subscription.
// ---------------------------------------------------------------------------

describe("lazy store lifecycle", () => {
  it("starts no inventory subscription until the first drift subscriber", async () => {
    const { mock, store } = await load();
    expect(mock.subscribeCount()).toBe(0);
    expect(mock.listenerCount()).toBe(0);
    // Reading state does not subscribe.
    expect(store.getDriftGeneration().current).toBeNull();
    expect(mock.subscribeCount()).toBe(0);
  });

  it("shares one inventory subscription across many drift subscribers", async () => {
    const { mock, store } = await load();
    const a = store.subscribeDriftGeneration(() => {});
    const b = store.subscribeDriftGeneration(() => {});
    const c = store.subscribeDriftGeneration(() => {});

    // Three drift subscribers, exactly one inventory subscription.
    expect(mock.subscribeCount()).toBe(1);
    expect(mock.listenerCount()).toBe(1);

    a();
    b();
    expect(mock.listenerCount()).toBe(1); // still one subscriber left

    c();
    expect(mock.listenerCount()).toBe(0); // last unsubscribe releases inventory
  });

  it("retains drift state after the last unsubscribe and re-subscribes lazily", async () => {
    const { mock, store } = await load();
    mock.set(availableGen(1));
    const off = store.subscribeDriftGeneration(() => {});
    expect(store.getDriftGeneration().current?.refreshGeneration).toBe(1);

    off();
    expect(mock.listenerCount()).toBe(0);
    // Retained in memory with no active subscription.
    expect(store.getDriftGeneration().current?.refreshGeneration).toBe(1);

    const off2 = store.subscribeDriftGeneration(() => {});
    expect(mock.subscribeCount()).toBe(2); // a fresh inventory subscription
    expect(store.getDriftGeneration().current?.refreshGeneration).toBe(1);
    off2();
  });

  it("idempotent cleanup removes a subscriber only once", async () => {
    const { mock, store } = await load();
    const a = store.subscribeDriftGeneration(() => {});
    const b = store.subscribeDriftGeneration(() => {});
    expect(mock.listenerCount()).toBe(1);
    a();
    a();
    a();
    expect(mock.listenerCount()).toBe(1); // b still active
    b();
    expect(mock.listenerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exact pairing and derive-once semantics.
// ---------------------------------------------------------------------------

describe("exact pairing and single derivation", () => {
  it("derives once and pairs the exact inventory and projection references", async () => {
    const { mock, store, diagnostics } = await load();
    const events = captureSink(diagnostics);
    store.subscribeDriftGeneration(() => {});

    const gen1 = availableGen(1);
    mock.set(gen1);
    mock.emit();

    const state = store.getDriftGeneration();
    expect(state.current).not.toBeNull();
    expect(state.current?.refreshGeneration).toBe(1);
    // The published bundle carries the exact input inventory reference.
    expect(state.current?.inventory).toBe(gen1);
    expect(state.current?.projection.summary.totalFindings).toBe(1);
    expect(state.current?.projection.summary.totalHosts).toBe(1);
    expect(state.derivationError).toBeNull();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.current)).toBe(true);
    expect(deriveEvents(events)).toHaveLength(1);

    // Re-emitting the identical reference derives nothing new.
    mock.emit();
    expect(deriveEvents(events)).toHaveLength(1);
    expect(store.getDriftGeneration().current?.inventory).toBe(gen1);
  });

  it("attempts each available acceptance id at most once", async () => {
    const { mock, store, diagnostics } = await load();
    const events = captureSink(diagnostics);
    store.subscribeDriftGeneration(() => {});

    mock.set(availableGen(1));
    mock.emit();
    mock.set(availableGen(2));
    mock.emit();
    mock.set(availableGen(3));
    mock.emit();

    const derives = deriveEvents(events);
    expect(derives).toHaveLength(3);
    expect(derives.map((event) => event.refreshGeneration)).toEqual([1, 2, 3]);
    expect(derives.every((event) => event.outcome === "ok")).toBe(true);
  });

  it("distinguishes generations that share a repeated source timestamp", async () => {
    const { mock, store, diagnostics } = await load();
    const events = captureSink(diagnostics);
    store.subscribeDriftGeneration(() => {});

    mock.set(availableGen(1, { generatedAt: FIXED }));
    mock.emit();
    mock.set(availableGen(2, { generatedAt: FIXED }));
    mock.emit();

    const derives = deriveEvents(events);
    expect(derives).toHaveLength(2);
    expect(derives.map((event) => event.refreshGeneration)).toEqual([1, 2]);
    for (const event of derives) {
      if (event.event === "drift.derive") {
        expect(event.snapshotGeneratedAt).toBe(FIXED);
      }
    }
    expect(store.getDriftGeneration().current?.refreshGeneration).toBe(2);
  });

  it("emits a derive diagnostic with only allowlisted keys and finite duration", async () => {
    const { mock, store, diagnostics } = await load();
    const events = captureSink(diagnostics);
    store.subscribeDriftGeneration(() => {});
    mock.set(availableGen(1));
    mock.emit();

    const [event] = deriveEvents(events);
    expect(event).toBeDefined();
    expect(Object.keys(event!).sort()).toEqual(
      [
        "durationMs",
        "event",
        "findingsCount",
        "hostCount",
        "outcome",
        "refreshGeneration",
        "snapshotGeneratedAt",
      ].sort(),
    );
    expect(Number.isFinite(event!.durationMs)).toBe(true);
    expect(event!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// State transition table (§4.3).
// ---------------------------------------------------------------------------

describe("availability and failure transition table", () => {
  it("keeps current null for pending, not-configured, and failed-empty states", async () => {
    for (const gen of [pendingGen(0), notConfiguredGen(1), failedEmptyGen(1)]) {
      const { mock, store } = await load();
      store.subscribeDriftGeneration(() => {});
      mock.set(gen);
      mock.emit();
      const state = store.getDriftGeneration();
      expect(state.current).toBeNull();
      expect(state.derivationError).toBeNull();
      expect(state.inventory).toBe(gen);
    }
  });

  it("retains the exact prior bundle on a browser request failure after success", async () => {
    const { mock, store, diagnostics } = await load();
    const events = captureSink(diagnostics);
    store.subscribeDriftGeneration(() => {});

    const gen1 = availableGen(1);
    mock.set(gen1);
    mock.emit();
    const acceptedBundle = store.getDriftGeneration().current;

    // Same acceptance id, retained snapshot, new transientError reference.
    const retained = availableGen(1, {}, "Connection failed; check the deck server.");
    mock.set(retained);
    mock.emit();

    const state = store.getDriftGeneration();
    // Exact prior bundle reference is preserved; no new derivation.
    expect(state.current).toBe(acceptedBundle);
    expect(state.current?.inventory).toBe(gen1);
    expect(state.inventory).toBe(retained);
    expect(state.inventory.transientError).toBe(
      "Connection failed; check the deck server.",
    );
    expect(state.derivationError).toBeNull();
    expect(deriveEvents(events)).toHaveLength(1);
  });

  it("retains the prior bundle and reports a derivation failure, then recovers atomically", async () => {
    const { mock, store, diagnostics } = await load();
    const events = captureSink(diagnostics);
    store.subscribeDriftGeneration(() => {});

    const gen1 = availableGen(1);
    mock.set(gen1);
    mock.emit();
    const acceptedBundle = store.getDriftGeneration().current;

    // A new available generation whose derivation throws.
    mock.set(malformedAvailableGen(2));
    mock.emit();
    let state = store.getDriftGeneration();
    expect(state.current).toBe(acceptedBundle); // exact prior bundle retained
    expect(state.derivationError).toBe(DERIVATION_FAILED);

    const failedDerive = deriveEvents(events).find(
      (event) => event.outcome === "error",
    );
    expect(failedDerive?.refreshGeneration).toBe(2);
    expect(failedDerive?.findingsCount).toBe(0);
    expect(failedDerive?.hostCount).toBe(0);

    // A later available generation recovers and clears the alert atomically.
    const gen3 = availableGen(3);
    mock.set(gen3);
    mock.emit();
    state = store.getDriftGeneration();
    expect(state.current?.refreshGeneration).toBe(3);
    expect(state.current?.inventory).toBe(gen3);
    expect(state.derivationError).toBeNull();
  });

  it("clears current for a genuinely accepted non-available state after available data", async () => {
    const { mock, store } = await load();
    store.subscribeDriftGeneration(() => {});
    mock.set(availableGen(1));
    mock.emit();
    expect(store.getDriftGeneration().current).not.toBeNull();

    const nonAvailable = notConfiguredGen(2);
    mock.set(nonAvailable);
    mock.emit();
    const state = store.getDriftGeneration();
    expect(state.current).toBeNull();
    expect(state.derivationError).toBeNull();
    expect(state.inventory).toBe(nonAvailable);
  });

  it("keeps current null and sets the fixed message when the first derivation fails", async () => {
    const { mock, store, diagnostics } = await load();
    const events = captureSink(diagnostics);
    store.subscribeDriftGeneration(() => {});
    mock.set(malformedAvailableGen(1));
    mock.emit();
    const state = store.getDriftGeneration();
    expect(state.current).toBeNull();
    expect(state.derivationError).toBe(DERIVATION_FAILED);
    // A failed first derivation produces a derive error event and no counts.
    const derive = deriveEvents(events);
    expect(derive).toHaveLength(1);
    expect(derive[0]?.outcome).toBe("error");
    expect(derive[0]?.findingsCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Listener and sink isolation.
// ---------------------------------------------------------------------------

describe("listener and sink isolation", () => {
  it("continues notifying other subscribers when one listener throws", async () => {
    const { mock, store } = await load();
    const calls: string[] = [];
    store.subscribeDriftGeneration(() => {
      calls.push("first");
      throw new Error("secret listener detail");
    });
    store.subscribeDriftGeneration(() => {
      calls.push("second");
    });

    mock.set(availableGen(1));
    expect(() => mock.emit()).not.toThrow();
    expect(calls).toContain("first");
    expect(calls).toContain("second");
    expect(store.getDriftGeneration().current?.refreshGeneration).toBe(1);
  });

  it("isolates a throwing diagnostic sink from store publication", async () => {
    const { mock, store, diagnostics } = await load();
    diagnostics.setDriftDiagnosticSink(() => {
      throw new Error("sink exploded");
    });
    store.subscribeDriftGeneration(() => {});
    mock.set(availableGen(1));
    expect(() => mock.emit()).not.toThrow();
    // Derivation succeeded and published before the emit attempted the sink.
    expect(store.getDriftGeneration().current?.refreshGeneration).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics: allowlisted keys, sink replacement, and bounded dedup.
// ---------------------------------------------------------------------------

describe("diagnostics event allowlist and normalization", () => {
  it("reconstructs derive events with only the allowlisted keys", async () => {
    const { diagnostics } = await load();
    const events = captureSink(diagnostics);
    diagnostics.emitDriftDiagnostic({
      event: "drift.derive",
      outcome: "ok",
      refreshGeneration: 4,
      snapshotGeneratedAt: FIXED,
      findingsCount: 2,
      hostCount: 3,
      durationMs: 1.5,
      // Extra keys that must never survive reconstruction.
      secret: "leak",
      message: "boom",
    } as unknown as DriftDiagnosticEvent);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(
      [
        "durationMs",
        "event",
        "findingsCount",
        "hostCount",
        "outcome",
        "refreshGeneration",
        "snapshotGeneratedAt",
      ].sort(),
    );
    expect((events[0] as Record<string, unknown>).secret).toBeUndefined();
    expect((events[0] as Record<string, unknown>).message).toBeUndefined();
  });

  it("reconstructs render events with only the allowlisted keys", async () => {
    const { diagnostics } = await load();
    const events = captureSink(diagnostics);
    diagnostics.emitDriftDiagnostic({
      event: "drift.render",
      surface: "page",
      outcome: "ok",
      refreshGeneration: 1,
      findingsCount: 5,
      hostCount: 6,
      durationMs: 2,
      snapshotGeneratedAt: "leak",
      host: "alpha.invalid",
    } as unknown as DriftDiagnosticEvent);

    expect(Object.keys(events[0]!).sort()).toEqual(
      [
        "durationMs",
        "event",
        "findingsCount",
        "hostCount",
        "outcome",
        "refreshGeneration",
        "surface",
      ].sort(),
    );
    expect((events[0] as Record<string, unknown>).snapshotGeneratedAt).toBeUndefined();
    expect((events[0] as Record<string, unknown>).host).toBeUndefined();
  });

  it("normalizes non-finite or negative durations to zero and non-string source times to null", async () => {
    const { diagnostics } = await load();
    const events = captureSink(diagnostics);
    diagnostics.emitDriftDiagnostic({
      event: "drift.derive",
      outcome: "error",
      refreshGeneration: 1,
      snapshotGeneratedAt: 12345 as unknown as string,
      findingsCount: 0,
      hostCount: 0,
      durationMs: Number.NaN,
    });
    diagnostics.emitDriftDiagnostic({
      event: "drift.derive",
      outcome: "error",
      refreshGeneration: 2,
      snapshotGeneratedAt: null,
      findingsCount: 0,
      hostCount: 0,
      durationMs: -10,
    });
    expect(events[0]!.durationMs).toBe(0);
    if (events[0]!.event === "drift.derive") {
      expect(events[0]!.snapshotGeneratedAt).toBeNull();
    }
    expect(events[1]!.durationMs).toBe(0);
  });
});

describe("diagnostic sink replacement", () => {
  it("restores the prior sink on cleanup and only if still current", async () => {
    const { diagnostics } = await load();
    const a: DriftDiagnosticEvent[] = [];
    const b: DriftDiagnosticEvent[] = [];
    diagnostics.setDriftDiagnosticSink((event) => a.push(event));
    const restoreB = diagnostics.setDriftDiagnosticSink((event) => b.push(event));

    restoreB();
    diagnostics.emitDriftDiagnostic(sampleDerive());
    expect(b).toHaveLength(0); // B removed
    expect(a).toHaveLength(1); // restored to A

    // Idempotent: calling cleanup again is a no-op.
    restoreB();
    diagnostics.emitDriftDiagnostic(sampleDerive());
    expect(a).toHaveLength(2);
  });

  it("does not let an older cleanup clobber a newer sink", async () => {
    const { diagnostics } = await load();
    const a: DriftDiagnosticEvent[] = [];
    const b: DriftDiagnosticEvent[] = [];
    const restoreA = diagnostics.setDriftDiagnosticSink((event) => a.push(event));
    diagnostics.setDriftDiagnosticSink((event) => b.push(event));

    restoreA(); // stale: must not restore, B is current
    diagnostics.emitDriftDiagnostic(sampleDerive());
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});

describe("render transition deduplication", () => {
  function stateFor(refreshGeneration: number, findings: number, hosts: number): DriftGenerationState {
    return {
      inventory: { refreshGeneration },
      current: {
        refreshGeneration,
        inventory: { refreshGeneration },
        projection: { summary: { totalFindings: findings, totalHosts: hosts } },
      },
      derivationError: null,
    } as unknown as DriftGenerationState;
  }

  it("emits once per surface/generation/outcome and dedupes repeats", async () => {
    const { diagnostics } = await load();
    const events = captureSink(diagnostics);
    const gen1 = stateFor(1, 5, 2);

    diagnostics.reportDriftRenderTransition("page", "ok", gen1, 3);
    diagnostics.reportDriftRenderTransition("page", "ok", gen1, 9); // dedup
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("drift.render");
    if (events[0]?.event === "drift.render") {
      expect(events[0].surface).toBe("page");
      expect(events[0].findingsCount).toBe(5);
      expect(events[0].hostCount).toBe(2);
    }

    // A new failure transition for the same generation emits once, then dedupes.
    diagnostics.reportDriftRenderTransition("page", "error", gen1, 1);
    diagnostics.reportDriftRenderTransition("page", "error", gen1, 1);
    expect(events).toHaveLength(2);

    // A later accepted generation emits a fresh ok transition.
    diagnostics.reportDriftRenderTransition("page", "ok", stateFor(2, 4, 2), 2);
    expect(events).toHaveLength(3);
  });

  it("keeps one latest record per surface, bounded by the four surfaces", async () => {
    const { diagnostics } = await load();
    const events = captureSink(diagnostics);
    const surfaces = ["page", "host-fragment", "service-fragment", "summary"] as const;
    const gen1 = stateFor(1, 0, 0);
    for (const surface of surfaces) {
      diagnostics.reportDriftRenderTransition(surface, "ok", gen1, 1);
    }
    expect(events).toHaveLength(4);
    // Re-reporting each surface's latest transition dedupes entirely.
    for (const surface of surfaces) {
      diagnostics.reportDriftRenderTransition(surface, "ok", gen1, 1);
    }
    expect(events).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Hook lifecycle: shared subscription, no independent work.
// ---------------------------------------------------------------------------

describe("useDriftGeneration hook", () => {
  it("shares one lazy subscription across mounted surfaces and reflects the bundle", async () => {
    const { mock, hook, h, mount, act } = await load(availableGen(1));
    const env: Env = installEnv();
    const seen: DriftGenerationState[] = [];

    const Probe = () => {
      const state = hook.useDriftGeneration();
      seen.push(state);
      return h("span", null, state.current ? "ready" : "empty");
    };
    const tree = h("div", null, h(Probe, {}), h(Probe, {}));

    act(() => {
      mount(tree, env.root as never);
    });

    // Two mounted surfaces, exactly one inventory subscription behind the store.
    expect(mock.subscribeCount()).toBe(1);
    expect((env.root as unknown as { textContent: string }).textContent).toContain(
      "ready",
    );
    expect(seen.at(-1)?.current?.refreshGeneration).toBe(1);

    act(() => {
      mount(null, env.root as never);
    });
    // Unmounting every surface releases the inventory subscription.
    expect(mock.listenerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Security/scope source guards.
// ---------------------------------------------------------------------------

describe("memory-only scope guards", () => {
  it("adds no poller, persistence, analytics, endpoint, or direct derivation call", () => {
    for (const relative of [
      "../src/features/drift-and-coverage/store.ts",
      "../src/features/drift-and-coverage/diagnostics.ts",
      "../src/features/drift-and-coverage/use-drift-generation.ts",
    ]) {
      const source = readFileSync(
        fileURLToPath(new URL(relative, import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/setInterval|setTimeout/);
      for (const api of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "document.cookie",
        "navigator.sendBeacon",
      ]) {
        expect(source).not.toContain(api);
      }
    }
  });
});

function sampleDerive(): DriftDiagnosticEvent {
  return {
    event: "drift.derive",
    outcome: "ok",
    refreshGeneration: 1,
    snapshotGeneratedAt: FIXED,
    findingsCount: 0,
    hostCount: 0,
    durationMs: 1,
  };
}

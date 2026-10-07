// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
// Vite rewrites the literal `new URL("…", import.meta.url)` form into a served-asset
// URL under the jsdom (web) transform; resolving against a plain const avoids that.
const TEST_FILE_URL = import.meta.url;
import { createElement as h } from "react";
import { mount } from "./support/render.js";
import { act } from "./support/render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installEnv, type Env } from "./inventory-harness.js";
import {
  config,
  configResponse,
  deferred,
  failedEmptyState,
  hostDecl,
  httpStatusResponse,
  invalidJsonResponse,
  notConfiguredResponse,
  pendingState,
  serviceDecl,
  snapshotResponse,
  snapshotResult,
  stubFetch,
  resetInventoryTestEnv,
  availableState,
  observedHost,
  observedService,
  hostState,
  type FetchStub,
  type InventoryEndpoint,
} from "./inventory-harness.js";
import type { SnapshotClientState } from "../src/features/hosts-and-services/inventory-store.js";

// ---------------------------------------------------------------------------
// The store is a module singleton; a fresh module per test isolates its retained
// generation, timer, controller, and interval owner. All fixtures are invented.
// ---------------------------------------------------------------------------

type Store = typeof import("../src/features/hosts-and-services/inventory-store.js");

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import("../src/features/hosts-and-services/inventory-store.js");
}

/** Flush all pending fetch/decode microtasks and 0-delay work under real timers. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Handler that answers config and snapshot from fixed per-endpoint factories. */
type EndpointFactory = (
  callIndex: number,
  init: RequestInit,
) => Response | Promise<Response>;

function stubAggregate(
  configFactory: EndpointFactory,
  snapshotFactory: EndpointFactory,
): FetchStub {
  return stubFetch((endpoint: InventoryEndpoint, callIndex, init) =>
    endpoint === "config"
      ? configFactory(callIndex, init)
      : snapshotFactory(callIndex, init),
  );
}

/** The default happy aggregate: a one-host config and an available snapshot. */
function availableAggregate(): FetchStub {
  const cfg = config([hostDecl("alpha")]);
  const state = availableState(
    snapshotResult({
      hosts: [observedHost("alpha")],
      services: [observedService("alpha", "web")],
      hostStates: { alpha: hostState("fresh") },
    }),
  );
  return stubAggregate(
    () => configResponse(cfg),
    () => snapshotResponse(state),
  );
}

afterEach(() => {
  resetInventoryTestEnv();
});

// ---------------------------------------------------------------------------
// 10.1 Store lifecycle and concurrency
// ---------------------------------------------------------------------------

describe("store lifecycle and concurrency", () => {
  it("reads generation zero without issuing any fetch", async () => {
    const stub = availableAggregate();
    const store = await freshStore();

    const initial = store.getInventoryGeneration();
    expect(initial.refreshGeneration).toBe(0);
    expect(initial.loading).toBe(true);
    expect(initial.config).toBeNull();
    expect(initial.model).toBeNull();
    expect(initial.transientError).toBeNull();
    expect(initial.snapshot.status).toBe("pending");
    expect(stub.configCalls).toBe(0);
    expect(stub.snapshotCalls).toBe(0);

    // Repeated reads return the same immutable reference.
    expect(store.getInventoryGeneration()).toBe(initial);
  });

  it("first subscription issues exactly one immediate aggregate pair", async () => {
    const stub = availableAggregate();
    const store = await freshStore();

    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();

    expect(stub.configCalls).toBe(1);
    expect(stub.snapshotCalls).toBe(1);
    for (const call of stub.calls) {
      expect(call.init.method).toBe("GET");
    }
    expect(store.getInventoryGeneration().refreshGeneration).toBe(1);
    unsubscribe();
  });

  it("shares one pair among multiple same-interval subscribers", async () => {
    const stub = availableAggregate();
    const store = await freshStore();

    const a = store.subscribeInventoryGeneration(() => {});
    const b = store.subscribeInventoryGeneration(() => {});
    const c = store.subscribeInventoryGenerationAtInterval(
      () => {},
      30_000,
    );
    await settle();

    // The later subscriptions add no immediate request and no second timer.
    expect(stub.configCalls).toBe(1);
    expect(stub.snapshotCalls).toBe(1);
    a();
    b();
    c();
  });

  it("shares one timer so an interval tick issues a single pair", async () => {
    vi.useFakeTimers();
    const stub = availableAggregate();
    const store = await freshStore();

    const a = store.subscribeInventoryGeneration(() => {});
    const b = store.subscribeInventoryGeneration(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.configCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    // One shared timer produced exactly one additional aggregate pair.
    expect(stub.configCalls).toBe(2);
    expect(stub.snapshotCalls).toBe(2);
    a();
    b();
  });

  it("throws the exact conflict RangeError for a different interval and changes nothing", async () => {
    const stub = availableAggregate();
    const store = await freshStore();

    const unsubscribe = store.subscribeInventoryGenerationAtInterval(
      () => {},
      30_000,
    );
    await settle();
    const callsBefore = stub.configCalls;

    expect(() =>
      store.subscribeInventoryGenerationAtInterval(() => {}, 15_000),
    ).toThrow(
      new RangeError(
        "Inventory store already has a different active poll interval.",
      ),
    );
    expect(stub.configCalls).toBe(callsBefore);
    unsubscribe();
  });

  it("rejects a non-finite or non-positive interval before starting work", async () => {
    const stub = availableAggregate();
    const store = await freshStore();

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        store.subscribeInventoryGenerationAtInterval(() => {}, bad),
      ).toThrow(new RangeError("intervalMs must be a positive finite number."));
    }
    expect(stub.configCalls).toBe(0);
  });

  it("retains the accepted reference through an idempotent last unsubscribe", async () => {
    const stub = availableAggregate();
    const store = await freshStore();

    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();
    const accepted = store.getInventoryGeneration();
    expect(accepted.refreshGeneration).toBe(1);

    unsubscribe();
    unsubscribe(); // idempotent
    expect(store.getInventoryGeneration()).toBe(accepted);

    // A stopped store issues no further requests when timers advance.
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stub.configCalls).toBe(1);
  });

  it("lets a later first subscriber read retained state and refresh again", async () => {
    const store = await freshStore();
    let snapshotState: SnapshotClientState = pendingState();
    const stub = stubAggregate(
      () => configResponse(config([hostDecl("alpha")])),
      () => snapshotResponse(snapshotState),
    );

    const first = store.subscribeInventoryGeneration(() => {});
    await settle();
    const retained = store.getInventoryGeneration();
    expect(retained.refreshGeneration).toBe(1);
    first();

    // The retained generation is still readable while nobody subscribes.
    expect(store.getInventoryGeneration()).toBe(retained);

    snapshotState = availableState(snapshotResult({ hosts: [observedHost("alpha")] }));
    const second = store.subscribeInventoryGenerationAtInterval(() => {}, 15_000);
    await settle();
    const refreshed = store.getInventoryGeneration();
    expect(refreshed.refreshGeneration).toBe(2);
    expect(refreshed.snapshot.status).toBe("available");
    expect(stub.configCalls).toBe(2);
    second();
  });

  it("suppresses an abort-ignoring completion from a superseded poll", async () => {
    vi.useFakeTimers();
    const store = await freshStore();
    const firstConfig = deferred<Response>();
    const firstSnapshot = deferred<Response>();
    const stub = stubAggregate(
      (callIndex) =>
        callIndex === 0
          ? firstConfig.promise
          : configResponse(config([hostDecl("beta")])),
      (callIndex) =>
        callIndex === 0
          ? firstSnapshot.promise
          : snapshotResponse(
              availableState(snapshotResult({ hosts: [observedHost("beta")] })),
            ),
    );

    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getInventoryGeneration().refreshGeneration).toBe(0);

    // The interval fires a second poll that aborts and supersedes the first.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stub.configCalls).toBe(2);
    expect(store.getInventoryGeneration().refreshGeneration).toBe(1);

    // The first poll now resolves despite the abort; it must publish nothing.
    firstConfig.resolve(configResponse(config([hostDecl("stale")])));
    firstSnapshot.resolve(snapshotResponse(pendingState()));
    await vi.advanceTimersByTimeAsync(0);
    const current = store.getInventoryGeneration();
    expect(current.refreshGeneration).toBe(1);
    expect(current.snapshot.status).toBe("available");
    unsubscribe();
  });

  it("accepts only the current request token for out-of-order completions", async () => {
    vi.useFakeTimers();
    const store = await freshStore();
    const firstConfig = deferred<Response>();
    const firstSnapshot = deferred<Response>();
    const stub = stubAggregate(
      (callIndex) =>
        callIndex === 0
          ? firstConfig.promise
          : configResponse(config([hostDecl("current")])),
      (callIndex) =>
        callIndex === 0
          ? firstSnapshot.promise
          : snapshotResponse(pendingState()),
    );

    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await vi.advanceTimersByTimeAsync(0);

    // Newer poll completes first and is accepted as generation 1 (pending).
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getInventoryGeneration().refreshGeneration).toBe(1);
    expect(store.getInventoryGeneration().snapshot.status).toBe("pending");

    // The older, out-of-order completion cannot replace or clear it.
    firstConfig.resolve(httpStatusResponse(500));
    firstSnapshot.resolve(httpStatusResponse(500));
    await vi.advanceTimersByTimeAsync(0);
    const current = store.getInventoryGeneration();
    expect(current.refreshGeneration).toBe(1);
    expect(current.transientError).toBeNull();
    expect(stub.configCalls).toBe(2);
    unsubscribe();
  });

  it("prevents publication when unsubscribe happens during a request", async () => {
    const store = await freshStore();
    const cfg = deferred<Response>();
    const snap = deferred<Response>();
    const stub = stubAggregate(
      () => cfg.promise,
      () => snap.promise,
    );

    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    unsubscribe();

    cfg.resolve(configResponse(config([hostDecl("alpha")])));
    snap.resolve(snapshotResponse(pendingState()));
    await settle();

    expect(store.getInventoryGeneration().refreshGeneration).toBe(0);
    expect(stub.configCalls).toBe(1);
  });

  it("gives duplicate callback subscriptions independent ownership", async () => {
    vi.useFakeTimers();
    const stub = availableAggregate();
    const store = await freshStore();
    const listener = vi.fn();

    const first = store.subscribeInventoryGeneration(listener);
    const second = store.subscribeInventoryGeneration(listener);
    await vi.advanceTimersByTimeAsync(0);
    listener.mockClear();

    // Removing one of the two records keeps polling active.
    first();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stub.configCalls).toBe(2);
    expect(listener).toHaveBeenCalled();

    // Removing the second record stops polling.
    second();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stub.configCalls).toBe(2);
  });

  it("continues notifying after one listener throws and never rolls back", async () => {
    const store = await freshStore();
    availableAggregate();
    const report = vi.fn();
    vi.stubGlobal("reportError", report);

    const order: string[] = [];
    const bad = () => {
      order.push("bad");
      throw new Error("listener boom");
    };
    const good = () => {
      order.push("good");
    };
    const first = store.subscribeInventoryGeneration(bad);
    const second = store.subscribeInventoryGeneration(good);
    await settle();

    expect(order).toContain("bad");
    expect(order).toContain("good");
    expect(report).toHaveBeenCalled();
    expect(store.getInventoryGeneration().refreshGeneration).toBe(1);
    first();
    second();
  });
});

// ---------------------------------------------------------------------------
// 10.2 Classification and retention
// ---------------------------------------------------------------------------

describe("classification and retention", () => {
  async function acceptOnce(state: SnapshotClientState): Promise<Store> {
    const store = await freshStore();
    stubAggregate(
      () => configResponse(config([hostDecl("alpha")])),
      () => snapshotResponse(state),
    );
    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();
    unsubscribe();
    return store;
  }

  it("accepts 404 not-configured as one complete generation", async () => {
    const store = await freshStore();
    stubAggregate(
      () => configResponse(config([hostDecl("alpha")])),
      () => notConfiguredResponse(),
    );
    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();
    const gen = store.getInventoryGeneration();
    expect(gen.refreshGeneration).toBe(1);
    expect(gen.snapshot.status).toBe("not-configured");
    expect(gen.model).not.toBeNull();
    expect(gen.transientError).toBeNull();
    unsubscribe();
  });

  it("accepts pending, failed-empty, and available with a matching model", async () => {
    const pending = await acceptOnce(pendingState());
    expect(pending.getInventoryGeneration().snapshot.status).toBe("pending");
    expect(pending.getInventoryGeneration().model).not.toBeNull();

    const failed = await acceptOnce(failedEmptyState("upstream unavailable"));
    expect(failed.getInventoryGeneration().snapshot.status).toBe("failed-empty");

    const available = await acceptOnce(
      availableState(snapshotResult({ hosts: [observedHost("alpha")] })),
    );
    const gen = available.getInventoryGeneration();
    expect(gen.snapshot.status).toBe("available");
    expect(gen.model?.hosts.length).toBe(1);
    expect(gen.refreshGeneration).toBe(1);
  });

  it("produces only fixed safe messages for each config/snapshot failure class", async () => {
    const cases: Array<{ config: EndpointFactory; snapshot: EndpointFactory; expected: string }> = [
      {
        config: () => httpStatusResponse(503),
        snapshot: () => snapshotResponse(pendingState()),
        expected: "Config request returned HTTP 503; check the deck server.",
      },
      {
        config: () => Promise.reject(new TypeError("network down")),
        snapshot: () => snapshotResponse(pendingState()),
        expected: "Config request failed; check the deck server connection.",
      },
      {
        config: () => invalidJsonResponse(),
        snapshot: () => snapshotResponse(pendingState()),
        expected: "Config response is invalid; check the deck server.",
      },
      {
        config: () => configResponse(config([hostDecl("alpha")])),
        snapshot: () => httpStatusResponse(500),
        expected: "Snapshot request returned HTTP 500; check the deck server.",
      },
      {
        config: () => configResponse(config([hostDecl("alpha")])),
        snapshot: () => Promise.reject(new TypeError("network down")),
        expected: "Snapshot request failed; check the deck server connection.",
      },
      {
        config: () => configResponse(config([hostDecl("alpha")])),
        snapshot: () => invalidJsonResponse(),
        expected: "Snapshot response is invalid; check the deck server.",
      },
    ];

    for (const testCase of cases) {
      const store = await freshStore();
      stubAggregate(testCase.config, testCase.snapshot);
      const unsubscribe = store.subscribeInventoryGeneration(() => {});
      await settle();
      const gen = store.getInventoryGeneration();
      expect(gen.transientError).toBe(testCase.expected);
      expect(gen.refreshGeneration).toBe(0);
      unsubscribe();
      resetInventoryTestEnv();
    }
  });

  it("prefers the config failure message when both sides fail", async () => {
    const store = await freshStore();
    stubAggregate(
      () => httpStatusResponse(500),
      () => httpStatusResponse(502),
    );
    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();
    expect(store.getInventoryGeneration().transientError).toBe(
      "Config request returned HTTP 500; check the deck server.",
    );
    unsubscribe();
  });

  it("records a first client failure as generation zero with no model", async () => {
    const store = await freshStore();
    stubAggregate(
      () => httpStatusResponse(500),
      () => snapshotResponse(pendingState()),
    );
    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();
    const gen = store.getInventoryGeneration();
    expect(gen.refreshGeneration).toBe(0);
    expect(gen.loading).toBe(false);
    expect(gen.model).toBeNull();
    expect(gen.config).toBeNull();
    expect(gen.transientError).not.toBeNull();
    expect(gen.snapshot.status).toBe("pending");
    unsubscribe();
  });

  it("retains the exact prior bundle on a failure after success, changing only transientError", async () => {
    const store = await freshStore();
    let mode: "ok" | "fail" = "ok";
    stubAggregate(
      () =>
        mode === "ok"
          ? configResponse(config([hostDecl("alpha")]))
          : httpStatusResponse(500),
      () =>
        mode === "ok"
          ? snapshotResponse(
              availableState(snapshotResult({ hosts: [observedHost("alpha")] })),
            )
          : snapshotResponse(pendingState()),
    );
    vi.useFakeTimers();

    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const accepted = store.getInventoryGeneration();
    expect(accepted.refreshGeneration).toBe(1);

    mode = "fail";
    await vi.advanceTimersByTimeAsync(30_000);
    const failed = store.getInventoryGeneration();
    expect(failed).not.toBe(accepted);
    expect(failed.refreshGeneration).toBe(1);
    expect(failed.config).toBe(accepted.config);
    expect(failed.snapshot).toBe(accepted.snapshot);
    expect(failed.model).toBe(accepted.model);
    expect(failed.transientError).toBe(
      "Config request returned HTTP 500; check the deck server.",
    );

    // A repeated identical failure is a reference-preserving no-op.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getInventoryGeneration()).toBe(failed);

    // Recovery increments once, replaces the bundle, and clears the error.
    mode = "ok";
    await vi.advanceTimersByTimeAsync(30_000);
    const recovered = store.getInventoryGeneration();
    expect(recovered.refreshGeneration).toBe(2);
    expect(recovered.transientError).toBeNull();
    expect(recovered.snapshot.status).toBe("available");
    unsubscribe();
  });

  it("treats provider envelope and read errors with data as accepted data", async () => {
    const store = await freshStore();
    const state = availableState(
      snapshotResult({
        hosts: [observedHost("alpha")],
        readError: { code: "READ_TIMEOUT", message: "collector timed out" },
      }),
      { message: "provider degraded" },
    );
    stubAggregate(
      () => configResponse(config([hostDecl("alpha")])),
      () => snapshotResponse(state),
    );
    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();
    const gen = store.getInventoryGeneration();
    expect(gen.refreshGeneration).toBe(1);
    expect(gen.transientError).toBeNull();
    expect(gen.snapshot.status).toBe("available");
    unsubscribe();
  });

  it("passes absent drift, empty collections, and open categories through unchanged", async () => {
    const store = await freshStore();
    const result = snapshotResult({ hosts: [], services: [], findings: [] });
    stubAggregate(
      () => configResponse(config([hostDecl("alpha")], [serviceDecl("alpha", "web")])),
      () => snapshotResponse(availableState(result)),
    );
    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();
    const gen = store.getInventoryGeneration();
    expect(gen.snapshot.status).toBe("available");
    if (gen.snapshot.status === "available") {
      const data = gen.snapshot.envelope.data;
      expect(data).not.toBeNull();
      expect(data?.snapshot).not.toHaveProperty("drift");
      expect(data?.findings).toEqual([]);
    }
    unsubscribe();
  });

  it("deep-freezes accepted responses and never mutates the source object", async () => {
    const store = await freshStore();
    const result = snapshotResult({ hosts: [observedHost("alpha")] });
    stubAggregate(
      () => configResponse(config([hostDecl("alpha")])),
      () => snapshotResponse(availableState(result)),
    );
    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    await settle();
    const gen = store.getInventoryGeneration();
    expect(Object.isFrozen(gen)).toBe(true);
    expect(gen.snapshot.status).toBe("available");
    if (gen.snapshot.status === "available") {
      expect(Object.isFrozen(gen.snapshot.envelope)).toBe(true);
      expect(Object.isFrozen(gen.snapshot.envelope.data)).toBe(true);
      expect(Object.isFrozen(gen.snapshot.envelope.data?.snapshot)).toBe(true);
    }
    // The original invented fixture object is untouched (not frozen by the store).
    expect(Object.isFrozen(result)).toBe(false);
    unsubscribe();
  });

  it("produces no transition or message for an aborted refresh", async () => {
    const store = await freshStore();
    const cfg = deferred<Response>();
    stubAggregate(
      () => cfg.promise,
      () => snapshotResponse(pendingState()),
    );
    const unsubscribe = store.subscribeInventoryGeneration(() => {});
    // Unsubscribe aborts the in-flight request before it settles.
    unsubscribe();
    cfg.resolve(configResponse(config([hostDecl("alpha")])));
    await settle();
    const gen = store.getInventoryGeneration();
    expect(gen.refreshGeneration).toBe(0);
    expect(gen.transientError).toBeNull();
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 10.3 Compatibility and scope (source-level guards)
// ---------------------------------------------------------------------------

describe("compatibility and scope", () => {
  it("re-exports the compatibility surface from the legacy module path", async () => {
    vi.resetModules();
    const legacy = await import(
      "../src/features/hosts-and-services/use-inventory-data.js"
    );
    expect(typeof legacy.useInventoryData).toBe("function");
    expect(typeof legacy.InventoryDataProvider).toBe("function");
    expect(typeof legacy.useInventoryDataContext).toBe("function");
    expect(legacy.InventoryDataContext).toBeDefined();
    expect(legacy.InventoryContextError).toBeDefined();
    expect(legacy.INVENTORY_ENDPOINTS.config).toBe("/api/config");
    expect(legacy.INVENTORY_ENDPOINTS.snapshot).toBe("/api/providers/snapshot");
    expect(legacy.INITIAL_SNAPSHOT_ENVELOPE.data).toBeNull();
  });

  it("throws InventoryContextError with its fixed code", async () => {
    vi.resetModules();
    const legacy = await import(
      "../src/features/hosts-and-services/use-inventory-data.js"
    );
    const error = new legacy.InventoryContextError();
    expect(error.name).toBe("InventoryContextError");
    expect(error.code).toBe("INVENTORY_CONTEXT_MISSING");
  });

  it("shares one singleton poll across two mounted providers", async () => {
    const stub = availableAggregate();
    vi.resetModules();
    const legacy = await import(
      "../src/features/hosts-and-services/use-inventory-data.js"
    );
    const env: Env = installEnv();
    const tree = h(legacy.InventoryDataProvider, {
      children: h(legacy.InventoryDataProvider, { children: null }),
    });
    act(() => {
      mount(tree, env.root as never);
    });
    await settle();

    // Two providers each subscribe, but they share exactly one aggregate pair.
    expect(stub.configCalls).toBe(1);
    expect(stub.snapshotCalls).toBe(1);

    act(() => {
      mount(null, env.root as never);
    });
  });

  it("validates a non-positive interval during hook render", async () => {
    availableAggregate();
    vi.resetModules();
    const legacy = await import(
      "../src/features/hosts-and-services/use-inventory-data.js"
    );
    const env: Env = installEnv();
    const Probe = () => {
      legacy.useInventoryData(0);
      return null;
    };
    expect(() =>
      act(() => {
        mount(h(Probe, {}), env.root as never);
      }),
    ).toThrow(new RangeError("intervalMs must be a positive finite number."));
  });

  it("throws InventoryContextError when reading context outside a provider", async () => {
    vi.resetModules();
    const legacy = await import(
      "../src/features/hosts-and-services/use-inventory-data.js"
    );
    const env: Env = installEnv();
    const Probe = () => {
      legacy.useInventoryDataContext();
      return null;
    };
    expect(() =>
      act(() => {
        mount(h(Probe, {}), env.root as never);
      }),
    ).toThrow(legacy.InventoryContextError);
  });

  it("uses only the two fixed GET endpoints and no browser persistence API", () => {
    const storePath = fileURLToPath(
      new URL(
        "../src/features/hosts-and-services/inventory-store.ts",
        TEST_FILE_URL,
      ),
    );
    const source = readFileSync(storePath, "utf8");

    // Exactly the two fixed endpoint literals appear.
    expect(source).toContain('config: "/api/config"');
    expect(source).toContain('snapshot: "/api/providers/snapshot"');
    expect(source).not.toMatch(/\/api\/(?!config|providers\/snapshot)/);

    // Only GET requests.
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(source).not.toContain(`method: "${verb}"`);
    }
    expect(source).toContain('method: "GET"');

    // No browser persistence or durable store.
    for (const api of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "IndexedDB",
      "document.cookie",
    ]) {
      expect(source).not.toContain(api);
    }
  });
});

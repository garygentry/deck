// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
// Vite rewrites the literal `new URL("…", import.meta.url)` form into a served-asset
// URL under the jsdom (web) transform; resolving against a plain const avoids that.
const TEST_FILE_URL = import.meta.url;
import { createElement as h } from "react";
import { mount } from "./support/render.js";
import type { ReactNode } from "react";
import { useState } from "react";
import { act } from "./support/render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetQueryClient } from "../src/data/query-client.js";
import {
  INITIAL_SNAPSHOT_ENVELOPE,
  INVENTORY_ENDPOINTS,
  InventoryContextError,
  InventoryDataProvider,
  useInventoryData,
  useInventoryDataContext,
} from "../../../modules/inventory/web/use-inventory-data.js";
import type {
  InventoryData,
  InventoryGeneration,
  SnapshotClientState,
} from "../../../modules/inventory/web/use-inventory-data.js";
import {
  buildInventoryModel,
  compareOrdinal,
  findHost,
  findService,
  hostHref,
  serviceHref,
} from "../../../modules/inventory/web/model.js";
import type {
  HostRow,
  InventoryModel,
  ServiceRow,
} from "../../../modules/inventory/web/model.js";
import {
  NO_HOST_FILTERS,
  NO_SERVICE_FILTERS,
  filterHosts,
  filterServices,
} from "../../../modules/inventory/web/search-filter.js";
import type {
  HostFilterCriteria,
  ServiceFilterCriteria,
} from "../../../modules/inventory/web/search-filter.js";
import type {
  Host,
  ObservedHost,
  ObservedService,
  Service,
} from "@deck/schema";
import type { HostState, SnapshotProviderResult } from "@deck/contract";
import type { DeckConfig } from "@deck/server";

// ---------------------------------------------------------------------------
// Response and fetch helpers.
// ---------------------------------------------------------------------------

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function invalidJsonResponse(status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  };
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
  });
}

type Responder = (signal: AbortSignal) => Promise<FakeResponse> | FakeResponse;

interface FetchHarness {
  setConfig(responder: Responder): void;
  setSnapshot(responder: Responder): void;
  calls: { url: string; init: RequestInit }[];
}

function installFetch(): FetchHarness {
  let configResponder: Responder = () => jsonResponse(200, validConfig());
  let snapshotResponder: Responder = () => jsonResponse(200, pendingEnvelope());
  const calls: { url: string; init: RequestInit }[] = [];
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    // The UI manifest is infrastructure, not an aggregate poll: answer it with
    // the registered providers (snapshot present) and keep it out of `calls`.
    if (url === "/api/ui") {
      return jsonResponse(200, { providers: [{ id: "snapshot", kind: "snapshot" }] });
    }
    calls.push({ url, init });
    const signal = init.signal as AbortSignal;
    if (url === INVENTORY_ENDPOINTS.config) return configResponder(signal);
    if (url === INVENTORY_ENDPOINTS.snapshot) return snapshotResponder(signal);
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return {
    calls,
    setConfig: (responder) => {
      configResponder = responder;
    },
    setSnapshot: (responder) => {
      snapshotResponder = responder;
    },
  };
}

/** A fetch that never resolves until its signal aborts, then rejects AbortError. */
function pending(signal: AbortSignal): Promise<FakeResponse> {
  return new Promise<FakeResponse>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortError()));
  });
}

// ---------------------------------------------------------------------------
// Fixture bodies.
// ---------------------------------------------------------------------------

function validConfig(name = "Estate"): Record<string, unknown> {
  return {
    schemaVersion: 2,
    estate: { name },
    hosts: [{ name: "h1", kind: "bare-metal", purpose: "primary" }],
    services: [{ name: "s1", host: "h1", kind: "external", purpose: "svc" }],
  };
}

function snapshotResult(): Record<string, unknown> {
  return {
    snapshot: {
      schemaVersion: 1,
      generatedAt: "2030-01-01T00:00:00.000Z",
      hosts: [{ name: "h1", coverage: "collected", collectedAt: "2030-01-01T00:00:00.000Z" }],
      services: [{ host: "h1", name: "s1", state: "running" }],
      drift: [{ id: "d1", severity: "warning", category: "config", message: "drift note" }],
    },
    findings: [],
    hostStates: {
      h1: { state: "fresh", collectedAt: "2030-01-01T00:00:00.000Z", ageMs: 1000, pastStaleThreshold: false },
    },
    lastReadAt: "2030-01-01T00:00:00.000Z",
    readError: null,
  };
}

function availableEnvelope(error: { message: string } | null = null): Record<string, unknown> {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "fresh", observedAt: "2030-01-01T00:00:00.000Z", ageMs: 1, ttlMs: 60000 },
    data: snapshotResult(),
    error,
  };
}

function pendingEnvelope(): Record<string, unknown> {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "pending", observedAt: null, ageMs: null, ttlMs: null },
    data: null,
    error: null,
  };
}

function failedEmptyEnvelope(): Record<string, unknown> {
  return { ...pendingEnvelope(), error: { message: "first poll failed" } };
}

// ---------------------------------------------------------------------------
// Hook mount harness.
// ---------------------------------------------------------------------------

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

interface MountedProbe {
  values: InventoryData[];
  last(): InventoryData;
  rerender(): Promise<void>;
  unmount(): void;
}

/**
 * Mount a provider with a consuming probe; capture every committed value.
 *
 * The inventory store is a module singleton that retains its last accepted
 * generation across mounts, so each probe resets the module graph and mounts
 * against a fresh store. This isolates one mount's poll lifecycle exactly as the
 * former per-hook state machine did, using the same fresh compatibility module
 * for both the provider and the consumer context.
 */
async function mountProbe(intervalMs?: number): Promise<MountedProbe> {
  vi.resetModules();
  const {
    InventoryDataProvider: FreshProvider,
    useInventoryDataContext: useFreshContext,
  } = await import("../../../modules/inventory/web/use-inventory-data.js");
  const values: InventoryData[] = [];
  let force: (() => void) | undefined;

  function Consumer(): null {
    values.push(useFreshContext());
    return null;
  }
  function Parent(): unknown {
    const [, setN] = useState(0);
    force = () => setN((n) => n + 1);
    return h(
      FreshProvider as never,
      { intervalMs } as never,
      h(Consumer, {}),
    );
  }
  const root = document.createElement("div");
  await act(async () => {
    mount(h(Parent as never, {}), root as never);
  });
  await settle();
  return {
    values,
    last: () => values[values.length - 1]!,
    rerender: async () => {
      await act(async () => {
        force?.();
      });
      await settle();
    },
    unmount: () => {
      act(() => mount(null, root as never));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetQueryClient();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("useInventoryData lifecycle", () => {
  it("polls immediately then once per exactly 30s, reading the config once, GET-only", async () => {
    vi.useFakeTimers();
    const fetchH = installFetch();
    const probe = await mountProbe();
    const urls = () => fetchH.calls.map((c) => c.url);
    const snapshotSignals = () =>
      fetchH.calls.filter((c) => c.url === INVENTORY_ENDPOINTS.snapshot).map((c) => c.init.signal);

    // Immediate aggregate poll: one config GET and one snapshot GET.
    expect([...urls()].sort()).toEqual([INVENTORY_ENDPOINTS.config, INVENTORY_ENDPOINTS.snapshot].sort());
    // GET only; no request body or mutating method.
    for (const { init } of fetchH.calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
    }

    // No further poll before 30s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(fetchH.calls).toHaveLength(2);
    // Exactly at 30s the second generation fires: the snapshot again, the config from cache.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(urls()).toHaveLength(3);
    expect(urls().filter((url) => url === INVENTORY_ENDPOINTS.config)).toHaveLength(1);
    // The second generation uses a fresh, different signal.
    expect(snapshotSignals()).toHaveLength(2);
    expect(snapshotSignals()[1]).not.toBe(snapshotSignals()[0]);

    probe.unmount();
  });

  it("honours an injected interval and validates it", async () => {
    vi.useFakeTimers();
    const fetchH = installFetch();
    const probe = await mountProbe(1000);
    expect(fetchH.calls).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // One more snapshot poll; the config is read once.
    expect(fetchH.calls).toHaveLength(3);
    expect(fetchH.calls[2]!.url).toBe(INVENTORY_ENDPOINTS.snapshot);
    probe.unmount();

    expect(() => useInventoryData(0)).toThrow(RangeError);
    expect(() => useInventoryData(-5)).toThrow(RangeError);
    expect(() => useInventoryData(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => useInventoryData(Number.NaN)).toThrow(RangeError);
  });
});

describe("snapshot HTTP classification", () => {
  interface Case {
    name: string;
    responder: Responder;
    expected: (data: InventoryGeneration) => void;
  }

  const cases: Case[] = [
    {
      name: "404 -> not-configured (regardless of body)",
      responder: () => jsonResponse(404, { anything: true }),
      expected: (d) => expect(d.snapshot).toEqual({ status: "not-configured" }),
    },
    {
      // A first-poll request failure is a retained transient error, not an
      // accepted `snapshot:request-error` generation (store §5.4).
      name: "other non-2xx -> transient error with decimal status",
      responder: () => jsonResponse(503, {}),
      expected: (d) => {
        expect(d.transientError).toBe(
          "Snapshot request returned HTTP 503; check the deck server.",
        );
        expect(d.snapshot.status).toBe("pending");
        expect(d.refreshGeneration).toBe(0);
      },
    },
    {
      name: "transport failure -> transient error",
      responder: () => {
        throw new TypeError("Failed to fetch");
      },
      expected: (d) => {
        expect(d.transientError).toBe(
          "Snapshot request failed; check the deck server connection.",
        );
        expect(d.snapshot.status).toBe("pending");
      },
    },
    {
      name: "invalid JSON -> transient error (decode)",
      responder: () => invalidJsonResponse(),
      expected: (d) => {
        expect(d.transientError).toBe(
          "Snapshot response is invalid; check the deck server.",
        );
        expect(d.snapshot.status).toBe("pending");
      },
    },
    {
      name: "malformed envelope -> transient error (decode)",
      responder: () => jsonResponse(200, { id: "snapshot", kind: "wrong" }),
      expected: (d) => {
        expect(d.transientError).toBe(
          "Snapshot response is invalid; check the deck server.",
        );
        expect(d.snapshot.status).toBe("pending");
      },
    },
    {
      name: "valid envelope, null data, null error -> pending",
      responder: () => jsonResponse(200, pendingEnvelope()),
      expected: (d) => {
        expect(d.snapshot.status).toBe("pending");
      },
    },
    {
      name: "valid envelope, null data, error present -> failed-empty",
      responder: () => jsonResponse(200, failedEmptyEnvelope()),
      expected: (d) => {
        expect(d.snapshot.status).toBe("failed-empty");
      },
    },
    {
      name: "valid envelope, non-null data, null error -> available",
      responder: () => jsonResponse(200, availableEnvelope(null)),
      expected: (d) => {
        expect(d.snapshot.status).toBe("available");
      },
    },
    {
      name: "non-null data wins even with outer error -> available",
      responder: () => jsonResponse(200, availableEnvelope({ message: "later poll failed" })),
      expected: (d) => {
        expect(d.snapshot.status).toBe("available");
        if (d.snapshot.status === "available") {
          expect(d.snapshot.envelope.error).toEqual({ message: "later poll failed" });
          expect(d.snapshot.envelope.data?.snapshot).toBeTruthy();
        }
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const fetchH = installFetch();
      fetchH.setSnapshot(testCase.responder);
      const probe = await mountProbe(1000);
      testCase.expected(probe.last() as InventoryGeneration);
      probe.unmount();
    });
  }

  it("reports a first-poll config failure as a retained transient error", async () => {
    const fetchH = installFetch();
    fetchH.setConfig(() => jsonResponse(500, {}));
    fetchH.setSnapshot(() => jsonResponse(200, availableEnvelope(null)));
    const probe = await mountProbe(1000);
    // A failed config side means no accepted generation: the successful snapshot
    // side is discarded and only the sanitized transient error is published.
    const data = probe.last() as InventoryGeneration;
    expect(data.config).toBeNull();
    expect(data.model).toBeNull();
    expect(data.refreshGeneration).toBe(0);
    expect(data.transientError).toBe(
      "Config request returned HTTP 500; check the deck server.",
    );
    expect(data.snapshot.status).toBe("pending");
    probe.unmount();
  });
});

describe("atomic commit, retention, and concurrency", () => {
  it("keeps the previous model visible during a background refresh", async () => {
    vi.useFakeTimers();
    const fetchH = installFetch();
    fetchH.setSnapshot(() => jsonResponse(200, availableEnvelope(null)));
    const probe = await mountProbe();
    const first = probe.last();
    expect(first.loading).toBe(false);
    expect(first.model).not.toBeNull();

    // Next generation stalls both endpoints.
    fetchH.setConfig((signal) => pending(signal));
    fetchH.setSnapshot((signal) => pending(signal));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // Background poll is in flight: previous model stays, loading stays false.
    const during = probe.last();
    expect(during.model).toBe(first.model);
    expect(during.loading).toBe(false);
    probe.unmount();
  });

  it("suppresses a superseded generation and never commits its result", async () => {
    vi.useFakeTimers();
    const fetchH = installFetch();
    let capturedSignal: AbortSignal | undefined;
    // Generation A stalls on its snapshot until aborted (the config resolves).
    fetchH.setSnapshot((signal) => {
      capturedSignal = signal;
      return pending(signal);
    });
    const probe = await mountProbe();
    expect(probe.last().config).toBeNull(); // still cold-start pending

    // Generation B resolves cleanly.
    fetchH.setSnapshot(() => jsonResponse(200, availableEnvelope(null)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await settle();

    expect(capturedSignal?.aborted).toBe(true);
    const data = probe.last();
    expect(data.config?.estate.name).toBe("Estate");
    probe.unmount();
  });

  it("aborts in-flight work on unmount and commits nothing further", async () => {
    const fetchH = installFetch();
    let capturedSignal: AbortSignal | undefined;
    fetchH.setSnapshot((signal) => {
      capturedSignal = signal;
      return pending(signal);
    });
    const probe = await mountProbe(1000);
    const before = probe.values.length;
    probe.unmount();
    await settle();
    expect(capturedSignal?.aborted).toBe(true);
    expect(probe.values.length).toBe(before);
  });
});

describe("immutability and completeness", () => {
  it("recursively freezes config and envelope while preserving the whole snapshot", async () => {
    const fetchH = installFetch();
    fetchH.setSnapshot(() => jsonResponse(200, availableEnvelope({ message: "later" })));
    const probe = await mountProbe(1000);
    const data = probe.last();

    expect(Object.isFrozen(data.config)).toBe(true);
    expect(Object.isFrozen(data.config?.estate)).toBe(true);
    expect(data.snapshot.status).toBe("available");
    if (data.snapshot.status === "available") {
      const envelope = data.snapshot.envelope;
      const result = envelope.data;
      expect(result).not.toBeNull();
      expect(Object.isFrozen(envelope)).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result!.snapshot)).toBe(true);
      expect(Object.isFrozen(result!.findings)).toBe(true);
      expect(Object.isFrozen(result!.hostStates)).toBe(true);
      // Untouched snapshot retains drift and open reality.
      const snapshot = result!.snapshot as { drift?: unknown[] };
      expect(Array.isArray(snapshot.drift)).toBe(true);
      expect(snapshot.drift).toHaveLength(1);
      // Ordinary mutation is rejected.
      expect(() => {
        (result as { lastReadAt: string }).lastReadAt = "changed";
      }).toThrow();
    }
    probe.unmount();
  });

  it("never calls validateSnapshot from browser code", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../modules/inventory/web/use-inventory-data.tsx",
          TEST_FILE_URL,
        ),
      ),
      "utf8",
    );
    expect(source).not.toContain("validateSnapshot");
  });

  it("exposes a frozen initial pending envelope and frozen endpoints", () => {
    expect(Object.isFrozen(INVENTORY_ENDPOINTS)).toBe(true);
    expect(Object.isFrozen(INITIAL_SNAPSHOT_ENVELOPE)).toBe(true);
    expect(INITIAL_SNAPSHOT_ENVELOPE.data).toBeNull();
    expect(INITIAL_SNAPSHOT_ENVELOPE.freshness.state).toBe("pending");
  });
});

describe("context and memoization", () => {
  it("throws InventoryContextError when read outside a provider", () => {
      function Orphan(): null {
      useInventoryDataContext();
      return null;
    }
    const root = document.createElement("div");
    expect(() => {
      act(() => mount(h(Orphan, {}), root as never));
    }).toThrow(InventoryContextError);
  });

  it("shares one memoized InventoryData/model identity across a subtree and rerenders", async () => {
      const fetchH = installFetch();
    fetchH.setSnapshot(() => jsonResponse(200, availableEnvelope(null)));
    const captured: { a?: InventoryData; b?: InventoryData } = {};
    let force: (() => void) | undefined;

    function A(): null {
      captured.a = useInventoryDataContext();
      return null;
    }
    function B(): null {
      captured.b = useInventoryDataContext();
      return null;
    }
    function Parent(): unknown {
      const [, setN] = useState(0);
      force = () => setN((n) => n + 1);
      return h(
        InventoryDataProvider as never,
        {} as never,
        h(A, {}),
        h(B, {}),
      );
    }
    const root = document.createElement("div");
    await act(async () => {
      mount(h(Parent as never, {}), root as never);
    });
    await settle();

    // One provider subtree hands both consumers the same identity.
    expect(captured.a).toBe(captured.b);
    const firstData = captured.a!;
    const firstModel = firstData.model;
    expect(firstModel).not.toBeNull();

    // A rerender with no new generation reuses the same data and model identity.
    await act(async () => {
      force?.();
    });
    await settle();
    expect(captured.a).toBe(firstData);
    expect(captured.a?.model).toBe(firstModel);

    act(() => mount(null, root as never));
  });
});

// ===========================================================================
// buildInventoryModel — immutable normalization (item 012)
// ===========================================================================

// --- Pure model fixture builders (no DOM/fetch) ----------------------------

function host(name: string, extra: Partial<Host> = {}): Host {
  return { name, kind: "vm", purpose: `purpose ${name}`, ...extra };
}

function service(hostName: string, name: string, extra: Partial<Service> = {}): Service {
  return { name, host: hostName, kind: "external", purpose: `svc ${name}`, ...extra };
}

function configOf(hosts: Host[] = [], services: Service[] = []): DeckConfig {
  return { schemaVersion: 2, estate: { name: "Estate" }, hosts, services };
}

function observedHost(name: string, extra: Partial<ObservedHost> = {}): ObservedHost {
  return {
    name,
    coverage: "collected",
    collectedAt: "2030-01-01T00:00:00.000Z",
    ...extra,
  } as ObservedHost;
}

function observedService(
  hostName: string,
  name: string,
  state: ObservedService["state"] = "running",
): ObservedService {
  return { host: hostName, name, state };
}

function freshState(over: Partial<HostState> = {}): HostState {
  return {
    state: "fresh",
    collectedAt: "2030-01-01T00:00:00.000Z",
    ageMs: 1000,
    pastStaleThreshold: false,
    ...over,
  };
}

interface AvailableInput {
  observedHosts?: ObservedHost[];
  observedServices?: ObservedService[];
  hostStates?: Record<string, HostState>;
  drift?: unknown[];
  outerError?: { message: string } | null;
  readError?: { code: string; message: string } | null;
}

function availableState(input: AvailableInput = {}): SnapshotClientState {
  const result: SnapshotProviderResult = {
    snapshot: {
      schemaVersion: 1,
      generatedAt: "2030-01-01T00:00:00.000Z",
      hosts: input.observedHosts ?? [],
      services: input.observedServices ?? [],
      drift: (input.drift ?? []) as never,
    } as unknown as SnapshotProviderResult["snapshot"],
    findings: [],
    hostStates: input.hostStates ?? {},
    lastReadAt: "2030-01-01T00:00:00.000Z",
    readError: input.readError ?? null,
  };
  return {
    status: "available",
    envelope: {
      id: "snapshot",
      kind: "snapshot",
      freshness: {
        state: "fresh",
        observedAt: "2030-01-01T00:00:00.000Z",
        ageMs: 1,
        ttlMs: 60_000,
      },
      data: result,
      error: input.outerError ?? null,
    },
  };
}

const NON_AVAILABLE_STATES: { name: string; state: SnapshotClientState }[] = [
  { name: "not-configured", state: { status: "not-configured" } },
  {
    name: "pending",
    state: { status: "pending", envelope: INITIAL_SNAPSHOT_ENVELOPE },
  },
  {
    name: "failed-empty",
    state: {
      status: "failed-empty",
      envelope: { ...INITIAL_SNAPSHOT_ENVELOPE, error: { message: "boom" } },
    },
  },
  {
    name: "request-error",
    state: { status: "request-error", message: "Snapshot request failed." },
  },
];

// --- comparator + href helpers ---------------------------------------------

describe("compareOrdinal and href helpers", () => {
  it("orders by exact code point, not locale", () => {
    // Uppercase precedes lowercase by code point; localeCompare would disagree.
    expect(compareOrdinal("Z", "a")).toBe(-1);
    expect(compareOrdinal("a", "Z")).toBe(1);
    expect(compareOrdinal("a", "a")).toBe(0);
    // Digits precede letters; "10" < "9" by code point.
    expect(compareOrdinal("10", "9")).toBe(-1);
    // Non-ASCII sorts strictly by code unit.
    expect(compareOrdinal("é", "z")).toBe(1);
  });

  it("encodes host and service route segments independently", () => {
    expect(hostHref("alpha")).toBe("/hosts/alpha");
    expect(hostHref("a b/c#d")).toBe("/hosts/a%20b%2Fc%23d");
    expect(serviceHref("alpha", "api")).toBe("/services/alpha/api");
    // A slash in either segment must not create an extra path segment.
    expect(serviceHref("a/b", "c/d")).toBe("/services/a%2Fb/c%2Fd");
    expect(serviceHref("h#", "n%")).toBe("/services/h%23/n%25");
    expect(serviceHref("café", "réseau")).toBe(
      "/services/caf%C3%A9/r%C3%A9seau",
    );
  });
});

// --- joins, counts, and identity -------------------------------------------

describe("buildInventoryModel joins and counts", () => {
  it("unions declared and observed hosts and preserves exact source references", () => {
    const declaredH1 = host("h1");
    const config = configOf([declaredH1], []);
    const observedH1 = observedHost("h1");
    const observedH2 = observedHost("h2"); // observed-only, undeclared
    const model = buildInventoryModel(
      config,
      availableState({
        observedHosts: [observedH1, observedH2],
        hostStates: { h1: freshState(), h2: freshState() },
      }),
    );

    expect(model.hosts.map((r) => r.key)).toEqual(["h1", "h2"]);
    const h1 = findHost(model, "h1")!;
    expect(h1.declared).toBe(declaredH1); // exact reference, not a copy
    expect(h1.observed).toBe(observedH1);
    const h2 = findHost(model, "h2")!;
    expect(h2.declared).toBeNull(); // undeclared observed-only
    expect(h2.observed).toBe(observedH2);
  });

  it("indexes services by nested (host,name) identity with per-side counts", () => {
    // Spec section 9 deterministic example.
    const config = configOf(
      [host("alpha"), host("beta")],
      [
        service("alpha", "api"),
        service("alpha", "worker"),
        service("beta", "api"),
      ],
    );
    const model = buildInventoryModel(
      config,
      availableState({
        observedHosts: [observedHost("alpha"), observedHost("beta")],
        observedServices: [
          observedService("alpha", "api"),
          observedService("alpha", "orphan"),
          observedService("beta", "api"),
        ],
        hostStates: { alpha: freshState(), beta: freshState() },
      }),
    );

    expect(model.services.map((r) => ({ ...r.key }))).toEqual([
      { host: "alpha", name: "api" },
      { host: "alpha", name: "orphan" },
      { host: "alpha", name: "worker" },
      { host: "beta", name: "api" },
    ]);

    const alpha = findHost(model, "alpha")!;
    expect(alpha.declaredServiceCount).toBe(2);
    expect(alpha.observedServiceCount).toBe(2);

    // The repeated name "api" is two distinct entities keyed by host.
    expect(findService(model, "alpha", "api")).not.toBe(
      findService(model, "beta", "api"),
    );
  });

  it("treats duplicate inputs as deterministic first-wins without inflating counts", () => {
    const firstH1 = host("h1", { purpose: "first" });
    const secondH1 = host("h1", { purpose: "second" });
    const firstApi = service("h1", "api", { purpose: "first" });
    const secondApi = service("h1", "api", { purpose: "second" });
    const config = configOf([firstH1, secondH1], [firstApi, secondApi]);
    const model = buildInventoryModel(config, { status: "not-configured" });

    expect(model.hosts).toHaveLength(1);
    expect(findHost(model, "h1")!.declared).toBe(firstH1);
    expect(findHost(model, "h1")!.declaredServiceCount).toBe(1);
    expect(findService(model, "h1", "api")!.declared).toBe(firstApi);
    expect(model.services).toHaveLength(1);
  });

  it("keeps delimiter-like and NUL service names collision-free", () => {
    const names = ["a/b", "a b", "a:b", "a|b", "a.b", "a b"];
    const services = names.map((n) => service("h1", n));
    const config = configOf([host("h1")], services);
    const model = buildInventoryModel(config, { status: "not-configured" });

    for (const n of names) {
      expect(findService(model, "h1", n)).toBeDefined();
      expect(findService(model, "h1", n)!.key.name).toBe(n);
    }
    expect(findHost(model, "h1")!.declaredServiceCount).toBe(names.length);
  });
});

// --- ordering ---------------------------------------------------------------

describe("buildInventoryModel ordering", () => {
  it("sorts hosts by code point and services by host then name, independent of input order", () => {
    const config = configOf(
      [host("beta"), host("Alpha"), host("alpha"), host("Éclair")],
      [
        service("beta", "z"),
        service("alpha", "b"),
        service("alpha", "A"),
        service("Alpha", "a"),
      ],
    );
    const model = buildInventoryModel(config, { status: "not-configured" });

    // Uppercase before lowercase; non-ASCII strictly by code unit.
    expect(model.hosts.map((r) => r.key)).toEqual([
      "Alpha",
      "alpha",
      "beta",
      "Éclair",
    ]);
    // Host-then-name; within alpha, "A" (0x41) precedes "b" (0x62).
    expect(model.services.map((r) => `${r.key.host}/${r.key.name}`)).toEqual([
      "Alpha/a",
      "alpha/A",
      "alpha/b",
      "beta/z",
    ]);
  });
});

// --- reality semantics + inheritance ---------------------------------------

describe("buildInventoryModel reality semantics", () => {
  for (const { name, state } of NON_AVAILABLE_STATES) {
    it(`produces declared rows only with no-snapshot reality for ${name}`, () => {
      const config = configOf([host("h1")], [service("h1", "s1")]);
      const model = buildInventoryModel(config, state);

      expect(model.hosts).toHaveLength(1);
      const row = model.hosts[0]!;
      expect(row.reality).toBe("no-snapshot");
      expect(row.observed).toBeNull();
      expect(row.hostState).toBeNull();
      expect(row.observedServiceCount).toBe(0);
      expect(row.declaredServiceCount).toBe(1);

      const svc = model.services[0]!;
      expect(svc.reality).toBe("no-snapshot");
      expect(svc.observed).toBeNull();
      expect(svc.hostState).toBeNull();
    });
  }

  it("attaches the exact owning host state to every available service row", () => {
    const alphaState = freshState({ ageMs: 5 });
    const config = configOf([host("alpha")], [service("alpha", "api")]);
    const model = buildInventoryModel(
      config,
      availableState({
        observedHosts: [observedHost("alpha")],
        observedServices: [observedService("alpha", "api")],
        hostStates: { alpha: alphaState },
      }),
    );
    expect(findHost(model, "alpha")!.hostState).toBe(alphaState);
    expect(findService(model, "alpha", "api")!.hostState).toBe(alphaState);
    expect(findService(model, "alpha", "api")!.reality).toBe("available");
  });

  it("uses defensive unreachable state when an available host lacks a state", () => {
    // Observed service references a host present in neither host array.
    const config = configOf([], []);
    const model = buildInventoryModel(
      config,
      availableState({
        observedServices: [observedService("ghost", "svc")],
        hostStates: {}, // no state for "ghost"
      }),
    );
    const svc = findService(model, "ghost", "svc")!;
    expect(svc.hostState).toEqual({
      state: "unreachable",
      collectedAt: null,
      ageMs: null,
      pastStaleThreshold: false,
    });
    expect(svc.reality).toBe("available");
  });

  it("keeps declared-absent services not-observed and observed-only undeclared", () => {
    const config = configOf([host("h1")], [service("h1", "declaredOnly")]);
    const model = buildInventoryModel(
      config,
      availableState({
        observedHosts: [observedHost("h1")],
        observedServices: [observedService("h1", "observedOnly")],
        hostStates: { h1: freshState() },
      }),
    );
    const declaredOnly = findService(model, "h1", "declaredOnly")!;
    expect(declaredOnly.declared).not.toBeNull();
    expect(declaredOnly.observed).toBeNull(); // not observed
    const observedOnly = findService(model, "h1", "observedOnly")!;
    expect(observedOnly.declared).toBeNull(); // undeclared
    expect(observedOnly.observed).not.toBeNull();
  });

  it("retains available host states when the retained read has outer and read errors", () => {
    const config = configOf([host("h1")], []);
    const model = buildInventoryModel(
      config,
      availableState({
        observedHosts: [observedHost("h1")],
        hostStates: {
          h1: freshState({ state: "stale", pastStaleThreshold: true }),
        },
        outerError: { message: "later poll failed" },
        readError: { code: "POLL_TIMEOUT", message: "timed out" },
      }),
    );
    // Host state is the retained derived state, not coerced to unreachable.
    expect(findHost(model, "h1")!.hostState!.state).toBe("stale");
  });

  it("keeps the whole model empty (not a failure) for an empty valid config", () => {
    const model = buildInventoryModel(configOf([], []), {
      status: "not-configured",
    });
    expect(model.hosts).toEqual([]);
    expect(model.services).toEqual([]);
    expect(model.hostByName.size).toBe(0);
    expect(model.serviceByHost.size).toBe(0);
  });
});

// --- immutability -----------------------------------------------------------

describe("buildInventoryModel immutability", () => {
  function fullModel(): InventoryModel {
    return buildInventoryModel(
      configOf([host("h1")], [service("h1", "s1")]),
      availableState({
        observedHosts: [observedHost("h1")],
        observedServices: [observedService("h1", "s1")],
        hostStates: { h1: freshState() },
      }),
    );
  }

  it("freezes rows, arrays, and the top-level model", () => {
    const model = fullModel();
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.hosts)).toBe(true);
    expect(Object.isFrozen(model.services)).toBe(true);
    expect(Object.isFrozen(model.hosts[0])).toBe(true);
    expect(Object.isFrozen(model.services[0])).toBe(true);
    expect(Object.isFrozen(model.services[0]!.key)).toBe(true);

    expect(() => {
      (model.hosts as HostRow[]).push({} as HostRow);
    }).toThrow();
    expect(() => {
      (model.hosts[0] as { key: string }).key = "mutated";
    }).toThrow();
    expect(() => {
      (model as { hosts: unknown }).hosts = [];
    }).toThrow();
  });

  it("exposes mutation-proof ReadonlyMap facades, not merely frozen Maps", () => {
    const model = fullModel();
    const outer = model.hostByName as unknown as Record<string, unknown>;
    // The facade has no mutators.
    expect(outer.set).toBeUndefined();
    expect(outer.delete).toBeUndefined();
    expect(outer.clear).toBeUndefined();
    // Read surface works.
    expect(model.hostByName.size).toBe(1);
    expect(model.hostByName.has("h1")).toBe(true);
    expect([...model.hostByName.keys()]).toEqual(["h1"]);
    expect([...model.hostByName.values()].map((r) => r.key)).toEqual(["h1"]);
    expect([...model.hostByName.entries()].map(([k]) => k)).toEqual(["h1"]);
    expect([...model.hostByName].map(([k]) => k)).toEqual(["h1"]);

    // Nested facade is equally locked and iterable.
    const inner = model.serviceByHost.get("h1")!;
    const innerRaw = inner as unknown as Record<string, unknown>;
    expect(innerRaw.set).toBeUndefined();
    expect(innerRaw.delete).toBeUndefined();
    expect(inner.get("s1")).toBeDefined();
    expect(Object.isFrozen(model.hostByName)).toBe(true);
    expect(Object.isFrozen(model.serviceByHost)).toBe(true);
    expect(Object.isFrozen(inner)).toBe(true);
  });

  it("hands the facade (never the backing map) to forEach so it cannot be mutated", () => {
    const model = fullModel();
    let seen: unknown;
    model.hostByName.forEach((_value, _key, map) => {
      seen = map;
    });
    expect(seen).toBe(model.hostByName);
    expect((seen as Record<string, unknown>).set).toBeUndefined();
  });
});

// --- lookup -----------------------------------------------------------------

describe("findHost and findService", () => {
  it("returns undefined for unknown entities without fabricating rows", () => {
    const model = buildInventoryModel(
      configOf([host("h1")], [service("h1", "s1")]),
      { status: "not-configured" },
    );
    expect(findHost(model, "nope")).toBeUndefined();
    expect(findService(model, "h1", "nope")).toBeUndefined();
    expect(findService(model, "nope", "s1")).toBeUndefined();
    // Present lookups resolve to the same identity as the arrays.
    expect(findHost(model, "h1")).toBe(model.hosts[0]);
    expect(findService(model, "h1", "s1")).toBe(model.services[0]);
  });
});

// --- generated scale --------------------------------------------------------

describe("buildInventoryModel at 150 hosts / 300 services", () => {
  it("normalizes generated inputs in order with exact cardinality and O(1) lookup", () => {
    const hosts: Host[] = [];
    const services: Service[] = [];
    const observedHosts: ObservedHost[] = [];
    const observedServices: ObservedService[] = [];
    const hostStates: Record<string, HostState> = {};
    for (let i = 0; i < 150; i++) {
      const hn = `host-${String(i).padStart(3, "0")}`;
      hosts.push(host(hn));
      observedHosts.push(observedHost(hn));
      hostStates[hn] = freshState();
      for (let j = 0; j < 2; j++) {
        const sn = `svc-${String(j).padStart(3, "0")}`;
        services.push(service(hn, sn));
        observedServices.push(observedService(hn, sn));
      }
    }
    const model = buildInventoryModel(
      configOf(hosts, services),
      availableState({ observedHosts, observedServices, hostStates }),
    );

    expect(model.hosts).toHaveLength(150);
    expect(model.services).toHaveLength(300);
    // Sorted ascending by construction.
    const keys = model.hosts.map((r) => r.key);
    expect(keys).toEqual([...keys].sort(compareOrdinal));
    // O(1) lookups resolve every entity.
    expect(findHost(model, "host-149")).toBeDefined();
    expect(findService(model, "host-149", "svc-001")).toBeDefined();
    for (const row of model.services) {
      expect(row.hostState).toBe(hostStates[row.key.host]);
    }
  });
});

// ===========================================================================
// search-filter — pure host/service projection (item 013)
// ===========================================================================

/** A rich available model: declared+observed, hidden, undeclared, mixed kinds/states. */
function richModel(): InventoryModel {
  const hosts: Host[] = [
    host("alpha", { kind: "vm", purpose: "web server" }),
    host("bravo", { kind: "bare-metal", purpose: "database node", hidden: true }),
    host("charlie", { kind: "vm", purpose: "cache" }),
  ];
  const services: Service[] = [
    service("alpha", "api", { purpose: "public api" }),
    service("alpha", "worker", { purpose: "queue worker", hidden: true }),
    service("bravo", "db", { purpose: "postgres" }),
  ];
  const observedHosts: ObservedHost[] = [
    observedHost("alpha"),
    observedHost("bravo"),
    observedHost("charlie"),
    observedHost("delta"), // observed-only, undeclared
  ];
  const observedServices: ObservedService[] = [
    observedService("alpha", "api", "running"),
    observedService("bravo", "db", "degraded"),
    observedService("delta", "extra", "stopped"), // observed-only, undeclared
    // alpha/worker declared but not observed → not-observed under available reality
  ];
  const hostStates: Record<string, HostState> = {
    alpha: freshState({ state: "fresh" }),
    bravo: freshState({ state: "stale", pastStaleThreshold: true }),
    charlie: freshState({ state: "partial" }),
    delta: freshState({ state: "unreachable", collectedAt: null, ageMs: null }),
  };
  return buildInventoryModel(
    configOf(hosts, services),
    availableState({ observedHosts, observedServices, hostStates }),
  );
}

describe("no-filter constants", () => {
  it("are exact, frozen, and select every row", () => {
    expect(NO_HOST_FILTERS).toEqual({
      query: "",
      kinds: [],
      states: [],
      excludeHidden: false,
    });
    expect(NO_SERVICE_FILTERS).toEqual({
      query: "",
      hosts: [],
      observedStates: [],
      excludeHidden: false,
    });
    expect(Object.isFrozen(NO_HOST_FILTERS)).toBe(true);
    expect(Object.isFrozen(NO_SERVICE_FILTERS)).toBe(true);
    const model = richModel();
    expect(filterHosts(model.hosts, NO_HOST_FILTERS).rows).toHaveLength(
      model.hosts.length,
    );
    expect(filterServices(model.services, NO_SERVICE_FILTERS).rows).toHaveLength(
      model.services.length,
    );
  });
});

describe("filterHosts", () => {
  it("searches name and purpose, case-insensitively, by substring", () => {
    const { hosts } = richModel();
    // Name substring.
    expect(filterHosts(hosts, { ...NO_HOST_FILTERS, query: "ALPH" }).rows.map((r) => r.key)).toEqual(["alpha"]);
    // Purpose substring; "database" belongs to bravo's purpose only.
    expect(filterHosts(hosts, { ...NO_HOST_FILTERS, query: "database" }).rows.map((r) => r.key)).toEqual(["bravo"]);
    // Does not search kind or other fields.
    expect(filterHosts(hosts, { ...NO_HOST_FILTERS, query: "bare-metal" }).rows).toHaveLength(0);
  });

  it("filters by declared kind; undeclared rows never match a kind selection", () => {
    const { hosts } = richModel();
    const vms = filterHosts(hosts, { ...NO_HOST_FILTERS, kinds: ["vm"] });
    expect(vms.rows.map((r) => r.key)).toEqual(["alpha", "charlie"]);
    // OR within the dimension.
    const either = filterHosts(hosts, { ...NO_HOST_FILTERS, kinds: ["vm", "bare-metal"] });
    expect(either.rows.map((r) => r.key)).toEqual(["alpha", "bravo", "charlie"]);
    // delta is observed-only (declared null) → excluded by any non-empty kind selection.
    expect(vms.rows.some((r) => r.key === "delta")).toBe(false);
  });

  it("filters by collection state; no-snapshot rows never match a state selection", () => {
    const { hosts } = richModel();
    expect(filterHosts(hosts, { ...NO_HOST_FILTERS, states: ["stale"] }).rows.map((r) => r.key)).toEqual(["bravo"]);
    expect(
      filterHosts(hosts, { ...NO_HOST_FILTERS, states: ["fresh", "partial"] }).rows.map((r) => r.key),
    ).toEqual(["alpha", "charlie"]);

    // A no-snapshot model has null host states → cannot match a reality selection.
    const noSnap = buildInventoryModel(
      configOf([host("alpha")], []),
      { status: "not-configured" },
    );
    expect(filterHosts(noSnap.hosts, { ...NO_HOST_FILTERS, states: ["fresh"] }).rows).toHaveLength(0);
    // But empty selection still returns the declared row.
    expect(filterHosts(noSnap.hosts, NO_HOST_FILTERS).rows).toHaveLength(1);
  });

  it("excludes only explicitly hidden declarations when requested", () => {
    const { hosts } = richModel();
    const shown = filterHosts(hosts, { ...NO_HOST_FILTERS, excludeHidden: true });
    // bravo is the only hidden declaration; delta (undeclared) is not hidden.
    expect(shown.rows.map((r) => r.key)).toEqual(["alpha", "charlie", "delta"]);
    expect(shown.total).toBe(4);
    expect(shown.hidden).toBe(1);
  });

  it("composes dimensions with AND and reports exact counts and stable order", () => {
    const { hosts } = richModel();
    const result = filterHosts(hosts, {
      query: "a",
      kinds: ["vm"],
      states: ["fresh"],
      excludeHidden: true,
    });
    // Only alpha satisfies query "a" AND vm AND fresh AND not-hidden.
    expect(result.rows.map((r) => r.key)).toEqual(["alpha"]);
    expect(result.total).toBe(4);
    expect(result.hidden).toBe(3);
    // Order preserved relative to the model.
    const many = filterHosts(hosts, { ...NO_HOST_FILTERS, kinds: ["vm", "bare-metal"] });
    expect(many.rows).toEqual(hosts.filter((r) => r.key !== "delta"));
  });
});

describe("filterServices", () => {
  it("searches name, host, and purpose, case-insensitively", () => {
    const { services } = richModel();
    expect(
      filterServices(services, { ...NO_SERVICE_FILTERS, query: "API" }).rows.map((r) => r.key.name),
    ).toEqual(["api"]);
    // Host substring matches every service on that host.
    expect(
      filterServices(services, { ...NO_SERVICE_FILTERS, query: "alpha" }).rows.map((r) => r.key.name),
    ).toEqual(["api", "worker"]);
    // Purpose substring.
    expect(
      filterServices(services, { ...NO_SERVICE_FILTERS, query: "postgres" }).rows.map((r) => r.key.name),
    ).toEqual(["db"]);
  });

  it("filters by host with OR within the dimension", () => {
    const { services } = richModel();
    expect(
      filterServices(services, { ...NO_SERVICE_FILTERS, hosts: ["bravo"] }).rows.map((r) => r.key.name),
    ).toEqual(["db"]);
    expect(
      filterServices(services, { ...NO_SERVICE_FILTERS, hosts: ["alpha", "delta"] }).rows.map(
        (r) => `${r.key.host}/${r.key.name}`,
      ),
    ).toEqual(["alpha/api", "alpha/worker", "delta/extra"]);
  });

  it("filters observed state including the explicit not-observed token", () => {
    const { services } = richModel();
    expect(
      filterServices(services, { ...NO_SERVICE_FILTERS, observedStates: ["running"] }).rows.map(
        (r) => r.key.name,
      ),
    ).toEqual(["api"]);
    // alpha/worker is declared but unobserved under available reality → not-observed.
    expect(
      filterServices(services, { ...NO_SERVICE_FILTERS, observedStates: ["not-observed"] }).rows.map(
        (r) => `${r.key.host}/${r.key.name}`,
      ),
    ).toEqual(["alpha/worker"]);
    // OR across observed states.
    expect(
      filterServices(services, {
        ...NO_SERVICE_FILTERS,
        observedStates: ["degraded", "stopped"],
      }).rows.map((r) => `${r.key.host}/${r.key.name}`),
    ).toEqual(["bravo/db", "delta/extra"]);
  });

  it("no-snapshot service rows never match an observed-state selection", () => {
    const noSnap = buildInventoryModel(
      configOf([host("alpha")], [service("alpha", "api")]),
      { status: "not-configured" },
    );
    expect(
      filterServices(noSnap.services, { ...NO_SERVICE_FILTERS, observedStates: ["not-observed"] }).rows,
    ).toHaveLength(0);
    expect(
      filterServices(noSnap.services, { ...NO_SERVICE_FILTERS, observedStates: ["running"] }).rows,
    ).toHaveLength(0);
    // Empty selection keeps the declared service.
    expect(filterServices(noSnap.services, NO_SERVICE_FILTERS).rows).toHaveLength(1);
  });

  it("excludes only services declared hidden, never inheriting host hidden", () => {
    const { services } = richModel();
    const shown = filterServices(services, { ...NO_SERVICE_FILTERS, excludeHidden: true });
    // alpha/worker is the only hidden service. bravo/db lives on a hidden host but
    // is not itself hidden, so it remains visible.
    expect(shown.rows.map((r) => `${r.key.host}/${r.key.name}`)).toEqual([
      "alpha/api",
      "bravo/db",
      "delta/extra",
    ]);
    expect(shown.total).toBe(4);
    expect(shown.hidden).toBe(1);
  });

  it("composes every dimension with AND and preserves order", () => {
    const { services } = richModel();
    const result = filterServices(services, {
      query: "a",
      hosts: ["alpha"],
      observedStates: ["running"],
      excludeHidden: true,
    });
    expect(result.rows.map((r) => r.key.name)).toEqual(["api"]);
    expect(result.total).toBe(4);
    expect(result.hidden).toBe(3);
  });
});

describe("filter purity and immutability", () => {
  it("returns frozen results and mutates neither rows nor the model", () => {
    const model = richModel();
    const hostResult = filterHosts(model.hosts, { ...NO_HOST_FILTERS, kinds: ["vm"] });
    const serviceResult = filterServices(model.services, {
      ...NO_SERVICE_FILTERS,
      hosts: ["alpha"],
    });
    expect(Object.isFrozen(hostResult)).toBe(true);
    expect(Object.isFrozen(hostResult.rows)).toBe(true);
    expect(Object.isFrozen(serviceResult)).toBe(true);
    expect(Object.isFrozen(serviceResult.rows)).toBe(true);
    // Result rows are the same identities from the immutable model (no cloning).
    expect(hostResult.rows[0]).toBe(model.hostByName.get("alpha"));
    // The source arrays are untouched.
    expect(model.hosts).toHaveLength(4);
    expect(model.services).toHaveLength(4);
    expect(() => (hostResult.rows as HostRow[]).push(model.hosts[0]!)).toThrow();
  });
});

describe("filter performance gate (150 hosts / 300 services)", () => {
  function scaleModel(): InventoryModel {
    const hosts: Host[] = [];
    const services: Service[] = [];
    const observedHosts: ObservedHost[] = [];
    const observedServices: ObservedService[] = [];
    const hostStates: Record<string, HostState> = {};
    const kinds = ["vm", "bare-metal", "lxc"] as const;
    for (let i = 0; i < 150; i++) {
      const hn = `fixture-host-${String(i).padStart(3, "0")}`;
      hosts.push(host(hn, { kind: kinds[i % kinds.length], purpose: `purpose ${i}` }));
      observedHosts.push(observedHost(hn));
      hostStates[hn] = freshState();
      for (let j = 0; j < 2; j++) {
        const sn = `fixture-service-${String(i * 2 + j).padStart(3, "0")}`;
        services.push(service(hn, sn, { purpose: `svc purpose ${sn}` }));
        observedServices.push(observedService(hn, sn));
      }
    }
    const model = buildInventoryModel(
      configOf(hosts, services),
      availableState({ observedHosts, observedServices, hostStates }),
    );
    // Trust nothing: assert the generated cardinalities.
    expect(model.hosts).toHaveLength(150);
    expect(model.services).toHaveLength(300);
    return model;
  }

  it("filters 150 hosts under 100 ms on every one of 100 invocations", () => {
    const { hosts } = scaleModel();
    const criteria: HostFilterCriteria = {
      query: "purpose",
      kinds: ["vm"],
      states: ["fresh"],
      excludeHidden: true,
    };
    // Every host has "purpose" in its purpose, kind vm on 1/3, fresh, none hidden.
    const expected = hosts.filter((r) => r.declared?.kind === "vm").length;
    for (let i = 0; i < 10; i++) filterHosts(hosts, criteria); // warm-up
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const result = filterHosts(hosts, criteria);
      const elapsed = performance.now() - start;
      expect(result.rows).toHaveLength(expected);
      expect(elapsed).toBeLessThan(100);
    }
    expect(expected).toBeGreaterThan(0);
  });

  it("filters 300 services under 100 ms on every one of 100 invocations", () => {
    const { services } = scaleModel();
    const criteria: ServiceFilterCriteria = {
      query: "svc",
      hosts: [],
      observedStates: ["running"],
      excludeHidden: true,
    };
    const expected = services.length; // all observed running, all match query, none hidden
    for (let i = 0; i < 10; i++) filterServices(services, criteria); // warm-up
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const result = filterServices(services, criteria);
      const elapsed = performance.now() - start;
      expect(result.rows).toHaveLength(expected);
      expect(elapsed).toBeLessThan(100);
    }
    expect(expected).toBe(300);
  });
});

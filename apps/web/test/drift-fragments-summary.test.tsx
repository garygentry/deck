// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL } from "node:url";
// Vite rewrites the literal `new URL("…", import.meta.url)` form into a served-asset
// URL under the jsdom (web) transform; resolving against a plain const avoids that.
const TEST_FILE_URL = import.meta.url;
import { deriveDriftProjection } from "@deck/drift";
import type { SnapshotProviderResult } from "@deck/contract";
import type { JSX } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  availableState,
  config,
  failedEmptyState,
  hostDecl,
  makeGeneration,
  NOT_CONFIGURED,
  pendingState,
  requestErrorState,
  resetInventoryTestEnv,
  serviceDecl,
} from "./inventory-harness.js";
import type { InventoryGeneration } from "../src/features/hosts-and-services/inventory-store.js";
import type { DriftGenerationState } from "../../../modules/drift/web/store.js";
import type { EntityRef } from "../src/registry/registry.js";
import type { HealthSummary } from "../src/shell/health-header/health-summary.js";

// ---------------------------------------------------------------------------
// Each case drives one controlled `DriftGenerationState`. The fragment subscribes
// only through `useDriftGeneration`, so mocking that hook yields a deterministic
// accepted generation with no store/poll/derivation lifecycle. All identities are
// invented and deterministic.
// ---------------------------------------------------------------------------

let driftState: DriftGenerationState;
vi.mock("../../../modules/drift/web/use-drift-generation.js", () => ({
  useDriftGeneration: () => driftState,
}));

import {
  FindingsFragment,
  FragmentPresentationBoundary,
} from "../../../modules/drift/web/FindingsFragment.js";
import {
  DriftHealthSummary,
  SummaryPresentationBoundary,
} from "../../../modules/drift/web/DriftHealthSummary.js";
import {
  __resetDriftRenderDedupForTest,
  setDriftDiagnosticSink,
} from "../../../modules/drift/web/diagnostics.js";
import type { DriftDiagnosticEvent } from "../../../modules/drift/web/diagnostics.js";

// ---------------------------------------------------------------------------
// Deterministic fixtures.
// ---------------------------------------------------------------------------

const FIXED = "2030-01-01T00:00:00.000Z";
const CLOCK = new Date("2030-06-01T00:00:00.000Z");
const FUTURE = "2030-07-01T00:00:00.000Z";
const PAST = "2030-05-01T00:00:00.000Z";

const DEFAULT_CONFIG = config(
  [hostDecl("compute-a"), hostDecl("compute-b"), hostDecl("compute-c")],
  [serviceDecl("compute-a", "api"), serviceDecl("compute-b", "web")],
);

/** Host-a population: host-level unwaived error, active-waiver, expired-waiver; one api warning. */
const MIXED_DRIFT = [
  {
    id: "a-host-err",
    severity: "error",
    category: "config",
    message: "Host error A",
    location: { host: "compute-a" },
  },
  {
    id: "a-host-active",
    severity: "error",
    category: "config",
    message: "Active waiver A",
    location: { host: "compute-a" },
    waiver: { reason: "planned", who: "ops", until: FUTURE },
  },
  {
    id: "a-host-expired",
    severity: "warning",
    category: "drift",
    message: "Expired waiver A",
    location: { host: "compute-a" },
    waiver: { reason: "lapsed", who: "ops", until: PAST },
  },
  {
    id: "a-api-warn",
    severity: "warning",
    category: "drift",
    message: "Service warn A/api",
    location: { host: "compute-a", service: "api" },
  },
  {
    id: "b-web-info",
    severity: "info",
    category: "config",
    message: "Info B/web",
    location: { host: "compute-b", service: "web" },
  },
];

const DEFAULT_HOST_STATES: Record<string, unknown> = {
  "compute-a": { state: "fresh", collectedAt: FIXED, ageMs: 1_000, pastStaleThreshold: false },
  "compute-b": { state: "stale", collectedAt: FIXED, ageMs: 1_000, pastStaleThreshold: true },
  "compute-c": { state: "unreachable", collectedAt: null, ageMs: null, pastStaleThreshold: false },
};

interface AvailableOptions {
  config?: typeof DEFAULT_CONFIG;
  drift?: unknown[];
  hostStates?: Record<string, unknown>;
  readError?: { code: string; message: string } | null;
  refreshGeneration?: number;
  transientError?: string | null;
  derivationError?: string | null;
}

function availableResult(over: AvailableOptions): SnapshotProviderResult {
  return {
    snapshot: {
      schemaVersion: 1,
      generatedAt: FIXED,
      hosts: [],
      drift: over.drift ?? MIXED_DRIFT,
    },
    findings: [],
    hostStates: over.hostStates ?? DEFAULT_HOST_STATES,
    lastReadAt: FIXED,
    readError: over.readError ?? null,
  } as unknown as SnapshotProviderResult;
}

/** One available, matching projection/model generation state. */
function availableGenState(over: AvailableOptions = {}): DriftGenerationState {
  const cfg = over.config ?? DEFAULT_CONFIG;
  const result = availableResult(over);
  const clientState = availableState(result);
  if (clientState.status !== "available") throw new Error("expected available");
  const gen = makeGeneration({
    config: cfg,
    snapshot: clientState,
    refreshGeneration: over.refreshGeneration ?? 1,
    transientError: over.transientError ?? null,
  }) as unknown as InventoryGeneration;
  const projection = deriveDriftProjection(clientState.envelope, CLOCK);
  return {
    inventory: gen,
    current: {
      refreshGeneration: gen.refreshGeneration,
      inventory: gen,
      projection,
    },
    derivationError: over.derivationError ?? null,
  };
}

/** One no-usable-generation state carrying the supplied inventory snapshot. */
function unavailableGenState(
  snapshot: InventoryGeneration["snapshot"],
  over: {
    config?: typeof DEFAULT_CONFIG | null;
    transientError?: string | null;
    derivationError?: string | null;
  } = {},
): DriftGenerationState {
  const gen = makeGeneration({
    config: over.config === undefined ? null : over.config,
    snapshot,
    refreshGeneration: 0,
    transientError: over.transientError ?? null,
  }) as unknown as InventoryGeneration;
  return {
    inventory: gen,
    current: null,
    derivationError: over.derivationError ?? null,
  };
}

const HOST_A: EntityRef = { entity: "host", host: "compute-a" };
const SERVICE_API: EntityRef = { entity: "service", host: "compute-a", name: "api" };

// ---------------------------------------------------------------------------
// Render helpers (React Testing Library over jsdom).
// ---------------------------------------------------------------------------

/** Render one fragment; the returned `rerender` re-renders it for a new state. */
function renderFragment(entity: EntityRef): RenderResult {
  return render(<FindingsFragment entity={entity} />);
}

/** The fragment's section, named by its heading. */
function fragmentRegion(): HTMLElement {
  return screen.getByRole("region", { name: /^Drift findings/ });
}

/** Mounted compact finding rows, in DOM order. */
function rows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('li[id^="drift-fragment-finding-"]'),
  );
}

/** The mounted row carrying `findingId`, or null. */
function rowFor(findingId: string): HTMLElement | null {
  return document.getElementById(`drift-fragment-finding-${findingId}`);
}

beforeAll(() => {
  // Silence and isolate the default console diagnostic sink for the whole suite.
  setDriftDiagnosticSink(() => {});
  // Radix tooltips (HealthPill) observe their trigger's size.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
  resetInventoryTestEnv();
});

/** Silence React's own error log for an intentional boundary throw. */
function quietConsoleError(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

// ---------------------------------------------------------------------------
// Scope selection (07 §3.2).
// ---------------------------------------------------------------------------

describe("entity scope selection", () => {
  it("host scope includes host-level and every service subgroup in projection order", () => {
    driftState = availableGenState();
    renderFragment(HOST_A);
    const region = fragmentRegion();
    // All four compute-a findings (three host-level + one service) appear, in order.
    expect(rows().map((row) => row.id)).toEqual([
      "drift-fragment-finding-a-host-err",
      "drift-fragment-finding-a-host-active",
      "drift-fragment-finding-a-host-expired",
      "drift-fragment-finding-a-api-warn",
    ]);
    // A finding on another host is excluded.
    expect(region).not.toHaveTextContent("Info B/web");
    // Host-level context is labelled distinctly from the service context.
    expect(within(rowFor("a-host-err")!).getByText("Host-level · config")).toBeInTheDocument();
    expect(within(rowFor("a-api-warn")!).getByText("api · drift")).toBeInTheDocument();
  });

  it("service scope includes only the exact host/service subgroup", () => {
    driftState = availableGenState();
    renderFragment(SERVICE_API);
    expect(
      screen.getByRole("heading", { name: "Drift findings for service api on compute-a" }),
    ).toBeInTheDocument();
    expect(rows().map((row) => row.id)).toEqual(["drift-fragment-finding-a-api-warn"]);
    // Host-level and sibling-service findings are excluded.
    expect(fragmentRegion()).not.toHaveTextContent("Host error A");
    expect(fragmentRegion()).not.toHaveTextContent("Active waiver A");
  });

  it("does not match a service name on an unrelated host", () => {
    driftState = availableGenState();
    // `web` is a real service, but on compute-b, not compute-a.
    renderFragment({ entity: "service", host: "compute-a", name: "web" });
    // No `web` subgroup exists on compute-a, so the population is empty and the
    // fragment qualifies with compute-a's own (fresh) coverage state.
    expect(screen.getByRole("status")).toHaveTextContent("No drift reported for this entity");
    expect(rows()).toHaveLength(0);
    expect(fragmentRegion()).not.toHaveTextContent("Info B/web");
  });
});

// ---------------------------------------------------------------------------
// Malformed service scope (07 §3.3).
// ---------------------------------------------------------------------------

describe("malformed service entity", () => {
  it("states the scope failure without broadening to host scope", () => {
    driftState = availableGenState();
    renderFragment({ entity: "service", host: "compute-a" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to scope findings for this service.",
    );
    // No host-level findings leak in from a broadened scope.
    expect(rows()).toHaveLength(0);
    expect(fragmentRegion()).not.toHaveTextContent("Host error A");
    expect(fragmentRegion()).not.toHaveTextContent("scoped finding");
  });

  it("treats an empty service name as malformed", () => {
    driftState = availableGenState();
    renderFragment({ entity: "service", host: "compute-a", name: "" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to scope findings for this service.",
    );
  });
});

// ---------------------------------------------------------------------------
// Compact counts and inert rows (07 §3.2).
// ---------------------------------------------------------------------------

describe("compact counts and rows", () => {
  it("classifies active and expired waivers in the host count line", () => {
    driftState = availableGenState();
    renderFragment(HOST_A);
    // 4 selected: 1 active waiver, 1 expired waiver, active risk 1 error + 2 warning.
    expect(screen.getByRole("status")).toHaveTextContent(
      "4 scoped findings. Active risk: 1 error, 2 warning, 0 info. Active waivers: 1. Expired waivers: 1.",
    );
  });

  it("computes a singular service count line", () => {
    driftState = availableGenState();
    renderFragment(SERVICE_API);
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 scoped finding. Active risk: 0 error, 1 warning, 0 info. Active waivers: 0. Expired waivers: 0.",
    );
  });

  it("renders explicit severity/waiver-state text and inert message text", () => {
    driftState = availableGenState();
    renderFragment(HOST_A);
    const err = within(rowFor("a-host-err")!);
    expect(err.getByText("Error")).toBeInTheDocument();
    expect(err.getByText("Unwaived")).toBeInTheDocument();
    expect(within(rowFor("a-host-active")!).getByText("Active waiver")).toBeInTheDocument();
    expect(within(rowFor("a-host-expired")!).getByText("Expired waiver")).toBeInTheDocument();
    // Message text is rendered as a text node, never parsed as markup.
    expect(err.getByText("Host error A")).toBeInTheDocument();
  });

  it("renders a hostile message as inert text", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    driftState = availableGenState({
      drift: [
        {
          id: "a-xss",
          severity: "error",
          category: "config",
          message: hostile,
          location: { host: "compute-a" },
        },
      ],
    });
    renderFragment(HOST_A);
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(fragmentRegion().querySelector("img")).toBeNull();
  });

  it("omits expected/observed evidence from compact rows", () => {
    driftState = availableGenState({
      drift: [
        {
          id: "a-ev",
          severity: "error",
          category: "config",
          message: "With evidence",
          location: { host: "compute-a" },
          expected: { port: 22 },
          observed: { port: 2222 },
        },
      ],
    });
    renderFragment(HOST_A);
    expect(screen.getByText("With evidence")).toBeInTheDocument();
    expect(fragmentRegion()).not.toHaveTextContent("2222");
    expect(fragmentRegion()).not.toHaveTextContent("Expected");
  });
});

// ---------------------------------------------------------------------------
// Links and scoped href (07 §§3.3, 4).
// ---------------------------------------------------------------------------

describe("entity links and scoped href", () => {
  it("links a resolvable service row to its service detail", () => {
    driftState = availableGenState();
    renderFragment(SERVICE_API);
    expect(
      screen.getByRole("link", { name: "View service api on compute-a" }),
    ).toHaveAttribute("href", "/services/compute-a/api");
  });

  it("falls back to the host detail when the service is unresolved", () => {
    driftState = availableGenState({
      drift: [
        {
          id: "a-ghost",
          severity: "error",
          category: "config",
          message: "Ghost service",
          location: { host: "compute-a", service: "missing" },
        },
      ],
    });
    renderFragment(HOST_A);
    // `missing` is not a declared service, so the row falls back to the host link.
    expect(screen.getByRole("link", { name: "View host compute-a" })).toHaveAttribute(
      "href",
      "/hosts/compute-a",
    );
  });

  it("renders explicit unresolved text with no anchor for a wholly unknown host", () => {
    driftState = availableGenState({
      drift: [
        {
          id: "x-orphan",
          severity: "error",
          category: "config",
          message: "Orphan host finding",
          location: { host: "ghost-host" },
        },
      ],
      hostStates: {
        "ghost-host": { state: "fresh", collectedAt: FIXED, ageMs: 1, pastStaleThreshold: false },
      },
    });
    renderFragment({ entity: "host", host: "ghost-host" });
    const row = within(rowFor("x-orphan")!);
    expect(
      row.getByText("Location unresolved; no host or service detail link is available."),
    ).toBeInTheDocument();
    expect(row.queryByRole("link")).toBeNull();
    expect(document.querySelector('a[href="/hosts/ghost-host"]')).toBeNull();
  });

  it("emits an exact scoped /drift link round-tripping reserved characters", () => {
    const cfg = config(
      [hostDecl("edge alpha")],
      [serviceDecl("edge alpha", "api/blue")],
    );
    driftState = availableGenState({
      config: cfg,
      drift: [
        {
          id: "edge-1",
          severity: "error",
          category: "config",
          message: "Edge finding",
          location: { host: "edge alpha", service: "api/blue" },
        },
      ],
      hostStates: {
        "edge alpha": { state: "fresh", collectedAt: FIXED, ageMs: 1, pastStaleThreshold: false },
      },
    });
    renderFragment({ entity: "service", host: "edge alpha", name: "api/blue" });
    expect(
      screen
        .getByRole("link", { name: "View these findings in the Drift view" })
        .getAttribute("href"),
    ).toBe("/drift?host=edge+alpha&service=api%2Fblue");
  });
});

// ---------------------------------------------------------------------------
// Qualified empty states (07 §3.4).
// ---------------------------------------------------------------------------

describe("qualified empty states", () => {
  function renderEmptyHost(state: string, collected: boolean): HTMLElement {
    driftState = availableGenState({
      drift: [],
      hostStates: {
        "compute-a": {
          state,
          collectedAt: collected ? FIXED : null,
          ageMs: collected ? 1_000 : null,
          pastStaleThreshold: false,
        },
      },
    });
    renderFragment(HOST_A);
    return screen.getByRole("status");
  }

  it("qualifies a fresh host", () => {
    expect(renderEmptyHost("fresh", true)).toHaveTextContent(
      "No drift reported for this entity in the current snapshot. Host collection is fresh.",
    );
  });
  it("qualifies a stale host", () => {
    expect(renderEmptyHost("stale", true)).toHaveTextContent(
      "No drift reported for this entity; host collection is stale.",
    );
  });
  it("qualifies a partial host", () => {
    expect(renderEmptyHost("partial", true)).toHaveTextContent(
      "No drift reported for this entity; host collection is partial.",
    );
  });
  it("qualifies an unreachable host", () => {
    expect(renderEmptyHost("unreachable", false)).toHaveTextContent(
      "No drift reported for this entity; the host is unreachable.",
    );
  });
  it("qualifies a never-collected host", () => {
    expect(renderEmptyHost("never-collected", false)).toHaveTextContent(
      "No drift reported for this entity; the host has never been collected.",
    );
  });

  it("qualifies a host with no coverage row as coverage-unavailable", () => {
    driftState = availableGenState({ drift: [], hostStates: {} });
    renderFragment(HOST_A);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No drift reported for this entity; collection coverage is unavailable.",
    );
  });

  it("inherits the host collection state for a zero-result service fragment", () => {
    driftState = availableGenState({
      drift: [],
      hostStates: {
        "compute-a": { state: "stale", collectedAt: FIXED, ageMs: 1_000, pastStaleThreshold: true },
      },
    });
    renderFragment(SERVICE_API);
    expect(screen.getByRole("status")).toHaveTextContent("host collection is stale");
  });

  it("never renders an unqualified all-clear", () => {
    renderEmptyHost("fresh", true);
    const text = fragmentRegion().textContent ?? "";
    expect(text).not.toContain("all clear");
    expect(text).not.toContain("healthy");
    expect(text.toLowerCase()).not.toContain("clean");
  });
});

// ---------------------------------------------------------------------------
// No-accepted-generation states (07 §3.4 first rows).
// ---------------------------------------------------------------------------

describe("no accepted generation", () => {
  it("states no snapshot configured", () => {
    driftState = unavailableGenState(NOT_CONFIGURED);
    renderFragment(HOST_A);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No snapshot is configured; drift has not been checked.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("states pending first read", () => {
    driftState = unavailableGenState(pendingState());
    renderFragment(HOST_A);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Snapshot read pending; drift has not been checked.",
    );
  });

  it("states a failed first read with the sanitized envelope error", () => {
    driftState = unavailableGenState(failedEmptyState("First poll failed."));
    renderFragment(HOST_A);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Snapshot read failed; no drift result is available.");
    expect(alert).toHaveTextContent("First poll failed.");
  });

  it("states a failed first request with the sanitized client message", () => {
    driftState = unavailableGenState(requestErrorState("Connection refused."));
    renderFragment(HOST_A);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Snapshot read failed; no drift result is available.");
    expect(alert).toHaveTextContent("Connection refused.");
  });

  it("states a failed first derivation without a retained generation", () => {
    driftState = unavailableGenState(availableState(availableResult({})), {
      config: DEFAULT_CONFIG,
      derivationError: "Drift data could not be prepared.",
    });
    renderFragment(HOST_A);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Drift could not be derived; no drift result is available.");
    expect(alert).toHaveTextContent("Drift data could not be prepared.");
  });
});

// ---------------------------------------------------------------------------
// Retained failure (07 §3.4 last row).
// ---------------------------------------------------------------------------

describe("retained-failure warnings", () => {
  it("shows a separate aging alert while keeping the retained findings and coverage", () => {
    driftState = availableGenState({
      transientError: "Latest refresh failed.",
      readError: { code: "UPSTREAM", message: "upstream read failed" },
    });
    renderFragment(HOST_A);
    // The retained generation's findings and counts remain visible.
    expect(screen.getByText("Host error A")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("4 scoped findings.");
    // A distinct retained-generation aging alert is shown separately.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "showing a retained drift generation that",
    );
  });

  it("does not rewrite the qualified coverage state of a zero-result retained generation", () => {
    driftState = availableGenState({
      drift: [],
      hostStates: {
        "compute-a": { state: "fresh", collectedAt: FIXED, ageMs: 1_000, pastStaleThreshold: false },
      },
      transientError: "Latest refresh failed.",
    });
    renderFragment(HOST_A);
    // The retained coverage state stays `fresh`; the failure is shown separately.
    expect(screen.getByRole("status")).toHaveTextContent("Host collection is fresh.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "showing a retained drift generation that",
    );
  });
});

// ---------------------------------------------------------------------------
// Large-result containment (07 §3.5).
// ---------------------------------------------------------------------------

describe("progressive disclosure", () => {
  function bigState(count: number): DriftGenerationState {
    const drift = Array.from({ length: count }, (_unused, index) => ({
      id: `big-${String(index).padStart(2, "0")}`,
      severity: "info",
      category: "config",
      message: `Big finding ${index}`,
      location: { host: "big" },
    }));
    return availableGenState({
      config: config([hostDecl("big")]),
      drift,
      hostStates: {
        big: { state: "fresh", collectedAt: FIXED, ageMs: 1, pastStaleThreshold: false },
      },
    });
  }
  const BIG: EntityRef = { entity: "host", host: "big" };

  it("mounts only 25 rows initially while stating the full selected count", () => {
    driftState = bigState(60);
    renderFragment(BIG);
    expect(rows()).toHaveLength(25);
    expect(screen.getByRole("status")).toHaveTextContent("60 scoped findings.");
    expect(rowFor("big-59")).toBeNull();
  });

  it("reaches every row through repeated show-more batches", () => {
    driftState = bigState(60);
    renderFragment(BIG);

    fireEvent.click(screen.getByRole("button", { name: "Show 25 more scoped findings" }));
    expect(rows()).toHaveLength(50);

    fireEvent.click(screen.getByRole("button", { name: "Show 10 more scoped findings" }));
    expect(rows()).toHaveLength(60);
    expect(rowFor("big-59")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /more scoped findings/ })).toBeNull();
  });

  it("reveals the full population with show-all and announces it politely", () => {
    driftState = bigState(60);
    renderFragment(BIG);

    fireEvent.click(screen.getByRole("button", { name: "Show all 60 findings" }));
    expect(rows()).toHaveLength(60);

    const live = fragmentRegion().querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent("Showing all 60 findings.");
    expect(live).toHaveAttribute("aria-atomic", "true");
  });
});

// ---------------------------------------------------------------------------
// Focus reconciliation (07 §3.5).
// ---------------------------------------------------------------------------

describe("focus reconciliation on generation change", () => {
  it("moves focus to the heading when the focused row no longer exists", () => {
    driftState = availableGenState({ refreshGeneration: 1 });
    const { rerender } = renderFragment(HOST_A);

    const row = rowFor("a-host-err")!;
    act(() => row.focus());
    expect(row).toHaveFocus();

    // A later generation with no compute-a drift removes that row.
    driftState = availableGenState({
      refreshGeneration: 2,
      drift: [],
      hostStates: {
        "compute-a": { state: "fresh", collectedAt: FIXED, ageMs: 1, pastStaleThreshold: false },
      },
    });
    rerender(<FindingsFragment entity={HOST_A} />);

    expect(
      screen.getByRole("heading", { name: "Drift findings for host compute-a" }),
    ).toHaveFocus();
  });

  it("does not steal focus when the focused row survives the refresh", () => {
    driftState = availableGenState({ refreshGeneration: 1 });
    const { rerender } = renderFragment(HOST_A);

    act(() => rowFor("a-host-err")!.focus());

    // A later generation that still contains the focused finding keeps focus put.
    driftState = availableGenState({ refreshGeneration: 2 });
    rerender(<FindingsFragment entity={HOST_A} />);

    expect(rowFor("a-host-err")).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// Failure isolation (07 §3.5, §7).
// ---------------------------------------------------------------------------

function Boom(): JSX.Element {
  throw new Error("boom");
}

describe("fragment failure isolation", () => {
  it("renders the fixed sanitized fallback when selection throws", () => {
    quietConsoleError();
    const base = availableGenState();
    const throwingProjection = Object.create(base.current!.projection);
    Object.defineProperty(throwingProjection, "findingGroups", {
      enumerable: true,
      get(): never {
        throw new Error("kaboom");
      },
    });
    driftState = {
      ...base,
      current: { ...base.current!, projection: throwingProjection },
    };

    const { container } = renderFragment(HOST_A);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Drift findings could not be displayed.",
    );
    expect(screen.getByRole("region", { name: "Drift findings" })).toBeInTheDocument();
    expect(container).not.toHaveTextContent("kaboom");
  });

  it("isolates a throwing fragment from a sibling fragment", () => {
    quietConsoleError();
    const { container } = render(
      <div>
        <FragmentPresentationBoundary surface="host-fragment">
          <Boom />
        </FragmentPresentationBoundary>
        <FragmentPresentationBoundary surface="service-fragment">
          <p>sibling survives</p>
        </FragmentPresentationBoundary>
      </div>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Drift findings could not be displayed.",
    );
    expect(screen.getByText("sibling survives")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("boom");
  });

  it("emits a sanitized render-error transition from the boundary", () => {
    quietConsoleError();
    __resetDriftRenderDedupForTest();
    const captured: DriftDiagnosticEvent[] = [];
    const restore = setDriftDiagnosticSink((event) => {
      if (event.event === "drift.render" && event.outcome === "error") {
        captured.push(event);
      }
    });

    render(
      <FragmentPresentationBoundary surface="host-fragment">
        <Boom />
      </FragmentPresentationBoundary>,
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toMatchObject({ surface: "host-fragment", outcome: "error" });
    expect(JSON.stringify(captured[0])).not.toContain("boom");
    restore();
  });
});

// ---------------------------------------------------------------------------
// Render diagnostics (07 §7).
// ---------------------------------------------------------------------------

describe("render diagnostics", () => {
  it("emits one fragment render transition per accepted generation", () => {
    __resetDriftRenderDedupForTest();
    const captured: DriftDiagnosticEvent[] = [];
    const restore = setDriftDiagnosticSink((event) => {
      if (event.event === "drift.render" && event.surface === "host-fragment") {
        captured.push(event);
      }
    });

    driftState = availableGenState({ refreshGeneration: 1 });
    const { rerender } = renderFragment(HOST_A);
    expect(captured.filter((e) => e.outcome === "ok").length).toBe(1);

    // An ordinary rerender of the same generation emits no duplicate transition.
    rerender(<FindingsFragment entity={HOST_A} />);
    expect(captured.filter((e) => e.outcome === "ok").length).toBe(1);

    // A new accepted generation emits exactly one further transition.
    driftState = availableGenState({ refreshGeneration: 2 });
    rerender(<FindingsFragment entity={HOST_A} />);
    expect(captured.filter((e) => e.outcome === "ok").length).toBe(2);

    restore();
  });
});

// ===========================================================================
// DriftHealthSummary adapter (07 §5). The health-header slot passes placeholder
// `HealthSummary` props that the adapter ignores; it reads the same drift store
// and adapts the accepted `DriftSummary` into one `/drift` link.
// ===========================================================================

/** Placeholder host props the adapter must ignore (07 §5.1). */
const SUMMARY_PROPS: HealthSummary = {
  label: "placeholder-label",
  status: "warning",
  count: 0,
};

/** Render the summary and return its one `/drift` link. */
function renderSummary(): { link: HTMLElement; result: RenderResult } {
  const result = render(<DriftHealthSummary {...SUMMARY_PROPS} />);
  return { link: screen.getByRole("link"), result };
}

/** Assert the link targets /drift in the given state and carries `text`. */
function expectPill(link: HTMLElement, state: string, text?: string): void {
  expect(link).toHaveAttribute("href", "/drift");
  expect(link).toHaveAttribute("data-drift-summary-state", state);
  if (text !== undefined) expect(link).toHaveTextContent(text);
}

/** One host in the given collection state; drift is derived from `drift`. */
function coverageOnly(state: string, collected = true): AvailableOptions {
  return {
    config: config([hostDecl("solo")]),
    drift: [],
    hostStates: {
      solo: {
        state,
        collectedAt: collected ? FIXED : null,
        ageMs: collected ? 1_000 : null,
        pastStaleThreshold: state === "stale",
      },
    },
  };
}

/** A single unwaived finding of the given severity on a fresh solo host. */
function severityOnly(severity: string): AvailableOptions {
  return {
    config: config([hostDecl("solo")]),
    drift: [
      {
        id: `s-${severity}`,
        severity,
        category: "drift",
        message: `Finding ${severity}`,
        location: { host: "solo" },
      },
    ],
    hostStates: {
      solo: { state: "fresh", collectedAt: FIXED, ageMs: 1_000, pastStaleThreshold: false },
    },
  };
}

describe("DriftHealthSummary — placeholder props are ignored", () => {
  it("never reflects the host's placeholder label/state/detail", () => {
    driftState = availableGenState({ ...coverageOnly("fresh") });
    const { link, result } = renderSummary();
    expect(result.container).not.toHaveTextContent("placeholder-label");
    expect(result.container).not.toHaveTextContent("placeholder-detail");
    // The adapter always links to the drift page and derives its own state.
    expectPill(link, "ok");
  });

  it("imports nothing from alerts-and-health and stays meaningful alone", () => {
    const source = readFileSync(
      new URL(
        "../../../modules/drift/web/DriftHealthSummary.tsx",
        TEST_FILE_URL,
      ),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["'][^"']*alerts-and-health/);
    // Rendered as the only summary contribution, it still produces complete text.
    driftState = availableGenState({ ...coverageOnly("fresh") });
    expect(renderSummary().link).toHaveTextContent("hosts need coverage attention");
  });
});

describe("DriftHealthSummary — deterministic down/warn/ok mapping", () => {
  it("maps active errors to down and reports the highest severity and totals", () => {
    // MIXED_DRIFT summary: error 1, warning 2, info 1 active; 1 active + 1 expired
    // waiver; hosts fresh/stale/unreachable → 2 of 3 need attention.
    driftState = availableGenState();
    expectPill(
      renderSummary().link,
      "down",
      "Error: 1 active; 2 of 3 hosts need coverage attention; 1 active waiver; 1 expired waiver.",
    );
  });

  it("maps an unreachable host with no findings to down", () => {
    driftState = availableGenState({ ...coverageOnly("unreachable", false) });
    expectPill(
      renderSummary().link,
      "down",
      "No active drift; 1 of 1 hosts need coverage attention; 0 active waivers; 0 expired waivers.",
    );
  });

  it("maps a highest active warning (no error, no unreachable) to warn", () => {
    driftState = availableGenState({ ...severityOnly("warning") });
    expectPill(renderSummary().link, "warn", "Warning: 1 active;");
  });

  it("maps a highest active info to warn", () => {
    driftState = availableGenState({ ...severityOnly("info") });
    expectPill(renderSummary().link, "warn", "Info: 1 active;");
  });

  it("maps qualified zero risk with complete fresh coverage to ok", () => {
    driftState = availableGenState({ ...coverageOnly("fresh") });
    expectPill(
      renderSummary().link,
      "ok",
      "No active drift; 0 of 1 hosts need coverage attention; 0 active waivers; 0 expired waivers.",
    );
  });
});

describe("DriftHealthSummary — coverage attention states", () => {
  it("counts a stale host as attention and maps it to warn", () => {
    driftState = availableGenState({ ...coverageOnly("stale") });
    expectPill(renderSummary().link, "warn", "1 of 1 hosts need coverage attention");
  });

  it("counts a partial host as attention and maps it to warn", () => {
    driftState = availableGenState({ ...coverageOnly("partial") });
    expectPill(renderSummary().link, "warn", "1 of 1 hosts need coverage attention");
  });

  it("counts a never-collected host as attention and maps it to warn", () => {
    driftState = availableGenState({ ...coverageOnly("never-collected", false) });
    expectPill(renderSummary().link, "warn", "1 of 1 hosts need coverage attention");
  });
});

describe("DriftHealthSummary — waivers", () => {
  it("maps an active-waiver-only generation to warn with explicit counts", () => {
    driftState = availableGenState({
      config: config([hostDecl("solo")]),
      drift: [
        {
          id: "aw",
          severity: "error",
          category: "config",
          message: "Waived",
          location: { host: "solo" },
          waiver: { reason: "planned", who: "ops", until: FUTURE },
        },
      ],
      hostStates: {
        solo: { state: "fresh", collectedAt: FIXED, ageMs: 1_000, pastStaleThreshold: false },
      },
    });
    // Active waiver suppresses active risk, so severity is "no active drift".
    expectPill(
      renderSummary().link,
      "warn",
      "No active drift; 0 of 1 hosts need coverage attention; 1 active waiver; 0 expired waivers.",
    );
  });

  it("discloses an expired waiver both as active risk and as an expired waiver", () => {
    driftState = availableGenState({
      config: config([hostDecl("solo")]),
      drift: [
        {
          id: "ew",
          severity: "warning",
          category: "drift",
          message: "Lapsed",
          location: { host: "solo" },
          waiver: { reason: "lapsed", who: "ops", until: PAST },
        },
      ],
      hostStates: {
        solo: { state: "fresh", collectedAt: FIXED, ageMs: 1_000, pastStaleThreshold: false },
      },
    });
    expectPill(
      renderSummary().link,
      "warn",
      "Warning: 1 active; 0 of 1 hosts need coverage attention; 0 active waivers; 1 expired waiver.",
    );
  });
});

describe("DriftHealthSummary — availability and failure states", () => {
  it("states no snapshot configured as a warning contribution", () => {
    driftState = unavailableGenState(NOT_CONFIGURED);
    expectPill(renderSummary().link, "warn", "Drift unavailable — no snapshot configured");
  });

  it("states pending first read as a warning contribution", () => {
    driftState = unavailableGenState(pendingState());
    expectPill(renderSummary().link, "warn", "Drift pending — snapshot read in progress");
  });

  it("states a failed first read as a down contribution", () => {
    driftState = unavailableGenState(failedEmptyState("First poll failed."));
    const { link, result } = renderSummary();
    expectPill(link, "down", "Drift unavailable — snapshot read failed");
    // No arbitrary provider message leaks into the compact contribution.
    expect(result.container).not.toHaveTextContent("First poll failed.");
  });

  it("states a failed first derivation without a retained generation as down", () => {
    driftState = unavailableGenState(availableState(availableResult({})), {
      config: DEFAULT_CONFIG,
      derivationError: "Drift data could not be prepared.",
    });
    const { link, result } = renderSummary();
    expectPill(link, "down", "Drift unavailable — projection failed");
    expect(result.container).not.toHaveTextContent("Drift data could not be prepared.");
  });
});

describe("DriftHealthSummary — retained failure and recovery", () => {
  it("retains adapted counts, forces at least warn, and appends the fixed phrase", () => {
    // Base would be ok (no drift, fresh coverage); a retained failure forces warn.
    driftState = availableGenState({
      ...coverageOnly("fresh"),
      transientError: "Latest refresh failed.",
    });
    const { link, result } = renderSummary();
    expectPill(
      link,
      "warn",
      "No active drift; 0 of 1 hosts need coverage attention; 0 active waivers; 0 expired waivers.",
    );
    expect(link).toHaveTextContent("Retained snapshot; refresh failed.");
    // The sanitized store message never appears in the compact contribution.
    expect(result.container).not.toHaveTextContent("Latest refresh failed.");
  });

  it("keeps a down base down while still appending the retained phrase", () => {
    driftState = availableGenState({ transientError: "Latest refresh failed." });
    expectPill(renderSummary().link, "down", "Retained snapshot; refresh failed.");
  });

  it("clears the failure phrase atomically on a later accepted success", () => {
    driftState = availableGenState({
      ...coverageOnly("fresh"),
      refreshGeneration: 1,
      transientError: "Latest refresh failed.",
    });
    const { link, result } = renderSummary();
    expectPill(link, "warn", "Retained snapshot; refresh failed.");

    // A later clean generation removes the failure phrase in the same render.
    driftState = availableGenState({ ...coverageOnly("fresh"), refreshGeneration: 2 });
    result.rerender(<DriftHealthSummary {...SUMMARY_PROPS} />);
    const next = screen.getByRole("link");
    expect(next).not.toHaveTextContent("Retained snapshot; refresh failed.");
    expectPill(next, "ok");
  });
});

describe("DriftHealthSummary — failure isolation", () => {
  it("renders the fixed sanitized fallback when adaptation throws", () => {
    quietConsoleError();
    const base = availableGenState();
    const throwingProjection = Object.create(base.current!.projection);
    Object.defineProperty(throwingProjection, "summary", {
      enumerable: true,
      get(): never {
        throw new Error("kaboom");
      },
    });
    driftState = {
      ...base,
      current: { ...base.current!, projection: throwingProjection },
    };

    const { container } = render(<DriftHealthSummary {...SUMMARY_PROPS} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Drift summary unavailable");
    expect(container).not.toHaveTextContent("kaboom");
    expect(screen.getByRole("link", { name: "Drift summary unavailable" })).toHaveAttribute(
      "href",
      "/drift",
    );
  });

  it("isolates a throwing summary from a sibling summary", () => {
    quietConsoleError();
    const { container } = render(
      <div>
        <SummaryPresentationBoundary>
          <Boom />
        </SummaryPresentationBoundary>
        <SummaryPresentationBoundary>
          <span>other summary survives</span>
        </SummaryPresentationBoundary>
      </div>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Drift summary unavailable");
    expect(screen.getByText("other summary survives")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("boom");
  });

  it("emits a sanitized summary render-error transition from the boundary", () => {
    quietConsoleError();
    __resetDriftRenderDedupForTest();
    const captured: DriftDiagnosticEvent[] = [];
    const restore = setDriftDiagnosticSink((event) => {
      if (event.event === "drift.render" && event.outcome === "error") {
        captured.push(event);
      }
    });

    render(
      <SummaryPresentationBoundary>
        <Boom />
      </SummaryPresentationBoundary>,
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toMatchObject({ surface: "summary", outcome: "error" });
    expect(JSON.stringify(captured[0])).not.toContain("boom");
    restore();
  });
});

describe("DriftHealthSummary — render diagnostics", () => {
  it("emits one summary render transition per accepted generation", () => {
    __resetDriftRenderDedupForTest();
    const captured: DriftDiagnosticEvent[] = [];
    const restore = setDriftDiagnosticSink((event) => {
      if (event.event === "drift.render" && event.surface === "summary") {
        captured.push(event);
      }
    });

    driftState = availableGenState({ ...coverageOnly("fresh"), refreshGeneration: 1 });
    const { result } = renderSummary();
    expect(captured.filter((e) => e.outcome === "ok").length).toBe(1);

    // An ordinary rerender of the same generation emits no duplicate transition.
    result.rerender(<DriftHealthSummary {...SUMMARY_PROPS} />);
    expect(captured.filter((e) => e.outcome === "ok").length).toBe(1);

    // A new accepted generation emits exactly one further transition.
    driftState = availableGenState({ ...coverageOnly("fresh"), refreshGeneration: 2 });
    result.rerender(<DriftHealthSummary {...SUMMARY_PROPS} />);
    expect(captured.filter((e) => e.outcome === "ok").length).toBe(2);

    restore();
  });
});

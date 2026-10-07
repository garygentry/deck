// @vitest-environment jsdom
import { deriveDriftProjection } from "@deck/drift";
import type { SnapshotProviderResult } from "@deck/contract";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { JSX } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  availableState,
  config,
  failedEmptyState,
  hostDecl,
  installInventoryTimers,
  makeGeneration,
  NOT_CONFIGURED,
  pendingState,
  resetInventoryTestEnv,
  serviceDecl,
} from "./inventory-harness.js";
import type { InventoryGeneration } from "../src/features/hosts-and-services/inventory-store.js";
import type { DriftGenerationState } from "../src/features/drift-and-coverage/store.js";
import { buildAboveScaleFixture, DRIFT_FIXTURE_NOW } from "./drift-fixtures.js";

// ---------------------------------------------------------------------------
// The page subscribes only through `useDriftGeneration`; every case drives one
// controlled `DriftGenerationState`. `useLocation` is mocked so raw-URL scope and
// replacement navigation are observable without a router. All identities are
// invented and deterministic. Queries are by role/text; the only DOM hooks are
// the stable result-row id prefixes and the evidence `data-drift-evidence` field.
// ---------------------------------------------------------------------------

let driftState: DriftGenerationState;
vi.mock("../src/features/drift-and-coverage/use-drift-generation.js", () => ({
  useDriftGeneration: () => driftState,
}));

let locationUrl = "/drift";
const routeCalls: Array<[string, boolean | undefined]> = [];
vi.mock("@/shell/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shell/router")>();
  return {
    ...actual,
    useLocation: () => ({
      url: locationUrl,
      path: "/drift",
      query: {},
      route: (url: string, replace?: boolean) => {
        routeCalls.push([url, replace]);
      },
      back: () => {},
      forward: () => {},
    }),
  };
});

import {
  DriftPage,
  DriftPageBoundary,
} from "../src/features/drift-and-coverage/DriftPage.js";
import {
  __resetDriftRenderDedupForTest,
  setDriftDiagnosticSink,
} from "../src/features/drift-and-coverage/diagnostics.js";
import type { DriftDiagnosticEvent } from "../src/features/drift-and-coverage/diagnostics.js";
import { FindingGroups } from "../src/features/drift-and-coverage/components/FindingGroups.js";
import { FindingRow } from "../src/features/drift-and-coverage/components/FindingRow.js";
import { EvidenceValue } from "../src/features/drift-and-coverage/components/EvidenceValue.js";
import { CoverageTable } from "../src/features/drift-and-coverage/components/CoverageTable.js";
import {
  buildInventoryModel,
  type InventoryModel,
} from "../src/features/hosts-and-services/model.js";
import type { CoverageRow, DriftFindingProjection, FindingHostGroup } from "@deck/drift";

// ---------------------------------------------------------------------------
// jsdom gaps used by Radix Popover / cmdk / Tooltip (this file only).
// ---------------------------------------------------------------------------

const restores: (() => void)[] = [];
beforeAll(() => {
  // Silence and isolate the default console diagnostic sink for the whole suite.
  setDriftDiagnosticSink(() => {});

  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const g = globalThis as { ResizeObserver?: unknown };
  const previous = g.ResizeObserver;
  g.ResizeObserver = ResizeObserverStub;
  restores.push(() => {
    g.ResizeObserver = previous;
  });
  // Floating UI probes `el.matches(":modal")` / `":popover-open"`; nwsapi takes
  // ~20 s per `:modal` call. Answer those two directly.
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string): boolean {
    if (selector === ":modal" || selector === ":popover-open") return false;
    return matches.call(this, selector);
  };
  restores.push(() => {
    Element.prototype.matches = matches;
  });
  const proto = Element.prototype as unknown as Record<string, unknown>;
  for (const name of ["scrollIntoView", "hasPointerCapture", "releasePointerCapture"]) {
    if (!(name in proto)) {
      proto[name] = () => false;
      restores.push(() => {
        delete proto[name];
      });
    }
  }
});
afterAll(() => {
  for (const restore of restores) restore();
});

afterEach(() => {
  cleanup();
  resetInventoryTestEnv();
  routeCalls.length = 0;
  locationUrl = "/drift";
});

// ---------------------------------------------------------------------------
// Deterministic fixtures.
// ---------------------------------------------------------------------------

const FIXED = "2030-01-01T00:00:00.000Z";
const CLOCK = new Date("2030-06-01T00:00:00.000Z");

const DEFAULT_CONFIG = config(
  [hostDecl("compute-a"), hostDecl("compute-b"), hostDecl("compute-c")],
  [serviceDecl("compute-a", "api"), serviceDecl("compute-b", "web")],
);

const DEFAULT_DRIFT = [
  {
    id: "f-error",
    severity: "error",
    category: "config",
    message: "Alpha mismatch",
    location: { host: "compute-a" },
  },
  {
    id: "f-warn",
    severity: "warning",
    category: "drift",
    message: "Beta warning",
    location: { host: "compute-a", service: "api" },
  },
  {
    id: "f-info",
    severity: "info",
    category: "config",
    message: "Gamma info",
    location: { host: "compute-b", service: "web" },
  },
];

const DEFAULT_HOST_STATES: Record<string, unknown> = {
  "compute-a": {
    state: "fresh",
    collectedAt: FIXED,
    ageMs: 1_000,
    pastStaleThreshold: false,
  },
  "compute-b": {
    state: "stale",
    collectedAt: FIXED,
    ageMs: 1_000,
    pastStaleThreshold: true,
  },
  "compute-c": {
    state: "unreachable",
    collectedAt: null,
    ageMs: null,
    pastStaleThreshold: false,
  },
};

interface AvailableOptions {
  drift?: unknown[];
  hostStates?: Record<string, unknown>;
  hosts?: unknown[];
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
      hosts: over.hosts ?? [],
      drift: over.drift ?? DEFAULT_DRIFT,
    },
    findings: [],
    hostStates: over.hostStates ?? DEFAULT_HOST_STATES,
    lastReadAt: FIXED,
    readError: over.readError ?? null,
  } as unknown as SnapshotProviderResult;
}

/** One available, matching projection/model generation state. */
function availableGenState(over: AvailableOptions = {}): DriftGenerationState {
  const result = availableResult(over);
  const clientState = availableState(result);
  if (clientState.status !== "available") throw new Error("expected available");
  const gen = makeGeneration({
    config: DEFAULT_CONFIG,
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
    refreshGeneration?: number;
    transientError?: string | null;
    derivationError?: string | null;
  } = {},
): DriftGenerationState {
  const gen = makeGeneration({
    config: over.config ?? null,
    snapshot,
    refreshGeneration: over.refreshGeneration ?? 0,
    transientError: over.transientError ?? null,
  }) as unknown as InventoryGeneration;
  return {
    inventory: gen,
    current: null,
    derivationError: over.derivationError ?? null,
  };
}

// ---------------------------------------------------------------------------
// Query helpers.
// ---------------------------------------------------------------------------

/** Mount the page; `rerender()` re-renders it against the current `driftState`. */
function mountPage(): { rerender(): void; unmount(): void } {
  const view = render(<DriftPage />);
  return {
    rerender: () => view.rerender(<DriftPage />),
    unmount: () => view.unmount(),
  };
}

/** The whole document's text. */
function pageText(): string {
  return document.body.textContent ?? "";
}

/**
 * The one element with explicit `role` whose text contains `text`. (A direct
 * attribute query: `getAllByRole` walks the accessibility tree of the whole
 * document, which is prohibitively slow at the above-scale population.)
 */
function roleWithText(role: "status" | "alert", text: string): HTMLElement {
  const match = Array.from(
    document.querySelectorAll<HTMLElement>(`[role="${role}"]`),
  ).find((el) => (el.textContent ?? "").includes(text));
  if (match === undefined) throw new Error(`no ${role} containing "${text}"`);
  return match;
}

/**
 * A button by its accessible name (`aria-label`, else its text), without an
 * accessibility-tree walk; used where the page mounts the above-scale population.
 */
function buttonNamed(name: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>("button")).find(
    (button) => (button.getAttribute("aria-label") ?? button.textContent) === name,
  );
  if (match === undefined) throw new Error(`no button named "${name}"`);
  return match;
}

/** The polite filtered-population status line. */
function statusLine(): HTMLElement {
  return roleWithText("status", "Showing");
}

/** Open a facet popover (idempotent) and toggle one of its options. */
function toggleFacet(title: string, option: string): void {
  const search = document.querySelector<HTMLElement>('[role="search"][aria-label="Drift filters"]');
  if (search === null) throw new Error("no Drift filters landmark");
  const trigger = within(search).getByRole("button", { name: new RegExp(`^${title}`) });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    act(() => {
      fireEvent.click(trigger);
    });
  }
  const list = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
    (candidate) => candidate.getAttribute("aria-label") === title,
  );
  if (list === undefined) throw new Error(`no ${title} listbox`);
  act(() => {
    fireEvent.click(within(list).getByRole("option", { name: option }));
  });
}

/** Click a button found by `buttonNamed`. */
function clickFast(name: string): void {
  act(() => {
    fireEvent.click(buttonNamed(name));
  });
}

/** Click a button by its accessible name. */
function clickButton(name: string | RegExp): void {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/** All mounted finding-row roots in DOM order. */
function findingRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('li[id^="drift-finding-"]'));
}

/** All mounted coverage-row roots in DOM order. */
function coverageRowEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('tr[id^="drift-coverage-"]'));
}

/** Count elements carrying the exact id (collision-safe result ids appear once). */
function idCount(id: string): number {
  return document.querySelectorAll(`[id="${id}"]`).length;
}

/** The page search field. */
function searchBox(): HTMLElement {
  return screen.getByRole("searchbox", { name: "Search drift findings" });
}

/** Silence React's and the boundary's expected error logging for one test. */
function silenceErrors(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

// ---------------------------------------------------------------------------
// Unavailable states (06 §5.1).
// ---------------------------------------------------------------------------

describe("unavailable generation states", () => {
  it("renders a distinct no-configuration status", () => {
    driftState = unavailableGenState(NOT_CONFIGURED);
    render(<DriftPage />);
    expect(roleWithText("status", "No snapshot is configured.")).toBeInTheDocument();
    expect(screen.queryByText("No drift reported.")).toBeNull();
  });

  it("renders a distinct pending status", () => {
    driftState = unavailableGenState(pendingState());
    render(<DriftPage />);
    expect(roleWithText("status", "Waiting for the first snapshot read.")).toBeInTheDocument();
  });

  it("renders a failed-empty read alert with the sanitized envelope message", () => {
    driftState = unavailableGenState(failedEmptyState("First poll failed."));
    render(<DriftPage />);
    const alert = roleWithText(
      "alert",
      "Snapshot read failed; no retained snapshot is available.",
    );
    expect(alert).toHaveTextContent("First poll failed.");
  });

  it("renders a first-request failure alert with the sanitized client message", () => {
    driftState = unavailableGenState(pendingState(), {
      transientError: "check the deck server connection.",
    });
    render(<DriftPage />);
    const alert = roleWithText(
      "alert",
      "Snapshot request failed; no retained snapshot is available.",
    );
    expect(alert).toHaveTextContent("check the deck server connection.");
  });

  it("renders a first-derivation failure alert without counts", () => {
    const snapshot = availableState(availableResult({}));
    driftState = unavailableGenState(snapshot, {
      config: DEFAULT_CONFIG,
      derivationError: "Drift data could not be prepared.",
      refreshGeneration: 1,
    });
    render(<DriftPage />);
    const alert = roleWithText("alert", "Drift view could not be derived.");
    expect(alert).toHaveTextContent("Drift data could not be prepared.");
    expect(screen.queryByText("No drift reported.")).toBeNull();
    expect(screen.queryByRole("region", { name: "Overview" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Overview and available state (06 §3).
// ---------------------------------------------------------------------------

describe("available overview and totals", () => {
  it("labels every complete-generation population with its counts", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Drift and collection coverage" }),
    ).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "Overview" });
    for (const phrase of [
      "Active drift — all findings in this snapshot generation",
      "Waivers — all findings in this snapshot generation",
      "Collection coverage — all hosts in this snapshot generation",
      "Snapshot evidence",
      "Last successful read",
      "Oldest available host collection",
    ]) {
      expect(within(overview).getByText(phrase)).toBeInTheDocument();
    }
    const terms = within(overview)
      .getAllByRole("term")
      .map((term) => term.textContent);
    for (const label of [
      "Error",
      "Warning",
      "Info",
      "Fresh",
      "Stale",
      "Partial",
      "Unreachable",
      "Never collected",
      "Total coverage hosts",
    ]) {
      expect(terms).toContain(label);
    }
    expect(overview).toHaveTextContent(/Oldest available host collection.*\(compute-b\)/);
  });

  it("reports the filtered population beside the complete totals", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    expect(statusLine()).toHaveTextContent(
      "Showing 3 of 3 findings across 2 host groups; showing 3 of 3 coverage hosts.",
    );
  });

  it("renders the oldest-collection fallback when no timestamp exists", () => {
    driftState = availableGenState({
      hostStates: {
        "compute-c": {
          state: "unreachable",
          collectedAt: null,
          ageMs: null,
          pastStaleThreshold: false,
        },
      },
      drift: [],
    });
    render(<DriftPage />);
    expect(
      screen.getByText("No host collection timestamps are available."),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Qualified no-drift and no-match (06 §3.3).
// ---------------------------------------------------------------------------

describe("qualified empty states", () => {
  it("says 'No drift reported.' beside retained coverage totals", () => {
    driftState = availableGenState({ drift: [] });
    render(<DriftPage />);
    expect(roleWithText("status", "No drift reported.")).toBeInTheDocument();
    // Coverage totals remain visible in the overview.
    expect(screen.getByText("Total coverage hosts")).toBeInTheDocument();
    expect(
      screen.queryByText("No findings match the current scope and filters."),
    ).toBeNull();
  });

  it("says 'No findings match' when filters remove every finding", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    fireEvent.change(searchBox(), { target: { value: "zzz-nothing" } });
    expect(
      roleWithText("status", "No findings match the current scope and filters."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No drift reported.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// URL scope (06 §4).
// ---------------------------------------------------------------------------

describe("URL entity scope", () => {
  it("composes a valid host scope over findings and coverage", () => {
    locationUrl = "/drift?host=compute-a";
    driftState = availableGenState();
    render(<DriftPage />);
    expect(statusLine()).toHaveTextContent(
      "Showing 2 of 3 findings across 1 host groups; showing 1 of 3 coverage hosts.",
    );
    expect(statusLine()).toHaveTextContent("Entity scope: host compute-a.");
  });

  it("composes a valid service scope to the exact host/service", () => {
    locationUrl = "/drift?host=compute-a&service=api";
    driftState = availableGenState();
    render(<DriftPage />);
    expect(statusLine()).toHaveTextContent(
      "Showing 1 of 3 findings across 1 host groups; showing 1 of 3 coverage hosts.",
    );
    expect(statusLine()).toHaveTextContent("Entity scope: service api on compute-a.");
  });

  it("explains an unknown-entity scope and offers to show all", () => {
    locationUrl = "/drift?host=ghost";
    driftState = availableGenState();
    render(<DriftPage />);
    const alert = roleWithText("alert", "No matching host or service was found");
    expect(
      within(alert).getByRole("button", { name: "Show all drift and coverage" }),
    ).toBeInTheDocument();
    // Overview totals are retained; findings are not silently emptied.
    expect(statusLine()).toHaveTextContent("Showing 3 of 3 findings");
  });

  it("explains a malformed-encoding scope without throwing", () => {
    locationUrl = "/drift?host=%E0%A4%A";
    driftState = availableGenState();
    render(<DriftPage />);
    expect(roleWithText("alert", "malformed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show all drift and coverage" }),
    ).toBeInTheDocument();
  });

  it("clears a valid scope from its chip with replacement navigation", () => {
    locationUrl = "/drift?host=compute-a";
    driftState = availableGenState();
    render(<DriftPage />);
    clickButton("Remove entity scope Host compute-a");
    expect(routeCalls).toContainEqual(["/drift", true]);
  });

  it("clears an unknown scope from the show-all action", () => {
    locationUrl = "/drift?host=ghost";
    driftState = availableGenState();
    render(<DriftPage />);
    clickButton("Show all drift and coverage");
    expect(routeCalls).toContainEqual(["/drift", true]);
  });
});

// ---------------------------------------------------------------------------
// Local filters, composition, chips, and clears (06 §4.3).
// ---------------------------------------------------------------------------

describe("local filters and chips", () => {
  it("offers the six facets inside the labelled search landmark", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    const search = screen.getByRole("search", { name: "Drift filters" });
    for (const title of [
      "Severity",
      "Host/service",
      "Category",
      "Waiver status",
      "Coverage host",
      "Coverage state",
    ]) {
      expect(
        within(search).getByRole("button", { name: new RegExp(`^${title}`) }),
      ).toBeInTheDocument();
    }
    expect(within(search).getByRole("searchbox")).toBe(searchBox());
  });

  it("filters findings by severity without removing coverage rows", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    toggleFacet("Severity", "Error");
    expect(statusLine()).toHaveTextContent(
      "Showing 1 of 3 findings across 1 host groups; showing 3 of 3 coverage hosts. Local filters active.",
    );
  });

  it("filters coverage by state without removing findings", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    toggleFacet("Coverage state", "Unreachable");
    expect(statusLine()).toHaveTextContent(
      "Showing 3 of 3 findings across 2 host groups; showing 1 of 3 coverage hosts. Local filters active.",
    );
  });

  it("filters findings by host/service, category, and waiver", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    toggleFacet("Host/service", "api on compute-a");
    expect(statusLine()).toHaveTextContent("Showing 1 of 3 findings");
    expect(
      screen.getByRole("button", { name: "Remove service filter api on compute-a" }),
    ).toBeInTheDocument();
    toggleFacet("Host/service", "api on compute-a");
    toggleFacet("Category", "config");
    expect(statusLine()).toHaveTextContent("Showing 2 of 3 findings");
    toggleFacet("Waiver status", "Active waiver");
    expect(statusLine()).toHaveTextContent("Showing 0 of 3 findings");
  });

  it("exposes a removable chip for each active criterion", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    toggleFacet("Severity", "Error");
    clickButton("Remove severity filter Error");
    expect(
      screen.queryByRole("button", { name: "Remove severity filter Error" }),
    ).toBeNull();
    expect(statusLine()).toHaveTextContent("Showing 3 of 3 findings");
  });

  it("offers clear-local and clear-all only when criteria exist", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    expect(screen.queryByRole("button", { name: "Clear local filters" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear all filters and scope" }),
    ).toBeNull();
    toggleFacet("Severity", "Warning");
    clickButton("Clear local filters");
    expect(statusLine()).toHaveTextContent("Showing 3 of 3 findings");
    expect(screen.queryByRole("button", { name: "Clear local filters" })).toBeNull();
  });

  it("clears all filters and scope with replacement navigation", () => {
    locationUrl = "/drift?host=compute-a";
    driftState = availableGenState();
    render(<DriftPage />);
    toggleFacet("Severity", "Error");
    clickButton("Clear all filters and scope");
    expect(routeCalls).toContainEqual(["/drift", true]);
    expect(statusLine()).not.toHaveTextContent("Local filters active");
  });
});

// ---------------------------------------------------------------------------
// Retained warnings and recovery (06 §5.2).
// ---------------------------------------------------------------------------

describe("retained warnings and recovery", () => {
  it("shows the independent inventory, read, and derivation warnings", () => {
    driftState = availableGenState({
      readError: { code: "READ", message: "Snapshot read timed out." },
      transientError: "Latest inventory request failed.",
      derivationError: "Drift data could not be prepared.",
    });
    render(<DriftPage />);
    expect(
      roleWithText("alert", "Latest inventory request failed; showing retained data."),
    ).toBeInTheDocument();
    expect(
      roleWithText(
        "alert",
        "Latest snapshot read failed; showing the last successful snapshot.",
      ),
    ).toHaveTextContent("Snapshot read timed out.");
    expect(
      roleWithText(
        "alert",
        "Latest drift derivation failed; showing the previous complete generation.",
      ),
    ).toBeInTheDocument();
    // Overview totals remain complete despite the warnings.
    expect(statusLine()).toHaveTextContent("Showing 3 of 3 findings");
  });

  it("clears warnings and announces an atomic recovery", () => {
    driftState = availableGenState({
      readError: { code: "READ", message: "Snapshot read timed out." },
      refreshGeneration: 1,
    });
    const page = mountPage();
    expect(
      roleWithText(
        "alert",
        "Latest snapshot read failed; showing the last successful snapshot.",
      ),
    ).toBeInTheDocument();
    driftState = availableGenState({ refreshGeneration: 2 });
    page.rerender();
    expect(pageText()).not.toContain(
      "Latest snapshot read failed; showing the last successful snapshot.",
    );
    const announcement = screen.getByText("Drift data updated");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
  });
});

// ---------------------------------------------------------------------------
// Page boundary and read-only behavior (06 §10.1, §4.4).
// ---------------------------------------------------------------------------

describe("page boundary and read-only behavior", () => {
  it("isolates a render failure and remounts content on retry without fetching", () => {
    silenceErrors();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    let shouldThrow = true;
    function Thrower(): JSX.Element {
      if (shouldThrow) throw new Error("boom");
      return <p>Recovered content</p>;
    }

    render(
      <DriftPageBoundary>
        <Thrower />
      </DriftPageBoundary>,
    );
    expect(
      screen.getByRole("heading", { name: "Drift view could not be displayed" }),
    ).toBeInTheDocument();
    expect(
      roleWithText("alert", "The snapshot may still be available."),
    ).toBeInTheDocument();
    expect(pageText()).not.toContain("boom");

    shouldThrow = false;
    clickButton("Retry drift view");
    expect(screen.getByText("Recovered content")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("performs no fetch while rendering an available generation", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    driftState = availableGenState();
    render(<DriftPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Grouped findings, inert evidence, and progressive disclosure (06 §§6, 03 §§5–7).
// ---------------------------------------------------------------------------

/** The default accepted-generation inventory model (compute-a/b/c, api, web). */
function defaultModel(): InventoryModel {
  const gen = availableGenState();
  if (gen.current === null) throw new Error("expected current");
  return gen.current.inventory.model as InventoryModel;
}

/** A model whose sole declared host carries the supplied (possibly hostile) name. */
function modelWithHost(name: string): InventoryModel {
  const clientState = availableState(availableResult({}));
  if (clientState.status !== "available") throw new Error("expected available");
  return buildInventoryModel(config([hostDecl(name)], []), clientState);
}

/** Build one projected finding with inert defaults and targeted overrides. */
function finding(over: Partial<DriftFindingProjection> = {}): DriftFindingProjection {
  return {
    id: "f1",
    severity: "error",
    category: "config",
    message: "msg",
    host: "compute-a",
    service: null,
    path: null,
    expected: undefined,
    observed: undefined,
    waiver: null,
    waiverState: "unwaived",
    waiverWarning: null,
    ...over,
  };
}

/** Render one finding row inside its list. */
function renderRow(f: DriftFindingProjection, model = defaultModel()): void {
  render(
    <ol>
      <FindingRow finding={f} model={model} resultId="r" />
    </ol>,
  );
}

describe("grouped findings rendering", () => {
  it("renders every finding once under its host/service subgroup in projection order", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    const findings = screen.getByRole("region", { name: "Findings" });
    for (const name of ["Host: compute-a", "Host: compute-b"]) {
      expect(within(findings).getByRole("heading", { level: 3, name })).toBeInTheDocument();
    }
    expect(
      within(findings).getByRole("heading", { level: 4, name: "Host-level findings" }),
    ).toBeInTheDocument();
    for (const name of ["Service: api", "Service: web"]) {
      expect(within(findings).getByRole("heading", { level: 4, name })).toBeInTheDocument();
    }
    expect(within(findings).getAllByText(/findings in this host group/)).toHaveLength(2);

    for (const id of ["f-error", "f-warn", "f-info"]) {
      expect(idCount(`drift-finding-${id}`)).toBe(1);
    }

    const expectedOrder: string[] = [];
    for (const group of driftState.current!.projection.findingGroups) {
      for (const subgroup of group.subgroups) {
        for (const f of subgroup.findings) expectedOrder.push(`drift-finding-${f.id}`);
      }
    }
    expect(findingRows().map((li) => li.id)).toEqual(expectedOrder);
    for (const row of findingRows()) expect(row).toHaveAttribute("tabindex", "-1");

    // Required visible metadata.
    const first = findingRows()[0]!;
    expect(within(first).getByText("Alpha mismatch")).toBeInTheDocument();
    expect(within(first).getByText("Error")).toBeInTheDocument();
    expect(within(findingRows()[1]!).getByText("Warning")).toBeInTheDocument();
  });

  it("labels every supplied metadata field of a finding", () => {
    renderRow(finding({ id: "meta", service: "api", path: "/etc/x.conf", category: "cfg" }));
    const terms = screen.getAllByRole("term").map((t) => t.textContent?.replace(":", ""));
    expect(terms).toEqual(
      expect.arrayContaining(["Severity", "Waiver", "Category", "Finding", "Host", "Service", "Path"]),
    );
    expect(screen.getByText("/etc/x.conf")).toBeInTheDocument();
    expect(screen.getByText("meta")).toBeInTheDocument();
  });
});

describe("finding link resolution", () => {
  it("links to the exact service detail when it resolves", () => {
    renderRow(finding({ id: "s", host: "compute-a", service: "api" }));
    const link = screen.getByRole("link", { name: "View service api on compute-a" });
    expect(link).toHaveAttribute("href", "/services/compute-a/api");
  });

  it("falls back to the host link for an unresolved service name", () => {
    renderRow(finding({ host: "compute-a", service: "ghost" }));
    const link = screen.getByRole("link", { name: "View host compute-a" });
    expect(link).toHaveAttribute("href", "/hosts/compute-a");
  });

  it("links to the host for a host-level finding", () => {
    renderRow(finding({ host: "compute-b", service: null }));
    expect(screen.getByRole("link")).toHaveAttribute("href", "/hosts/compute-b");
  });

  it("shows unresolved text with no anchor for an unknown host", () => {
    renderRow(finding({ host: "ghost", service: null }));
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.getByText(
        "Location unresolved; no host or service detail link is available.",
      ),
    ).toBeInTheDocument();
  });

  it("treats a route-helper URIError as unresolved with no anchor", () => {
    const lone = "lone\uD800surrogate";
    renderRow(finding({ host: lone, service: null }), modelWithHost(lone));
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Location unresolved/)).toBeInTheDocument();
  });
});

describe("finding waiver rendering", () => {
  it("renders active waiver metadata inertly", () => {
    renderRow(
      finding({
        waiverState: "active",
        waiver: {
          reason: "approved",
          who: "ops",
          until: "2999-01-01T00:00:00.000Z",
        },
      }),
    );
    expect(screen.getByText("Active waiver")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Waiver details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("ops")).toBeInTheDocument();
    expect(screen.getByText("2999-01-01T00:00:00.000Z")).toBeInTheDocument();
  });

  it("renders expired waiver, no-expiry, and the waiver warning", () => {
    renderRow(
      finding({
        waiverState: "expired",
        waiver: { reason: "stale", who: "ops" },
        waiverWarning: "Waiver expiry is malformed.",
      }),
    );
    expect(screen.getByText("Expired waiver")).toBeInTheDocument();
    expect(roleWithText("alert", "Waiver expiry is malformed.")).toBeInTheDocument();
    clickButton("Waiver details");
    expect(screen.getByText("No expiry")).toBeInTheDocument();
  });

  it("shows only the unwaived state when no waiver is present", () => {
    renderRow(finding({ waiverState: "unwaived" }));
    expect(screen.getByText("Unwaived")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Waiver details" })).toBeNull();
  });
});

describe("inert evidence rendering", () => {
  it("distinguishes absent evidence from a supplied null value", () => {
    renderRow(finding({ expected: undefined, observed: null }));
    expect(screen.getByText(/^Expected:/)).toHaveTextContent("Expected: Not supplied");
    const observed = document.querySelector('[data-drift-evidence="Observed"]');
    expect(observed).not.toBeNull();
    expect(observed).toHaveTextContent("null");
  });

  it("renders falsy JSON values rather than omitting them", () => {
    renderRow(finding({ expected: false, observed: 0 }));
    expect(document.querySelector('[data-drift-evidence="Expected"]')).toHaveTextContent(
      "false",
    );
    expect(document.querySelector('[data-drift-evidence="Observed"]')).toHaveTextContent(
      "0",
    );
  });

  it("renders hostile evidence strings as inert text, never markup", () => {
    const hostile = "<script>alert(1)</script>";
    render(<EvidenceValue label="Expected" value={hostile} />);
    expect(pageText()).toContain(hostile);
    expect(document.querySelectorAll("script")).toHaveLength(0);
  });

  it("bounds a deep value and discloses depth truncation", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    render(<EvidenceValue label="Expected" value={deep} limits={{ maxDepth: 1 }} />);
    expect(screen.getByText(/Preview truncated by depth/)).toBeInTheDocument();
    expect(pageText()).toContain("truncated …");
    expect(
      screen.getByRole("button", { name: "Inspect full expected value" }),
    ).toBeInTheDocument();
  });

  it("bounds a large value and discloses size truncation", () => {
    const big = { blob: "x".repeat(5000) };
    render(<EvidenceValue label="Observed" value={big} limits={{ maxBytes: 64 }} />);
    expect(screen.getByText(/Preview truncated by .*size/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Inspect full observed value" }),
    ).toBeInTheDocument();
  });

  it("lazily inspects the complete value and restores focus on collapse", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const deep = { a: { b: { c: { d: 1 } } } };
    render(<EvidenceValue label="Expected" value={deep} limits={{ maxDepth: 1 }} />);
    const inspect = screen.getByRole("button", { name: "Inspect full expected value" });
    expect(inspect).toHaveAttribute("aria-expanded", "false");

    act(() => {
      fireEvent.click(inspect);
    });
    // Full text is scheduled, not yet produced.
    expect(roleWithText("status", "Preparing full evidence value.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Full expected value")).toBeNull();

    act(() => {
      for (const cb of frames.splice(0)) cb(0);
    });
    // The complete value includes the deepest member omitted from the preview.
    expect(screen.getByLabelText("Full expected value")).toHaveTextContent('"d": 1');

    const collapse = screen.getByRole("button", { name: "Collapse full expected value" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    act(() => {
      fireEvent.click(collapse);
    });
    expect(screen.queryByLabelText("Full expected value")).toBeNull();
    expect(document.activeElement).toBe(collapse);
    expect(collapse).toHaveAccessibleName("Inspect full expected value");
  });

  it("isolates an evidence failure to a fixed field alert", () => {
    silenceErrors();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    renderRow(
      finding({
        id: "iso",
        expected: cyclic as never,
        observed: "ok-observed",
      }),
    );
    // The expected field isolates to the fixed alert...
    expect(roleWithText("alert", "Evidence could not be displayed.")).toBeInTheDocument();
    // ...while the sibling observed value and finding metadata remain.
    expect(pageText()).toContain("ok-observed");
    expect(screen.getByText("msg")).toBeInTheDocument();
  });
});

describe("progressive finding disclosure", () => {
  const BIG_DRIFT = Array.from({ length: 60 }, (_, i) => ({
    id: `big-${String(i).padStart(3, "0")}`,
    severity: "warning",
    category: "drift",
    message: `bigmsg-${i}`,
    location: { host: "compute-a", service: "api" },
  }));

  it("renders the initial 25 rows with complete headings and counts", () => {
    driftState = availableGenState({ drift: BIG_DRIFT });
    render(<DriftPage />);
    expect(findingRows()).toHaveLength(25);
    expect(screen.getByText("60 findings in this host group")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show all 60 findings in api on compute-a" }),
    ).toBeInTheDocument();
    expect(idCount("drift-finding-big-000")).toBe(1);
    expect(idCount("drift-finding-big-059")).toBe(0);
  });

  it("reaches every finding through repeated show-more", () => {
    driftState = availableGenState({ drift: BIG_DRIFT });
    render(<DriftPage />);
    const more = screen.getByRole("button", {
      name: "Show 25 more findings in api on compute-a",
    });
    expect(more).toHaveTextContent("Show 25 more findings");
    clickButton("Show 25 more findings in api on compute-a");
    expect(findingRows()).toHaveLength(50);
    clickButton("Show 10 more findings in api on compute-a");
    expect(findingRows()).toHaveLength(60);
    expect(idCount("drift-finding-big-059")).toBe(1);
    expect(screen.queryByRole("button", { name: /^Show 10 more findings/ })).toBeNull();
  });

  it("reveals every finding through show-all", () => {
    driftState = availableGenState({ drift: BIG_DRIFT });
    render(<DriftPage />);
    clickButton("Show all 60 findings in api on compute-a");
    expect(findingRows()).toHaveLength(60);
    expect(idCount("drift-finding-big-059")).toBe(1);
    expect(
      screen.queryByRole("button", { name: "Show all 60 findings in api on compute-a" }),
    ).toBeNull();
  });
});

describe("FindingGroups controlled disclosure", () => {
  function bigGroup(n: number): FindingHostGroup {
    const findings = Array.from({ length: n }, (_, i) =>
      finding({
        id: `g-${String(i).padStart(3, "0")}`,
        severity: "info",
        category: "c",
        host: "compute-a",
        service: "api",
      }),
    );
    return { host: "compute-a", subgroups: [{ service: "api", findings }], findingCount: n };
  }

  it("invokes show-more and show-all with the exact subgroup key", () => {
    const onShowMore = vi.fn();
    const onShowAll = vi.fn();
    const key = JSON.stringify(["compute-a", "api"]);
    render(
      <FindingGroups
        groups={[bigGroup(60)]}
        model={defaultModel()}
        visibleByGroup={new Map([[key, 25]])}
        onShowMore={onShowMore}
        onShowAll={onShowAll}
      />,
    );
    expect(findingRows()).toHaveLength(25);
    clickButton("Show 25 more findings in api on compute-a");
    expect(onShowMore).toHaveBeenCalledWith(key);
    clickButton("Show all 60 findings in api on compute-a");
    expect(onShowAll).toHaveBeenCalledWith(key);
  });
});

// ---------------------------------------------------------------------------
// Semantic coverage rendering and progressive disclosure (06 §7).
// ---------------------------------------------------------------------------

/** One projected coverage row with inert defaults and targeted overrides. */
function coverageRow(over: Partial<CoverageRow> = {}): CoverageRow {
  return {
    host: "compute-a",
    state: "fresh",
    collectedAt: FIXED,
    ageMs: 0,
    pastStaleThreshold: false,
    failedCollectors: [],
    ...over,
  };
}

/** No-op progressive callbacks for direct CoverageTable mounts. */
const noopShow = (): void => {};

/** Build `n` host states of one class with distinct invented host keys. */
function coverageStates(
  n: number,
  state: string,
  prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const hasTimestamp = state !== "unreachable" && state !== "never-collected";
  for (let i = 0; i < n; i += 1) {
    out[`${prefix}-${String(i).padStart(3, "0")}`] = {
      state,
      collectedAt: hasTimestamp ? FIXED : null,
      ageMs: null,
      pastStaleThreshold: false,
    };
  }
  return out;
}

const FIVE_STATE_HOST_STATES: Record<string, unknown> = {
  "cov-fresh": {
    state: "fresh",
    collectedAt: FIXED,
    ageMs: 1_000,
    pastStaleThreshold: false,
  },
  "cov-stale": {
    state: "stale",
    collectedAt: FIXED,
    ageMs: 1_000,
    pastStaleThreshold: true,
  },
  "cov-partial": {
    state: "partial",
    collectedAt: FIXED,
    ageMs: 1_000,
    pastStaleThreshold: false,
  },
  "cov-unreachable": {
    state: "unreachable",
    collectedAt: null,
    ageMs: null,
    pastStaleThreshold: false,
  },
  "cov-never": {
    state: "never-collected",
    collectedAt: null,
    ageMs: null,
    pastStaleThreshold: false,
  },
};

const FIVE_STATE_HOSTS = [
  {
    name: "cov-partial",
    collectors: { succeeded: [], failed: [{ name: "disk", reason: "timeout" }] },
  },
];

/** Render the coverage table directly with the supplied rows and clock. */
function renderCoverage(
  rows: CoverageRow[],
  over: { model?: InventoryModel; now?: Date } = {},
): { rerender(now: Date): void } {
  const props = {
    rows,
    model: over.model ?? defaultModel(),
    visibleCount: rows.length,
    onShowMore: noopShow,
    onShowAll: noopShow,
  };
  const view = render(<CoverageTable {...props} now={over.now ?? CLOCK} />);
  return { rerender: (now) => view.rerender(<CoverageTable {...props} now={now} />) };
}

describe("coverage table semantics", () => {
  it("renders a semantic attention-ordered table with caption, headers, and all five states", () => {
    driftState = availableGenState({
      hostStates: FIVE_STATE_HOST_STATES,
      hosts: FIVE_STATE_HOSTS,
      drift: [],
    });
    render(<DriftPage />);

    const table = screen.getByRole("table", {
      name: /Host collection coverage; attention states precede fresh hosts/,
    });
    expect(table).toHaveAccessibleName(
      expect.stringContaining("Unreachable, Never collected, Partial, Stale, Fresh"),
    );

    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Host", "Collection state", "Collected at", "Age", "Collector failures"]);

    for (const label of ["Fresh", "Stale", "Partial", "Unreachable", "Never collected"]) {
      expect(within(table).getByText(label)).toBeInTheDocument();
    }

    // Attention-first order is preserved from the projection, not re-sorted here.
    const order = within(table)
      .getAllByRole("rowheader")
      .map((th) => th.textContent ?? "");
    expect(order).toHaveLength(5);
    expect(order[0]?.startsWith("cov-unreachable")).toBe(true);
    expect(order[1]?.startsWith("cov-never")).toBe(true);
    expect(order[2]?.startsWith("cov-partial")).toBe(true);
    expect(order[3]?.startsWith("cov-stale")).toBe(true);
    expect(order[4]?.startsWith("cov-fresh")).toBe(true);

    // The partial row discloses its failed collectors inertly.
    clickButton("1 failed collectors");
    expect(within(table).getByText("disk")).toBeInTheDocument();
    expect(within(table).getByText(/timeout/)).toBeInTheDocument();
  });

  it("renders timestamp fallbacks for valid, null, and defensive rows", () => {
    renderCoverage([
      coverageRow({ host: "compute-a", state: "fresh", collectedAt: FIXED }),
      coverageRow({ host: "compute-b", state: "unreachable", collectedAt: null }),
      coverageRow({ host: "compute-c", state: "never-collected", collectedAt: null }),
      coverageRow({ host: "compute-d", state: "stale", collectedAt: null }),
    ]);
    const times = document.querySelectorAll("time");
    expect(times).toHaveLength(1);
    expect(times[0]).toHaveTextContent(FIXED);
    expect(times[0]).toHaveAttribute("datetime", FIXED);
    expect(screen.getByText("No collection timestamp")).toBeInTheDocument();
    expect(screen.getByText("No collection has been recorded")).toBeInTheDocument();
    expect(screen.getByText("Collection timestamp unavailable")).toBeInTheDocument();
  });

  it("ages relative times independently without reclassifying state", () => {
    const collectedAt = "2030-01-01T00:00:00.000Z";
    const rows = [coverageRow({ host: "compute-a", state: "fresh", collectedAt })];
    const view = renderCoverage(rows, {
      now: new Date(Date.parse(collectedAt) + 60_000),
    });
    expect(screen.getByText("1m ago")).toBeInTheDocument();
    expect(screen.getByText("Fresh")).toBeInTheDocument();

    // A later display clock only advances the relative text; state is unchanged.
    view.rerender(new Date(Date.parse(collectedAt) + 2 * 3_600_000));
    expect(screen.getByText("2h ago")).toBeInTheDocument();
    expect(screen.getByText("Fresh")).toBeInTheDocument();

    // A future timestamp clamps to a non-negative zero age, never a blank cell.
    view.rerender(new Date(Date.parse(collectedAt) - 60_000));
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("discloses partial collector failures and marks other states not applicable", () => {
    renderCoverage([
      coverageRow({
        host: "p-detailed",
        state: "partial",
        failedCollectors: [{ name: "disk", reason: "io timeout" }],
      }),
      coverageRow({ host: "p-empty", state: "partial", failedCollectors: [] }),
      coverageRow({ host: "f-ok", state: "fresh" }),
    ]);
    clickButton("1 failed collectors");
    expect(screen.getByText("disk")).toBeInTheDocument();
    expect(screen.getByText(/io timeout/)).toBeInTheDocument();
    expect(
      screen.getByText("No failed collector details were supplied."),
    ).toBeInTheDocument();
    expect(screen.getByText("Not applicable")).toBeInTheDocument();
  });

  it("resolves a host link", () => {
    renderCoverage([coverageRow({ host: "compute-a" })]);
    expect(screen.getByRole("link", { name: "compute-a" })).toHaveAttribute(
      "href",
      "/hosts/compute-a",
    );
  });

  it("shows explicit unresolved text for an unknown host", () => {
    renderCoverage([coverageRow({ host: "ghost" })]);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Host detail link unresolved")).toBeInTheDocument();
  });

  it("treats a route-helper URIError host as unresolved", () => {
    const lone = "lone\uD800surrogate";
    renderCoverage([coverageRow({ host: lone })], { model: modelWithHost(lone) });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Host detail link unresolved")).toBeInTheDocument();
  });

  it("updates the display clock without network, derivation, or reclassification", () => {
    installInventoryTimers();
    vi.setSystemTime(CLOCK);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const recent = new Date(CLOCK.getTime() - 90_000).toISOString();
    driftState = availableGenState({
      hostStates: {
        "cov-fresh": {
          state: "fresh",
          collectedAt: recent,
          ageMs: 90_000,
          pastStaleThreshold: false,
        },
      },
      drift: [],
    });
    render(<DriftPage />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("1m ago")).toBeInTheDocument();
    expect(within(table).getByText("Fresh")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(within(table).getByText("2m ago")).toBeInTheDocument();
    // State is not reclassified and no fetch/derivation was triggered.
    expect(within(table).getByText("Fresh")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("coverage progressive disclosure", () => {
  it("renders the initial 25 coverage rows with complete totals", () => {
    driftState = availableGenState({
      hostStates: coverageStates(60, "fresh", "cov"),
      drift: [],
    });
    render(<DriftPage />);
    expect(coverageRowEls()).toHaveLength(25);
    for (const row of coverageRowEls()) expect(row).toHaveAttribute("tabindex", "-1");
    // Counts describe the complete filtered array, never the 25-row visible slice.
    expect(statusLine()).toHaveTextContent("showing 60 of 60 coverage hosts.");
    expect(
      screen.getByRole("button", { name: "Show all 60 coverage hosts" }),
    ).toBeInTheDocument();
  });

  it("reaches every coverage row through repeated show-more", () => {
    driftState = availableGenState({
      hostStates: coverageStates(60, "fresh", "cov"),
      drift: [],
    });
    render(<DriftPage />);
    clickButton("Show 25 more coverage hosts");
    expect(coverageRowEls()).toHaveLength(50);
    clickButton("Show 10 more coverage hosts");
    expect(coverageRowEls()).toHaveLength(60);
    expect(screen.queryByRole("button", { name: "Show 10 more coverage hosts" })).toBeNull();
    // The complete filtered total is unchanged by disclosure.
    expect(statusLine()).toHaveTextContent("showing 60 of 60 coverage hosts.");
  });

  it("reveals every coverage row through show-all", () => {
    driftState = availableGenState({
      hostStates: coverageStates(60, "fresh", "cov"),
      drift: [],
    });
    render(<DriftPage />);
    clickButton("Show all 60 coverage hosts");
    expect(coverageRowEls()).toHaveLength(60);
    expect(screen.queryByRole("button", { name: "Show all 60 coverage hosts" })).toBeNull();
  });

  it("resets coverage disclosure to the initial bound on a new accepted generation", () => {
    driftState = availableGenState({
      hostStates: coverageStates(60, "fresh", "cov"),
      drift: [],
      refreshGeneration: 1,
    });
    const page = mountPage();
    clickButton("Show all 60 coverage hosts");
    expect(coverageRowEls()).toHaveLength(60);

    driftState = availableGenState({
      hostStates: coverageStates(60, "fresh", "cov"),
      drift: [],
      refreshGeneration: 2,
    });
    page.rerender();
    expect(coverageRowEls()).toHaveLength(25);
    // Complete and filtered totals are unchanged by the reset.
    expect(statusLine()).toHaveTextContent("showing 60 of 60 coverage hosts.");
  });

  it("clamps coverage disclosure when a filter shrinks the filtered total", () => {
    const mixed = {
      ...coverageStates(40, "fresh", "f"),
      ...coverageStates(20, "stale", "s"),
    };
    driftState = availableGenState({ hostStates: mixed, drift: [] });
    render(<DriftPage />);
    clickButton("Show all 60 coverage hosts");
    expect(coverageRowEls()).toHaveLength(60);

    toggleFacet("Coverage state", "Fresh");
    expect(coverageRowEls()).toHaveLength(40);
    // The complete total is retained while the filtered population shrinks.
    expect(statusLine()).toHaveTextContent("showing 40 of 60 coverage hosts.");
  });
});

// ---------------------------------------------------------------------------
// Mounted keyboard grammar and focus (06 §8).
// One window keydown listener drives the visible finding-then-coverage results.
// ---------------------------------------------------------------------------

/**
 * Dispatch a keydown from `target` (default: the document body, i.e. no control
 * focused) that bubbles to the window listener. Returns whether it was consumed.
 */
function press(
  key: string,
  options: { ctrlKey?: boolean; metaKey?: boolean; target?: Element } = {},
): boolean {
  let notCancelled = true;
  act(() => {
    notCancelled = fireEvent.keyDown(options.target ?? document.body, {
      key,
      ctrlKey: options.ctrlKey ?? false,
      metaKey: options.metaKey ?? false,
    });
  });
  return !notCancelled;
}

/** Drop focus back to the document. */
function blurAll(): void {
  act(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

describe("mounted keyboard grammar", () => {
  it("focuses the search input on `/` and prevents default", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    expect(press("/")).toBe(true);
    expect(document.activeElement).toBe(searchBox());
  });

  it("focuses the search input on Ctrl-K and Cmd-K", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    press("k", { ctrlKey: true });
    expect(document.activeElement).toBe(searchBox());
    blurAll();
    expect(document.activeElement).toBe(document.body);
    press("k", { metaKey: true });
    expect(document.activeElement).toBe(searchBox());
  });

  it("moves through visible results with j/k, arrows, Home, and End", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    const findings = findingRows();
    const coverage = coverageRowEls();

    press("j");
    expect(document.activeElement).toBe(findings[0]);
    press("ArrowDown", { target: findings[0] });
    expect(document.activeElement).toBe(findings[1]);
    press("k", { target: findings[1] });
    expect(document.activeElement).toBe(findings[0]);
    press("ArrowUp", { target: findings[0] });
    // Clamped at the first result; no wrap.
    expect(document.activeElement).toBe(findings[0]);

    press("End", { target: findings[0] });
    expect(document.activeElement).toBe(coverage[coverage.length - 1]);
    press("ArrowDown", { target: coverage[coverage.length - 1] });
    // Clamped at the last result; no wrap.
    expect(document.activeElement).toBe(coverage[coverage.length - 1]);

    press("Home", { target: coverage[coverage.length - 1] });
    expect(document.activeElement).toBe(findings[0]);
  });

  it("jumps to the first result on `gg` and the last on `G`", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    const findings = findingRows();
    const coverage = coverageRowEls();

    press("g");
    expect(document.activeElement).toBe(document.body);
    press("g");
    expect(document.activeElement).toBe(findings[0]);

    press("G", { target: findings[0] });
    expect(document.activeElement).toBe(coverage[coverage.length - 1]);
  });

  it("cancels a pending `g` chord on an unrelated second key", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    const findings = findingRows();

    press("g");
    press("x");
    // The chord was cancelled; no result gained focus.
    expect(document.activeElement).toBe(document.body);
    // A fresh `g` chord still works afterwards.
    press("g");
    press("g");
    expect(document.activeElement).toBe(findings[0]);
  });

  it("follows the focused entity link on Enter", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    press("j");
    press("Enter", { target: findingRows()[0] });
    // The first finding is the host-level compute-a error; Enter routes to it.
    expect(routeCalls).toContainEqual(["/hosts/compute-a", undefined]);
  });

  it("follows a focused coverage row's host link on Enter", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    const coverage = coverageRowEls();
    press("End");
    expect(document.activeElement).toBe(coverage[coverage.length - 1]);
    press("Enter", { target: coverage[coverage.length - 1] });
    const host = within(coverage[coverage.length - 1]!).getByRole("rowheader").textContent;
    expect(routeCalls).toContainEqual([`/hosts/${host}`, undefined]);
  });

  it("is a no-op on Enter when no result is focused", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    press("Enter");
    expect(routeCalls).toHaveLength(0);
  });

  it("clears only the search on Escape while search is non-empty", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    const search = searchBox();
    act(() => {
      search.focus();
    });
    fireEvent.change(search, { target: { value: "alpha" } });
    expect(statusLine()).not.toHaveTextContent("Showing 3 of 3 findings");
    press("Escape", { target: search });
    expect(statusLine()).toHaveTextContent("Showing 3 of 3 findings");
    expect(search).toHaveValue("");
    expect(document.activeElement).toBe(search);
    expect(routeCalls).not.toContainEqual(["/drift", true]);
  });

  it("clears the search on Escape from a result and refocuses the search", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    fireEvent.change(searchBox(), { target: { value: "Alpha" } });
    blurAll();
    press("j");
    press("Escape", { target: findingRows()[0] });
    expect(statusLine()).toHaveTextContent("Showing 3 of 3 findings");
    expect(document.activeElement).toBe(searchBox());
    expect(routeCalls).not.toContainEqual(["/drift", true]);
  });

  it("clears URL scope on Escape while search is empty", () => {
    locationUrl = "/drift?host=compute-a";
    driftState = availableGenState();
    render(<DriftPage />);
    expect(press("Escape")).toBe(true);
    expect(routeCalls).toContainEqual(["/drift", true]);
  });

  it("leaves Escape unhandled with no search text and no scope", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    expect(press("Escape")).toBe(false);
    expect(routeCalls).toHaveLength(0);
  });

  it("ignores a navigation key originating in a control", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    const search = searchBox();
    act(() => {
      search.focus();
    });
    expect(press("j", { target: search })).toBe(false);
    // The key from the search input never moved result focus.
    expect(document.activeElement).toBe(search);
    const button = screen.getByRole("button", { name: /^Severity/ });
    expect(press("j", { target: button })).toBe(false);
    expect(findingRows()).not.toContain(document.activeElement);
  });

  it("never traps Tab", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    expect(press("Tab")).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("removes every keydown listener it added when the page unmounts", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    driftState = availableGenState();
    const page = mountPage();
    const keydownAdds = added.mock.calls.filter(([type]) => type === "keydown");
    expect(keydownAdds.length).toBeGreaterThanOrEqual(1);
    page.unmount();
    const removedListeners = removed.mock.calls
      .filter(([type]) => type === "keydown")
      .map(([, listener]) => listener);
    for (const [, listener] of keydownAdds) {
      expect(removedListeners).toContain(listener);
    }
    // A key after unmount moves nothing and does not throw.
    expect(() => press("j")).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});

// ---------------------------------------------------------------------------
// Focus reconciliation across refreshes and progressive reveal (06 §§6.4, 8.2).
// ---------------------------------------------------------------------------

describe("keyboard focus reconciliation", () => {
  it("moves focus to the nearest surviving result when a refresh removes the focused row", () => {
    driftState = availableGenState({ refreshGeneration: 1 });
    const page = mountPage();
    // Focus the second finding (f-warn).
    press("j");
    press("j", { target: findingRows()[0] });
    expect(document.activeElement).toHaveAttribute("id", "drift-finding-f-warn");

    // A new generation drops f-warn; the nearest following survivor is f-info.
    driftState = availableGenState({
      refreshGeneration: 2,
      drift: DEFAULT_DRIFT.filter((f) => f.id !== "f-warn"),
    });
    page.rerender();
    expect(document.activeElement).toHaveAttribute("id", "drift-finding-f-info");
  });

  it("keeps focus on a surviving result across a refresh", () => {
    driftState = availableGenState({ refreshGeneration: 1 });
    const page = mountPage();
    press("j");
    const first = document.activeElement;
    expect(first).toHaveAttribute("id", "drift-finding-f-error");
    driftState = availableGenState({ refreshGeneration: 2 });
    page.rerender();
    expect(document.activeElement).toBe(first);
  });

  it("does not steal focus from the control the reader moved to", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    press("j");
    press("j", { target: findingRows()[0] });
    expect(document.activeElement).toHaveAttribute("id", "drift-finding-f-warn");
    const search = searchBox();
    act(() => {
      search.focus();
    });
    // Searching removes f-warn while focus rests in the search field.
    fireEvent.change(search, { target: { value: "Gamma" } });
    expect(idCount("drift-finding-f-warn")).toBe(0);
    expect(document.activeElement).toBe(search);
  });

  it("focuses the last revealed finding after show-all removes the button", () => {
    const bigDrift = Array.from({ length: 60 }, (_, i) => ({
      id: `big-${String(i).padStart(3, "0")}`,
      severity: "warning",
      category: "drift",
      message: `bigmsg-${i}`,
      location: { host: "compute-a", service: "api" },
    }));
    driftState = availableGenState({ drift: bigDrift });
    render(<DriftPage />);
    clickButton("Show all 60 findings in api on compute-a");
    expect(document.activeElement).toHaveAttribute("id", "drift-finding-big-059");
  });

  it("focuses the last revealed coverage row after show-all", () => {
    driftState = availableGenState({
      hostStates: coverageStates(60, "fresh", "cov"),
      drift: [],
    });
    render(<DriftPage />);
    clickButton("Show all 60 coverage hosts");
    const rows = coverageRowEls();
    expect(document.activeElement).toBe(rows[rows.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// Bounded live regions (06 §9.1).
// ---------------------------------------------------------------------------

describe("live region announcements", () => {
  it("announces filtered population changes through one bounded polite status", () => {
    driftState = availableGenState();
    render(<DriftPage />);
    // The population status is one stable region updated in place, not per row.
    const status = statusLine();
    expect(status).toHaveTextContent("Showing 3 of 3 findings");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");

    toggleFacet("Severity", "Error");
    expect(status).toHaveTextContent("Showing 1 of 3 findings");
    expect(statusLine()).toBe(status);
  });
});

// ---------------------------------------------------------------------------
// Render diagnostics: one transition per surface/generation/outcome (06 §10.3).
// ---------------------------------------------------------------------------

describe("render diagnostics", () => {
  function capturePageEvents(): { events: DriftDiagnosticEvent[]; restore: () => void } {
    const events: DriftDiagnosticEvent[] = [];
    const restore = setDriftDiagnosticSink((event) => {
      if (event.event === "drift.render" && event.surface === "page") events.push(event);
    });
    return { events, restore };
  }

  it("emits one page render transition per accepted generation, not per rerender", () => {
    __resetDriftRenderDedupForTest();
    const { events, restore } = capturePageEvents();

    driftState = availableGenState({ refreshGeneration: 1 });
    const page = mountPage();
    expect(events.filter((e) => e.outcome === "ok")).toHaveLength(1);

    // An ordinary rerender of the same generation emits no duplicate transition.
    page.rerender();
    expect(events.filter((e) => e.outcome === "ok")).toHaveLength(1);

    // A new accepted generation emits exactly one further transition.
    driftState = availableGenState({ refreshGeneration: 2 });
    page.rerender();
    expect(events.filter((e) => e.outcome === "ok")).toHaveLength(2);

    restore();
  });

  it("emits a sanitized page error transition from the boundary", () => {
    silenceErrors();
    __resetDriftRenderDedupForTest();
    const { events, restore } = capturePageEvents();

    function Boom(): JSX.Element {
      throw new Error("boom");
    }
    render(
      <DriftPageBoundary>
        <Boom />
      </DriftPageBoundary>,
    );

    const errors = events.filter((e) => e.outcome === "error");
    expect(errors).toHaveLength(1);
    // The transition carries only allowlisted numeric fields; no exception text.
    expect(errors[0]).toMatchObject({ event: "drift.render", surface: "page" });
    expect(JSON.stringify(errors[0])).not.toContain("boom");

    restore();
  });
});

// ---------------------------------------------------------------------------
// Above-scale mounted reachability and isolation (spec 08 §5.5).
//
// The strictly-above-scale invented fixture passes its matching config and
// available envelope through the real `buildInventoryModel`, and its projection is
// derived from that same envelope. This layer proves semantic reachability and
// isolation — complete totals are retained, the final finding and coverage
// identities are reachable through batches and show-all, a large evidence value is
// initially bounded, and unrelated controls remain operable — NOT wall-clock
// thresholds, which belong to the Chromium gates in `test/e2e/drift.spec.ts`.
// ---------------------------------------------------------------------------

describe("above-scale mounted reachability and isolation", () => {
  /** The one subgroup the above-scale fixture concentrates beyond 25 rows. */
  const CONCENTRATED_HOST = "fixture-host-000.invalid";
  const CONCENTRATED_SERVICE = "fixture-service-000-a";

  /** Build one accepted above-scale generation state through the real model builder. */
  function aboveScaleGenState(): {
    state: DriftGenerationState;
    fixture: ReturnType<typeof buildAboveScaleFixture>;
  } {
    const fixture = buildAboveScaleFixture();
    const clientState = availableState(fixture.envelope.data!);
    if (clientState.status !== "available") throw new Error("expected available");
    const gen = makeGeneration({
      config: fixture.config,
      snapshot: clientState,
      refreshGeneration: 1,
    }) as unknown as InventoryGeneration;
    const projection = deriveDriftProjection(
      clientState.envelope,
      new Date(DRIFT_FIXTURE_NOW),
    );
    return {
      fixture,
      state: {
        inventory: gen,
        current: {
          refreshGeneration: gen.refreshGeneration,
          inventory: gen,
          projection,
        },
        derivationError: null,
      },
    };
  }

  /** Resolve the concentrated (host, service) subgroup from an accepted projection. */
  function concentratedSubgroup(state: DriftGenerationState) {
    const group = state.current!.projection.findingGroups.find(
      (candidate) => candidate.host === CONCENTRATED_HOST,
    );
    const subgroup = group?.subgroups.find(
      (candidate) => candidate.service === CONCENTRATED_SERVICE,
    );
    if (subgroup === undefined) throw new Error("missing concentrated subgroup");
    return subgroup;
  }

  // One mount serves every above-scale case: mounting the full population in
  // jsdom costs several seconds, so the cases run in sequence on the same page,
  // each step re-asserting from the live DOM.
  it("retains totals, reaches the final finding and coverage host, bounds evidence, and keeps filters responsive", () => {
    try {
      const { state, fixture } = aboveScaleGenState();
      driftState = state;
      const projection = state.current!.projection;
      expect(projection.summary.totalFindings).toBe(fixture.findingCount);
      expect(projection.summary.totalHosts).toBe(fixture.hostCount);
      const subgroup = concentratedSubgroup(state);
      const count = subgroup.findings.length;
      expect(count).toBeGreaterThan(25);
      const finalId = subgroup.findings[count - 1]!.id;

      render(<DriftPage />);

      // Complete above-scale totals in the status line.
      expect(statusLine()).toHaveTextContent(`of ${fixture.findingCount} findings`);
      expect(statusLine()).toHaveTextContent(`of ${fixture.hostCount} coverage hosts`);

      // The concentrated subgroup shows the initial 25; one show-more batch
      // reaches its final row.
      expect(idCount(`drift-finding-${finalId}`)).toBe(0);
      const remaining = count - 25;
      clickFast(
        `Show ${Math.min(25, remaining)} more findings in ${CONCENTRATED_SERVICE} on ${CONCENTRATED_HOST}`,
      );
      expect(idCount(`drift-finding-${finalId}`)).toBe(1);

      // The large-evidence finding mounts as a bounded inert preview.
      const row = document.querySelector('[id="drift-finding-fixture-finding-0000"]');
      expect(row).not.toBeNull();
      expect(row!.querySelector('[data-drift-evidence="Expected"]')).not.toBeNull();
      expect(row!.querySelector("pre")).toBeNull();

      // Show-all reaches the final coverage host without changing the totals.
      expect(coverageRowEls()).toHaveLength(25);
      clickFast(`Show all ${fixture.hostCount} coverage hosts`);
      expect(coverageRowEls()).toHaveLength(fixture.hostCount);
      expect(statusLine()).toHaveTextContent(
        `showing ${fixture.hostCount} of ${fixture.hostCount} coverage hosts`,
      );

      // An unrelated facet still recomputes the population without a hang.
      toggleFacet("Severity", "Error");
      expect(statusLine()).toHaveTextContent("Local filters active");
    } finally {
      // nothing to restore
    }
  }, 600_000);

  it("reaches the final concentrated finding through show-all", () => {
    // Show-all on its own subgroup is a controlled FindingGroups contract; drive
    // it with the real above-scale subgroup (no full-page mount needed).
    const { state } = aboveScaleGenState();
    const group = state.current!.projection.findingGroups.find(
      (candidate) => candidate.host === CONCENTRATED_HOST,
    )!;
    const subgroup = concentratedSubgroup(state);
    const count = subgroup.findings.length;
    const finalId = subgroup.findings[count - 1]!.id;
    const onShowAll = vi.fn();
    const key = JSON.stringify([CONCENTRATED_HOST, CONCENTRATED_SERVICE]);
    const view = render(
      <FindingGroups
        groups={[{ ...group, subgroups: [subgroup] }]}
        model={state.current!.inventory.model as InventoryModel}
        visibleByGroup={new Map([[key, 25]])}
        onShowMore={vi.fn()}
        onShowAll={onShowAll}
      />,
    );
    clickFast(`Show all ${count} findings in ${CONCENTRATED_SERVICE} on ${CONCENTRATED_HOST}`);
    expect(onShowAll).toHaveBeenCalledWith(key);
    view.rerender(
      <FindingGroups
        groups={[{ ...group, subgroups: [subgroup] }]}
        model={state.current!.inventory.model as InventoryModel}
        visibleByGroup={new Map([[key, count]])}
        onShowMore={vi.fn()}
        onShowAll={onShowAll}
      />,
    );
    expect(idCount(`drift-finding-${finalId}`)).toBe(1);
  }, 120_000);
});

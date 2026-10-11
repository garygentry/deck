// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The top-bar pills these cases register, as the UI manifest lists them (id → order). */
const LISTED_PILLS: Record<string, number> = {
  "pill:t/early": 100,
  "pill:t/late": 1,
  "pill:t/broken": 1,
  "pill:t/fine": 2,
  "pill:t/only": 100,
  "pill:t/flaky": 100,
  "pill:t/nudge": 100,
};

/**
 * Fresh registry, slot declaration and slot hosts for each case, with a loaded UI manifest
 * listing the pills (the status slot renders what the manifest lists, once registered).
 */
async function load() {
  vi.resetModules();
  const { getQueryClient } = await import("../src/data/query-client.js");
  getQueryClient().setQueryData(["ui"], {
    uiApi: 1, brand: { title: "Deck" }, modules: [], slots: [], pages: [], disabledPages: [], navGroups: [], nav: [], providers: [], findings: [],
    extensions: Object.entries(LISTED_PILLS).map(([id, order]) => ({ id, kind: "pill", module: "t", slot: "app/topbar.status", order })),
  });
  const registry = await import("../src/registry/registry.js");
  const { useSlot } = await import("../src/registry/use-registry.js");
  const { HealthHeaderSlot } = await import("../src/shell/health-header/slot.js");
  const { HealthHeaderRegion } = await import("../src/shell/health-header/HealthHeaderRegion.js");
  return { registry, useSlot, HealthHeaderSlot, HealthHeaderRegion };
}

/** Render failures are expected in the isolation cases; keep React's report quiet. */
function quietErrors(): () => void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => spy.mockRestore();
}

describe("reactive extension registry", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    cleanup();
  });

  it("useSlot re-renders with an extension registered after mount, in order", async () => {
    const { registry, useSlot } = await load();
    function Host() {
      const items = useSlot("t/cards");
      return <ul>{items.map(({ id }) => <li key={id}>{id}</li>)}</ul>;
    }
    registry.registerExtension({ id: "widget:t/b", kind: "widget", component: () => null, attachTo: { slot: "t/cards", order: 2 } });
    render(<Host />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["widget:t/b"]);

    act(() => {
      registry.registerExtension({ id: "widget:t/a", kind: "widget", component: () => null, attachTo: { slot: "t/cards", order: 1 } });
      registry.registerExtension({ id: "widget:t/elsewhere", kind: "widget", component: () => null, attachTo: { slot: "t/other" } });
    });
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["widget:t/a", "widget:t/b"]);
  });

  it("useSlot returns the same array between registrations", async () => {
    const { registry, useSlot } = await load();
    const seen: unknown[] = [];
    function Host({ tick }: { tick: number }) {
      seen.push(useSlot("t/cards"));
      return <span>{tick}</span>;
    }
    registry.registerExtension({ id: "widget:t/a", kind: "widget", component: () => null, attachTo: { slot: "t/cards" } });
    const { rerender } = render(<Host tick={1} />);
    rerender(<Host tick={2} />);
    expect(seen[1]).toBe(seen[0]);
  });

  it("the status slot shows a pill registered after the header mounted", async () => {
    const { registry, HealthHeaderSlot, HealthHeaderRegion } = await load();
    registry.registerSummaryFragment(HealthHeaderSlot, { id: "pill:t/early", component: () => <span>early pill</span> });
    render(<HealthHeaderRegion />);
    expect(screen.queryByText("late pill")).toBeNull();

    act(() => {
      registry.registerSummaryFragment(HealthHeaderSlot, { id: "pill:t/late", order: 1, component: () => <span>late pill</span> });
    });
    const region = document.querySelector('[data-slot="health-header"]')!;
    expect(region.textContent).toBe("late pillearly pill");
  });

  it("a pill that throws is isolated; its siblings and the region still render", async () => {
    const { registry, HealthHeaderSlot, HealthHeaderRegion } = await load();
    registry.registerSummaryFragment(HealthHeaderSlot, {
      id: "pill:t/broken",
      order: 1,
      component: () => {
        throw new Error("internal pill failure must never reach the UI");
      },
    });
    registry.registerSummaryFragment(HealthHeaderSlot, { id: "pill:t/fine", order: 2, component: () => <span>fine pill</span> });
    const restore = quietErrors();
    try {
      render(<HealthHeaderRegion />);
    } finally {
      restore();
    }
    expect(screen.getByText("fine pill")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Status summary unavailable");
    expect(document.body.textContent).not.toContain("internal pill failure");
  });

  it("with no failure the slot adds no wrapper around a pill", async () => {
    const { registry, HealthHeaderSlot, HealthHeaderRegion } = await load();
    registry.registerSummaryFragment(HealthHeaderSlot, { id: "pill:t/only", component: () => <b>only</b> });
    render(<HealthHeaderRegion />);
    const region = document.querySelector('[data-slot="health-header"]')!;
    expect(region.innerHTML).toBe("<b>only</b>");
  });
});

describe("slot host recovery (review L3)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a header pill that threw renders again at the next poll once it stops throwing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { registry, HealthHeaderSlot, HealthHeaderRegion } = await load();
    const { POLL_DEFAULTS } = await import("@deck/server");
    let failing = true;
    registry.registerSummaryFragment(HealthHeaderSlot, {
      id: "pill:t/flaky",
      component: () => {
        if (failing) throw new Error("transient");
        return <span>recovered pill</span>;
      },
    });
    const restore = quietErrors();
    try {
      render(<HealthHeaderRegion />);
      expect(screen.getByRole("alert").textContent).toBe("Status summary unavailable");
      failing = false;
      act(() => {
        vi.advanceTimersByTime(POLL_DEFAULTS.pollIntervalMs);
      });
    } finally {
      restore();
    }
    expect(screen.getByText("recovered pill")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a persistently failing slot extension (review N1)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps one alert node and logs once while it keeps failing, then recovers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { registry, HealthHeaderSlot, HealthHeaderRegion } = await load();
    const { POLL_DEFAULTS } = await import("@deck/server");
    let failing = true;
    registry.registerSummaryFragment(HealthHeaderSlot, {
      id: "pill:t/broken",
      component: () => {
        if (failing) throw new Error("still broken");
        return <span>healed pill</span>;
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deckErrors = () => errors.mock.calls.filter(([first]) => String(first).startsWith("[deck] fragment")).length;

    render(<HealthHeaderRegion />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Status summary unavailable");
    expect(deckErrors()).toBe(1);

    // Three poll ticks of retries that fail again: the same node, no new alert, no new log.
    for (let tick = 0; tick < 3; tick += 1) {
      act(() => {
        vi.advanceTimersByTime(POLL_DEFAULTS.pollIntervalMs);
      });
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert")).toBe(alert);
    }
    expect(deckErrors()).toBe(1);

    // The pill heals: the next tick renders it and drops the fallback.
    failing = false;
    act(() => {
      vi.advanceTimersByTime(POLL_DEFAULTS.pollIntervalMs);
    });
    expect(screen.getByText("healed pill")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(alert.isConnected).toBe(false);

    // A later failure is a new episode: announced and logged once more.
    failing = true;
    act(() => {
      registry.registerSummaryFragment(HealthHeaderSlot, { id: "pill:t/nudge", component: () => null });
    });
    expect(screen.getByRole("alert")).not.toBe(alert);
    expect(deckErrors()).toBe(2);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveComponent } from "./support/lazy.js";

// Import a fresh feature entrypoint against a fresh registry singleton, then inspect the public
// registry accessors. The pills attach to the health-header slot, which the shell declares.
async function loadFreshFeature() {
  vi.resetModules();
  await import("../src/shell/health-header/slot.js");
  await import("../src/features/alerts-and-health/index.js");
  const registry = await import("../src/registry/registry.js");
  const { HealthHeaderSlot } = await import("../src/shell/health-header/slot.js");
  const { MONITORING_UI } = await import("@deck/contract/modules/monitoring");
  const { MonitoringPage } = await import("../src/features/alerts-and-health/MonitoringPage.js");
  const { AlertsSummary } = await import("../src/features/alerts-and-health/AlertsSummary.js");
  const { MetricsSummary } = await import("../src/features/alerts-and-health/MetricsSummary.js");
  return { registry, HealthHeaderSlot, MONITORING_UI, MonitoringPage, AlertsSummary, MetricsSummary };
}

describe("the alerts-and-health web half", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers exactly the monitoring module's contributions, with no placement of its own", async () => {
    const { registry, MONITORING_UI, AlertsSummary, MetricsSummary } = await loadFreshFeature();
    const ours = registry.getAllExtensions().filter(({ module }) => module === "monitoring");
    const declared = MONITORING_UI.contributes!;
    expect(ours.map(({ id }) => id).sort()).toEqual(
      [...declared.pages!, ...declared.nav!, ...declared.extensions!].map(({ id }) => id).sort(),
    );
    for (const extension of declared.extensions!) {
      const registered = ours.find(({ id }) => id === extension.id)!;
      expect(registered.attachTo).toEqual({ slot: extension.attachTo.slot, order: extension.attachTo.order ?? 100 });
    }
    expect(await resolveComponent(ours.find(({ id }) => id === "pill:monitoring/alerts")!.component!)).toBe(AlertsSummary);
    expect(await resolveComponent(ours.find(({ id }) => id === "pill:monitoring/metrics")!.component!)).toBe(MetricsSummary);
    // The metrics module contributes no UI, so nothing registers under it.
    expect(registry.getAllExtensions().filter(({ module }) => module === "metrics")).toEqual([]);
  });

  it("registers exactly one /monitoring page, listed in the health group", async () => {
    const { registry, MonitoringPage } = await loadFreshFeature();
    const pages = registry.getPages().filter((page) => page.id === "page:monitoring/overview");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page).toMatchObject({ path: "/monitoring", label: "Monitoring", icon: "activity", group: "health" });
    expect(await resolveComponent(page!.component)).toBe(MonitoringPage);
    expect(page!.nav).not.toBe(false);
    expect(registry.getPages().filter((p) => p.path === "/monitoring")).toHaveLength(1);
  });

  it("orders the alerts pill, then the metrics pill, before a no-order sibling", async () => {
    const { registry, HealthHeaderSlot } = await loadFreshFeature();
    // A sibling with no order defaults behind explicit low orders (10, 20 < default 100).
    registry.registerSummaryFragment(HealthHeaderSlot, {
      id: "pill:zzz/late-sibling",
      component: () => null,
    });
    const ids = registry.getExtensions(HealthHeaderSlot.slotId).map((f) => f.id);
    expect(ids.indexOf("pill:monitoring/alerts")).toBeLessThan(ids.indexOf("pill:monitoring/metrics"));
    expect(ids.indexOf("pill:monitoring/metrics")).toBeLessThan(ids.indexOf("pill:zzz/late-sibling"));
  });

  it("fails loudly with DUPLICATE_ID when a header pill id is re-registered", async () => {
    const { registry, HealthHeaderSlot } = await loadFreshFeature();
    expect(() =>
      registry.registerSummaryFragment(HealthHeaderSlot, {
        id: "pill:monitoring/alerts",
        component: () => null,
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });
});

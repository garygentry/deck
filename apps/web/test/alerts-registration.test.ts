import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PageRegistration,
  SummaryFragmentRegistration,
} from "../src/registry/registry.js";
import type { HealthSummary } from "../src/shell/health-header/health-summary.js";
import { resolveComponent } from "./support/lazy.js";

// Import a fresh feature entrypoint against a fresh registry singleton, then inspect the public
// registry accessors to prove the three eager side effects. Importing the entrypoint transitively
// loads `shell/health-header/slot.ts` (which declares the health-header slot).
async function loadFreshFeature() {
  vi.resetModules();
  await import("../src/features/alerts-and-health/index.js");
  const registry = await import("../src/registry/registry.js");
  const { HealthHeaderSlot } = await import("../src/shell/health-header/slot.js");
  const { MonitoringPage } = await import("../src/features/alerts-and-health/MonitoringPage.js");
  const { AlertsSummary } = await import("../src/features/alerts-and-health/AlertsSummary.js");
  const { MetricsSummary } = await import("../src/features/alerts-and-health/MetricsSummary.js");
  return { registry, HealthHeaderSlot, MonitoringPage, AlertsSummary, MetricsSummary };
}

describe("alerts-and-health feature registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers exactly one /monitoring page in primary navigation", async () => {
    const { registry, MonitoringPage } = await loadFreshFeature();
    const pages = registry.getPages().filter((page) => page.id === "monitoring");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.path).toBe("/monitoring");
    expect(page.label).toBe("Monitoring");
    expect(await resolveComponent(page.component)).toBe(MonitoringPage);
    // `nav` defaults truthy — the page appears in primary nav without a shell edit.
    expect(page.nav).not.toBe(false);
    expect(registry.getPages().filter((p) => p.path === "/monitoring")).toHaveLength(1);
  });

  it("registers the two header fragments in deterministic order 10 then 20", async () => {
    const { registry, HealthHeaderSlot, AlertsSummary, MetricsSummary } = await loadFreshFeature();
    const fragments = registry.getSummaryFragments(HealthHeaderSlot);
    const ours = fragments.filter((f) => f.id === "alerts-summary" || f.id === "metrics-summary");
    expect(ours.map((f) => f.id)).toEqual(["alerts-summary", "metrics-summary"]);
    expect(ours[0].component).toBe(AlertsSummary);
    expect(ours[0].order).toBe(10);
    expect(ours[1].component).toBe(MetricsSummary);
    expect(ours[1].order).toBe(20);
  });

  it("orders both header fragments before a no-order sibling", async () => {
    const { registry, HealthHeaderSlot } = await loadFreshFeature();
    // A sibling with no order defaults behind explicit low orders (10, 20 < default 100).
    registry.registerSummaryFragment(HealthHeaderSlot, {
      id: "zzz-late-sibling",
      component: () => null,
    });
    const ids = registry.getSummaryFragments(HealthHeaderSlot).map((f) => f.id);
    expect(ids.indexOf("alerts-summary")).toBeLessThan(ids.indexOf("zzz-late-sibling"));
    expect(ids.indexOf("metrics-summary")).toBeLessThan(ids.indexOf("zzz-late-sibling"));
    expect(ids.indexOf("alerts-summary")).toBeLessThan(ids.indexOf("metrics-summary"));
  });

  it("fails loudly with DUPLICATE_ID when a header fragment id is re-registered", async () => {
    const { registry, HealthHeaderSlot } = await loadFreshFeature();
    expect(() =>
      registry.registerSummaryFragment(HealthHeaderSlot, {
        id: "alerts-summary",
        component: () => null,
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });

  it("component assignments satisfy the registry contracts", async () => {
    const { MonitoringPage, AlertsSummary, MetricsSummary } = await loadFreshFeature();
    // Compile-time proof (checked by tsc over the test tree) that the registered components typecheck
    // against PageRegistration and the HealthSummary summary contract.
    const page: PageRegistration = {
      id: "monitoring",
      path: "/monitoring",
      label: "Monitoring",
      component: MonitoringPage,
    };
    const alerts: SummaryFragmentRegistration<HealthSummary> = {
      id: "alerts-summary",
      component: AlertsSummary,
      order: 10,
    };
    const metrics: SummaryFragmentRegistration<HealthSummary> = {
      id: "metrics-summary",
      component: MetricsSummary,
      order: 20,
    };
    expect([page.id, alerts.id, metrics.id]).toEqual([
      "monitoring",
      "alerts-summary",
      "metrics-summary",
    ]);
  });
});

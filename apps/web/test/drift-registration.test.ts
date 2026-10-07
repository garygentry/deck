import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EntityFragmentRegistration,
  PageRegistration,
  SummaryFragmentRegistration,
} from "../src/registry/registry.js";
import type { HealthSummary } from "../src/shell/health-header/health-summary.js";
import { resolveComponent } from "./support/lazy.js";

// Import a fresh feature entrypoint against a fresh registry singleton, then
// inspect the public registry accessors to prove the four eager side effects.
async function loadFreshFeature() {
  vi.resetModules();
  // Importing the feature entrypoint runs its four registration side effects and
  // transitively loads `shell/health-header/slot.ts` (which declares the health-header slot).
  await import("../src/features/drift-and-coverage/index.js");
  const registry = await import("../src/registry/registry.js");
  const { HealthHeaderSlot } = await import("../src/shell/health-header/slot.js");
  const { DriftPage } = await import("../src/features/drift-and-coverage/DriftPage.js");
  const { FindingsFragment } = await import(
    "../src/features/drift-and-coverage/FindingsFragment.js"
  );
  const { DriftHealthSummary } = await import(
    "../src/features/drift-and-coverage/DriftHealthSummary.js"
  );
  return { registry, HealthHeaderSlot, DriftPage, FindingsFragment, DriftHealthSummary };
}

describe("drift feature registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers exactly the /drift page with the drift page component", async () => {
    const { registry, DriftPage } = await loadFreshFeature();
    const driftPages = registry.getPages().filter((page) => page.id === "page:drift/overview");
    expect(driftPages).toHaveLength(1);
    const [page] = driftPages;
    expect(page.path).toBe("/drift");
    expect(page.label).toBe("Drift");
    expect(await resolveComponent(page.component)).toBe(DriftPage);
    // No drift page is hidden from navigation and no extra drift page exists.
    expect(registry.getPages().filter((p) => p.path === "/drift")).toHaveLength(1);
  });

  it("registers exactly two findings-section entity fragments with distinct scopes", async () => {
    const { registry, FindingsFragment } = await loadFreshFeature();

    const hostFindings = registry.getEntityFragments("host", "findings");
    expect(hostFindings.map((fragment) => fragment.id)).toEqual(["section:drift/host-findings"]);
    expect(hostFindings[0].entity).toBe("host");
    expect(hostFindings[0]).toMatchObject({ section: "findings", title: "Findings", order: 10 });
    expect(await resolveComponent(hostFindings[0].component)).toBe(FindingsFragment);

    const serviceFindings = registry.getEntityFragments("service", "findings");
    expect(serviceFindings.map((fragment) => fragment.id)).toEqual(["section:drift/service-findings"]);
    expect(serviceFindings[0].entity).toBe("service");
    expect(serviceFindings[0]).toMatchObject({ section: "findings", title: "Findings", order: 10 });
    expect(await resolveComponent(serviceFindings[0].component)).toBe(FindingsFragment);

    // Exactly two entity fragments overall; both reuse the one FindingsFragment
    // component and share the "findings" section with separate host/service ids.
    expect(registry.getEntityFragments("host").map((f) => f.id)).toEqual([
      "section:drift/host-findings",
    ]);
    expect(registry.getEntityFragments("service").map((f) => f.id)).toEqual([
      "section:drift/service-findings",
    ]);
    expect(hostFindings[0].component).toBe(serviceFindings[0].component);
  });

  it("registers exactly one drift summary in the health-header slot", async () => {
    const { registry, HealthHeaderSlot, DriftHealthSummary } = await loadFreshFeature();
    const summaries = registry.getExtensions(HealthHeaderSlot.slotId);
    expect(summaries.map((fragment) => fragment.id)).toEqual(["pill:drift/summary"]);
    expect(summaries[0].component).toBe(DriftHealthSummary);
  });

  it("component assignments satisfy the registry contracts", async () => {
    const { DriftPage, FindingsFragment, DriftHealthSummary } = await loadFreshFeature();
    // Compile-time proof (validated by `tsc --noEmit` over the test tree) that the
    // registered components typecheck against PageRegistration, EntityFragment-
    // Registration's EntityRef component, and the HealthSummary summary contract.
    const page: PageRegistration = {
      id: "page:drift/overview",
      path: "/drift",
      label: "Drift",
      component: DriftPage,
    };
    const hostFragment: EntityFragmentRegistration = {
      id: "section:drift/host-findings",
      entity: "host",
      section: "findings",
      title: "Findings",
      component: FindingsFragment,
    };
    const serviceFragment: EntityFragmentRegistration = {
      id: "section:drift/service-findings",
      entity: "service",
      section: "findings",
      title: "Findings",
      component: FindingsFragment,
    };
    const summary: SummaryFragmentRegistration<HealthSummary> = {
      id: "pill:drift/summary",
      component: DriftHealthSummary,
    };
    expect([page.id, hostFragment.id, serviceFragment.id, summary.id]).toEqual([
      "page:drift/overview",
      "section:drift/host-findings",
      "section:drift/service-findings",
      "pill:drift/summary",
    ]);
  });

  it("fails loudly when a registration is invalid", async () => {
    // Eager discovery must not swallow RegistrationError; a duplicate id throws.
    const { registry } = await loadFreshFeature();
    expect(() =>
      registry.registerPage({
        id: "page:drift/overview",
        path: "/drift-again",
        label: "Drift Again",
        component: () => null,
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });

  it("all registered surfaces share the drift store rather than polling or deriving", () => {
    const surfaces = [
      "../src/features/drift-and-coverage/DriftPage.tsx",
      "../src/features/drift-and-coverage/FindingsFragment.tsx",
      "../src/features/drift-and-coverage/DriftHealthSummary.tsx",
    ];
    for (const relative of surfaces) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      // Every surface subscribes through the shared generation hook,
      expect(source).toContain("useDriftGeneration");
      // and none starts its own poll, derivation, or inventory subscription.
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toContain("deriveDriftProjection");
      expect(source).not.toContain("useInventoryData");
    }
  });
});

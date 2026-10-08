import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveComponent } from "./support/lazy.js";

// Import a fresh feature entrypoint against a fresh registry singleton, then inspect the public
// registry accessors. The feature declares the health-header slot its pill attaches to.
async function loadFreshFeature() {
  vi.resetModules();
  await import("../src/features/drift-and-coverage/index.js");
  const registry = await import("../src/registry/registry.js");
  const { HealthHeaderSlot } = await import("../src/shell/health-header/slot.js");
  const { DRIFT_UI } = await import("@deck/contract/modules/drift");
  return { registry, HealthHeaderSlot, DRIFT_UI };
}

// The components the feature registers, loaded only by the tests that compare against them (the
// lazy pages are slow to transform cold).
async function loadComponents() {
  const { DriftPage } = await import("../src/features/drift-and-coverage/DriftPage.js");
  const { FindingsFragment } = await import("../src/features/drift-and-coverage/FindingsFragment.js");
  const { DriftHealthSummary } = await import("../src/features/drift-and-coverage/DriftHealthSummary.js");
  return { DriftPage, FindingsFragment, DriftHealthSummary };
}

describe("the drift-and-coverage web half", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers exactly the drift module's contributions, with no placement of its own", async () => {
    const { registry, DRIFT_UI } = await loadFreshFeature();
    const ours = registry.getAllExtensions().filter(({ module }) => module === "drift");
    const declared = DRIFT_UI.contributes!;
    expect(ours.map(({ id }) => id).sort()).toEqual(
      [...declared.pages!, ...declared.nav!, ...declared.extensions!].map(({ id }) => id).sort(),
    );
    for (const extension of declared.extensions!) {
      const registered = ours.find(({ id }) => id === extension.id)!;
      expect(registered).toMatchObject({ kind: extension.kind });
      expect(registered.attachTo).toEqual({ slot: extension.attachTo.slot, order: extension.attachTo.order ?? 100 });
      // A pill carries no config; the registry stores it as empty.
      expect(registered.config).toEqual(extension.config ?? {});
    }
  });

  it("registers exactly the /drift page with the drift page component, listed in the health group", async () => {
    const { registry } = await loadFreshFeature();
    const { DriftPage } = await loadComponents();
    const driftPages = registry.getPages().filter((page) => page.id === "page:drift/overview");
    expect(driftPages).toHaveLength(1);
    const [page] = driftPages;
    expect(page).toMatchObject({ path: "/drift", label: "Drift", icon: "git-compare", group: "health" });
    expect(await resolveComponent(page!.component)).toBe(DriftPage);
    expect(page!.nav).not.toBe(false);
    // The nav entry sets no order of its own, so the fallback nav orders it like the route.
    expect(page!.navOrder).toBeUndefined();
    // No drift page is hidden from navigation and no extra drift page exists.
    expect(registry.getPages().filter((p) => p.path === "/drift")).toHaveLength(1);
  });

  it("registers exactly two findings-section entity fragments with distinct scopes", async () => {
    const { registry } = await loadFreshFeature();
    const { FindingsFragment } = await loadComponents();

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
    const { registry, HealthHeaderSlot } = await loadFreshFeature();
    const { DriftHealthSummary } = await loadComponents();
    const summaries = registry.getExtensions(HealthHeaderSlot.slotId);
    expect(summaries.map((fragment) => fragment.id)).toEqual(["pill:drift/summary"]);
    expect(await resolveComponent(summaries[0]!.component!)).toBe(DriftHealthSummary);
  });

  it("declares the health-header slot its pill attaches to, whatever imports it first", async () => {
    vi.resetModules();
    // Only the feature: nothing here imports the slot module before it.
    await import("../src/features/drift-and-coverage/index.js");
    const registry = await import("../src/registry/registry.js");
    expect(registry.getSlot("app/topbar.status")).toBeDefined();
    expect(registry.getOrphanAttachments()).toEqual([]);
  });

  it("fails loudly when its own registration is refused", async () => {
    vi.resetModules();
    const registry = await import("../src/registry/registry.js");
    // Another registration already holds one of drift's ids.
    registry.registerPage({ id: "page:drift/overview", path: "/drift-elsewhere", label: "Elsewhere", component: () => null });
    // Eager discovery must not swallow the RegistrationError.
    await expect(import("../src/features/drift-and-coverage/index.js")).rejects.toMatchObject({ code: "DUPLICATE_ID" });
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

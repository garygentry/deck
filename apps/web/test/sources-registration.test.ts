import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EntityFragmentRegistration,
  PageRegistration,
} from "../src/registry/registry.js";
import { resolveComponent } from "./support/lazy.js";

// Import a fresh feature entrypoint against a fresh registry singleton, then inspect the public
// registry accessors to prove the eager side effects (08 §5.3). The pages + fragments are
// discovered by `import.meta.glob("../features/*/index.ts")` with NO shell edit (SC-09); importing
// the entrypoint runs its registration side effects.
async function loadFreshFeature() {
  vi.resetModules();
  const feature = await import(
    "../src/features/sources-docs-and-configs/index.js"
  );
  const registry = await import("../src/registry/registry.js");
  const { DocsPage, ConfigsPage } = await import(
    "../src/features/sources-docs-and-configs/SourceBrowserPage.js"
  );
  const { OwnedConfigsFragment } = await import(
    "../src/features/sources-docs-and-configs/OwnedConfigsFragment.js"
  );
  return { feature, registry, DocsPage, ConfigsPage, OwnedConfigsFragment };
}

describe("sources-docs-and-configs feature registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers exactly the /docs page with the DocsPage component", async () => {
    const { registry, DocsPage } = await loadFreshFeature();
    const pages = registry.getPages().filter((page) => page.id === "docs");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.path).toBe("/docs");
    expect(page.label).toBe("Docs");
    expect(await resolveComponent(page.component)).toBe(DocsPage);
    expect(registry.getPages().filter((p) => p.path === "/docs")).toHaveLength(1);
  });

  it("registers exactly the /configs page with id configs-view (NOT the slot id)", async () => {
    const { registry, ConfigsPage } = await loadFreshFeature();
    const pages = registry.getPages().filter((page) => page.id === "configs-view");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.path).toBe("/configs");
    expect(page.label).toBe("Configs");
    expect(await resolveComponent(page.component)).toBe(ConfigsPage);
    // The page id is "configs-view", NOT "configs" (which is the entity SLOT id — a distinct
    // namespace). No page carries the slot id.
    expect(registry.getPages().some((p) => p.id === "configs")).toBe(false);
    expect(registry.getPages().filter((p) => p.path === "/configs")).toHaveLength(1);
  });

  it("registers the fragment on the host 'configs' slot", async () => {
    const { registry, OwnedConfigsFragment } = await loadFreshFeature();
    const fragments = registry.getEntityFragments("host", "configs");
    expect(await Promise.all(fragments.map((f) => resolveComponent(f.component)))).toContain(OwnedConfigsFragment);
    const owned = fragments.filter((f) => f.id === "owned-configs-host");
    expect(owned).toHaveLength(1);
    expect(owned[0].entity).toBe("host");
    expect(owned[0].slot).toBe("configs");
  });

  it("registers the fragment on the service 'configs' slot", async () => {
    const { registry, OwnedConfigsFragment } = await loadFreshFeature();
    const fragments = registry.getEntityFragments("service", "configs");
    expect(await Promise.all(fragments.map((f) => resolveComponent(f.component)))).toContain(OwnedConfigsFragment);
    const owned = fragments.filter((f) => f.id === "owned-configs-service");
    expect(owned).toHaveLength(1);
    expect(owned[0].entity).toBe("service");
    expect(owned[0].slot).toBe("configs");
  });

  it("is an import-side-effect only module that exports nothing", async () => {
    const { feature } = await loadFreshFeature();
    expect(Object.keys(feature)).toEqual([]);
  });

  it("registers exactly two pages and two entity fragments for the feature", async () => {
    const { registry } = await loadFreshFeature();
    const featurePages = registry
      .getPages()
      .filter((p) => p.id === "docs" || p.id === "configs-view");
    expect(featurePages).toHaveLength(2);
    const featureFragments = [
      ...registry.getEntityFragments("host", "configs"),
      ...registry.getEntityFragments("service", "configs"),
    ].filter((f) => f.id === "owned-configs-host" || f.id === "owned-configs-service");
    expect(featureFragments).toHaveLength(2);
  });

  it("fails loudly when a registration is invalid", async () => {
    // Eager discovery must not swallow RegistrationError; a duplicate id throws.
    const { registry } = await loadFreshFeature();
    expect(() =>
      registry.registerPage({
        id: "docs",
        path: "/docs-again",
        label: "Docs Again",
        component: () => null,
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });

  it("assignments satisfy the registry contracts", async () => {
    const { DocsPage, ConfigsPage, OwnedConfigsFragment } = await loadFreshFeature();
    // Compile-time proof (checked by tsc over the test tree) that the registered components
    // typecheck against their registration shapes.
    const docs: PageRegistration = {
      id: "docs",
      path: "/docs",
      label: "Docs",
      component: DocsPage,
    };
    const configs: PageRegistration = {
      id: "configs-view",
      path: "/configs",
      label: "Configs",
      component: ConfigsPage,
    };
    const fragment: EntityFragmentRegistration = {
      id: "owned-configs-host",
      entity: "host",
      slot: "configs",
      component: OwnedConfigsFragment,
    };
    expect(docs.id).toBe("docs");
    expect(configs.id).toBe("configs-view");
    expect(fragment.slot).toBe("configs");
  });
});

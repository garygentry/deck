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
    const pages = registry.getPages().filter((page) => page.id === "page:sources/docs");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.path).toBe("/docs");
    expect(page.label).toBe("Docs");
    expect(await resolveComponent(page.component)).toBe(DocsPage);
    expect(registry.getPages().filter((p) => p.path === "/docs")).toHaveLength(1);
  });

  it("registers exactly the /configs page with id configs-view (NOT the slot id)", async () => {
    const { registry, ConfigsPage } = await loadFreshFeature();
    const pages = registry.getPages().filter((page) => page.id === "page:sources/configs");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.path).toBe("/configs");
    expect(page.label).toBe("Configs");
    expect(await resolveComponent(page.component)).toBe(ConfigsPage);
    expect(registry.getPages().filter((p) => p.path === "/configs")).toHaveLength(1);
  });

  it("registers the fragment in the host 'Configs' section, after findings", async () => {
    const { registry, OwnedConfigsFragment } = await loadFreshFeature();
    const fragments = registry.getEntityFragments("host", "configs");
    expect(await Promise.all(fragments.map((f) => resolveComponent(f.component)))).toContain(OwnedConfigsFragment);
    const owned = fragments.filter((f) => f.id === "section:sources/host-configs");
    expect(owned).toHaveLength(1);
    expect(owned[0].entity).toBe("host");
    expect(owned[0]).toMatchObject({ section: "configs", title: "Configs", order: 20 });
  });

  it("registers the fragment in the service 'Configs' section, after findings", async () => {
    const { registry, OwnedConfigsFragment } = await loadFreshFeature();
    const fragments = registry.getEntityFragments("service", "configs");
    expect(await Promise.all(fragments.map((f) => resolveComponent(f.component)))).toContain(OwnedConfigsFragment);
    const owned = fragments.filter((f) => f.id === "section:sources/service-configs");
    expect(owned).toHaveLength(1);
    expect(owned[0].entity).toBe("service");
    expect(owned[0]).toMatchObject({ section: "configs", title: "Configs", order: 20 });
  });

  it("is an import-side-effect only module that exports nothing", async () => {
    const { feature } = await loadFreshFeature();
    expect(Object.keys(feature)).toEqual([]);
  });

  it("registers exactly two pages and two entity fragments for the feature", async () => {
    const { registry } = await loadFreshFeature();
    const featurePages = registry
      .getPages()
      .filter((p) => p.id === "page:sources/docs" || p.id === "page:sources/configs");
    expect(featurePages).toHaveLength(2);
    const featureFragments = [
      ...registry.getEntityFragments("host", "configs"),
      ...registry.getEntityFragments("service", "configs"),
    ].filter((f) => f.id === "section:sources/host-configs" || f.id === "section:sources/service-configs");
    expect(featureFragments).toHaveLength(2);
  });

  it("fails loudly when a registration is invalid", async () => {
    // Eager discovery must not swallow RegistrationError; a duplicate id throws.
    const { registry } = await loadFreshFeature();
    expect(() =>
      registry.registerPage({
        id: "page:sources/docs",
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
      id: "page:sources/docs",
      path: "/docs",
      label: "Docs",
      component: DocsPage,
    };
    const configs: PageRegistration = {
      id: "page:sources/configs",
      path: "/configs",
      label: "Configs",
      component: ConfigsPage,
    };
    const fragment: EntityFragmentRegistration = {
      id: "section:sources/host-configs",
      entity: "host",
      section: "configs",
      title: "Configs",
      component: OwnedConfigsFragment,
    };
    expect(docs.id).toBe("page:sources/docs");
    expect(configs.id).toBe("page:sources/configs");
    expect(fragment.section).toBe("configs");
  });
});

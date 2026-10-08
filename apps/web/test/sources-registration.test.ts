import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveComponent } from "./support/lazy.js";

// Import a fresh feature entrypoint against a fresh registry singleton, then inspect the public
// registry accessors. Each test loads its own copy, so each passes alone.
async function loadFreshFeature() {
  vi.resetModules();
  const feature = await import("../src/features/sources-docs-and-configs/index.js");
  const registry = await import("../src/registry/registry.js");
  const { SOURCES_UI } = await import("@deck/contract/modules/sources");
  return { feature, registry, SOURCES_UI };
}

// The components behind the lazy registrations, loaded only by the tests that resolve them. The
// pages pull in markdown-it, DOMPurify and highlight.js, so only the page test loads them.
async function loadFragment() {
  const { OwnedConfigsFragment } = await import("../src/features/sources-docs-and-configs/OwnedConfigsFragment.js");
  return OwnedConfigsFragment;
}

async function loadPages() {
  const { DocsPage, ConfigsPage } = await import("../src/features/sources-docs-and-configs/SourceBrowserPage.js");
  return { DocsPage, ConfigsPage };
}

describe("the sources-docs-and-configs web half", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers exactly the sources module's contributions, with no placement of its own", async () => {
    const { feature, registry, SOURCES_UI } = await loadFreshFeature();
    const OwnedConfigsFragment = await loadFragment();
    expect(feature.sourcesWebModule.manifest).toBe(SOURCES_UI);
    const ours = registry.getAllExtensions().filter(({ module }) => module === "sources");
    const declared = SOURCES_UI.contributes!;
    expect(ours.map(({ id }) => id).sort()).toEqual(
      [...declared.pages!, ...declared.nav!, ...declared.extensions!].map(({ id }) => id).sort(),
    );
    expect(declared.slots ?? []).toEqual([]);
    for (const extension of declared.extensions!) {
      const registered = ours.find(({ id }) => id === extension.id)!;
      expect(registered.kind).toBe(extension.kind);
      expect(registered.attachTo).toEqual({ slot: extension.attachTo.slot, order: extension.attachTo.order ?? 100 });
      expect(registered.config).toEqual(extension.config);
      const component = registered.component;
      expect(component).toBeDefined();
      if (component !== undefined) expect(await resolveComponent(component)).toBe(OwnedConfigsFragment);
    }
  });

  it.each([
    ["page:sources/docs", "/docs", "Docs", "book-open", "DocsPage"],
    ["page:sources/configs", "/configs", "Configs", "file-cog", "ConfigsPage"],
  ] as const)("registers exactly one %s page at %s, listed in the knowledge group", async (id, path, label, icon, component) => {
    const { registry } = await loadFreshFeature();
    const pages = await loadPages();
    const registered = registry.getPages().filter((page) => page.id === id);
    expect(registered).toHaveLength(1);
    const [page] = registered;
    expect(page).toMatchObject({ path, label, icon, group: "knowledge" });
    expect(page!.nav).not.toBe(false);
    // The nav entries set no order of their own, so the fallback nav orders them like the routes.
    expect(page!.navOrder).toBeUndefined();
    expect(await resolveComponent(page!.component)).toBe(pages[component]);
    expect(registry.getPages().filter((p) => p.path === path)).toHaveLength(1);
  });

  it.each(["host", "service"] as const)("attaches the owned-configs section to %s detail pages, after drift's findings", async (entity) => {
    const { registry } = await loadFreshFeature();
    const OwnedConfigsFragment = await loadFragment();
    // A findings section at drift's order, registered here so the test stands alone.
    registry.registerEntityFragment({ id: `section:fixture/${entity}-findings`, entity, section: "findings", title: "Findings", order: 10, component: () => null });
    const owned = registry.getEntityFragments(entity, "configs");
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ id: `section:sources/${entity}-configs`, entity, section: "configs", title: "Configs", order: 20 });
    expect(await resolveComponent(owned[0]!.component)).toBe(OwnedConfigsFragment);
    expect(registry.getEntitySections(entity).map(({ section }) => section)).toEqual(["findings", "configs"]);
  });

  it("fails loudly with DUPLICATE_ID when a page id is re-registered", async () => {
    const { registry } = await loadFreshFeature();
    expect(() =>
      registry.registerPage({ id: "page:sources/docs", path: "/docs-again", label: "Docs Again", component: () => null }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveComponent } from "./support/lazy.js";

// Import a fresh feature entrypoint against a fresh registry singleton, then inspect the public
// registry accessors. The page is discovered by `import.meta.glob("../features/*/index.ts")`
// with no shell edit; importing the entrypoint runs its one registration side effect.
async function loadFreshFeature() {
  vi.resetModules();
  const feature = await import("../../../modules/actions/web/index.js");
  const registry = await import("../src/registry/registry.js");
  const { ACTIONS_UI } = await import("@deck/contract/modules/actions");
  const { ActionsPage } = await import("../../../modules/actions/web/ActionsPage.js");
  return { feature, registry, ACTIONS_UI, ActionsPage };
}

describe("the governed-actions web half", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers exactly the actions module's contributions, with no placement of its own", async () => {
    const { registry, ACTIONS_UI } = await loadFreshFeature();
    const ours = registry.getAllExtensions().filter(({ module }) => module === "actions");
    const declared = ACTIONS_UI.contributes!;
    expect(ours.map(({ id }) => id).sort()).toEqual([...declared.pages!, ...declared.nav!].map(({ id }) => id).sort());
    // A standalone page: no cards, entity sections, pills or slots of its own.
    expect(declared.extensions).toBeUndefined();
    expect(declared.slots).toBeUndefined();
  });

  it("registers exactly one /actions page with the ActionsPage component, listed in the operate group", async () => {
    const { registry, ActionsPage } = await loadFreshFeature();
    const pages = registry.getPages().filter((page) => page.id === "page:actions/overview");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page).toMatchObject({ path: "/actions", label: "Actions", icon: "zap", group: "operate" });
    expect(await resolveComponent(page!.component)).toBe(ActionsPage);
    expect(page!.nav).not.toBe(false);
    // The nav entry sets no order of its own, so the fallback nav orders it like the route.
    expect(page!.navOrder).toBeUndefined();
    expect(registry.getPages().filter((p) => p.path === "/actions")).toHaveLength(1);
  });

  it("exports only its web module, defined over the shared manifest", async () => {
    const { feature, ACTIONS_UI, ActionsPage } = await loadFreshFeature();
    expect(Object.keys(feature)).toEqual(["actionsWebModule"]);
    expect(feature.actionsWebModule.manifest).toBe(ACTIONS_UI);
    expect(await resolveComponent(feature.actionsWebModule.components.ActionsPage)).toBe(ActionsPage);
  });

  it("fails loudly with DUPLICATE_ID when its page id is already taken, registering nothing", async () => {
    // Eager discovery must not swallow RegistrationError: the feature's own import rejects.
    vi.resetModules();
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "page:actions/overview", path: "/actions-taken", label: "Taken", component: () => null, nav: false });
    await expect(import("../../../modules/actions/web/index.js")).rejects.toThrowError(
      expect.objectContaining({ code: "DUPLICATE_ID", message: expect.stringContaining("registerWebModule(actions)") }),
    );
    expect(registry.getPages().filter(({ id }) => id === "page:actions/overview").map(({ path }) => path)).toEqual(["/actions-taken"]);
    expect(registry.getAllExtensions().filter(({ id }) => id === "nav:actions/overview")).toEqual([]);
  });
});

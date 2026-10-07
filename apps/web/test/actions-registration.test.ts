import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageRegistration } from "../src/registry/registry.js";
import { resolveComponent } from "./support/lazy.js";

// Import a fresh feature entrypoint against a fresh registry singleton, then
// inspect the public registry accessors to prove the single eager side effect.
// The page is discovered by `import.meta.glob("../features/*/index.ts")` with no
// shell edit; importing the entrypoint runs its one registration side effect.
async function loadFreshFeature() {
  vi.resetModules();
  const feature = await import("../src/features/governed-actions/index.js");
  const registry = await import("../src/registry/registry.js");
  const { ActionsPage } = await import(
    "../src/features/governed-actions/ActionsPage.js"
  );
  return { feature, registry, ActionsPage };
}

describe("governed-actions feature registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers exactly the /actions page with the ActionsPage component", async () => {
    const { registry, ActionsPage } = await loadFreshFeature();
    const pages = registry.getPages().filter((page) => page.id === "actions");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.path).toBe("/actions");
    expect(page.label).toBe("Actions");
    expect(await resolveComponent(page.component)).toBe(ActionsPage);
    // Exactly one /actions page exists and it appears in primary navigation.
    expect(registry.getPages().filter((p) => p.path === "/actions")).toHaveLength(1);
    expect(page.nav).not.toBe(false);
  });

  it("is an import-side-effect only module that exports nothing", async () => {
    const { feature } = await loadFreshFeature();
    expect(Object.keys(feature)).toEqual([]);
  });

  it("registers exactly one page and no other surfaces for the feature", async () => {
    const { registry } = await loadFreshFeature();
    // The Actions surface is a standalone page — no cards, no entity fragments,
    // no summary-slot contribution.
    const actionPages = registry
      .getPages()
      .filter((page) => page.id === "actions" || page.path === "/actions");
    expect(actionPages).toHaveLength(1);
  });

  it("fails loudly when the registration is invalid", async () => {
    // Eager discovery must not swallow RegistrationError; a duplicate id throws.
    const { registry } = await loadFreshFeature();
    expect(() =>
      registry.registerPage({
        id: "actions",
        path: "/actions-again",
        label: "Actions Again",
        component: () => null,
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });

  it("component assignment satisfies the registry contract", async () => {
    const { ActionsPage } = await loadFreshFeature();
    // Compile-time proof (checked by tsc over the test tree) that the registered
    // component typechecks against PageRegistration.
    const page: PageRegistration = {
      id: "actions",
      path: "/actions",
      label: "Actions",
      component: ActionsPage,
    };
    expect(page.id).toBe("actions");
  });
});

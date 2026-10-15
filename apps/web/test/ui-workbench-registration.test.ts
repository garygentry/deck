import { afterEach, describe, expect, it, vi } from "vitest";

// Import a fresh workbench entrypoint against a fresh registry singleton, with
// `import.meta.env.DEV` (and the overlay lab's build flag) set per case.
async function workbenchPages(dev: boolean, overlayLab?: string) {
  vi.resetModules();
  vi.stubEnv("DEV", dev);
  if (overlayLab !== undefined) vi.stubEnv("VITE_DECK_OVERLAY_LAB", overlayLab);
  await import("../src/features/_ui/index.js");
  const registry = await import("../src/registry/registry.js");
  return registry.getPages().filter((page) => page.id.startsWith("page:ui-workbench/"));
}

describe("ui workbench registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers /_ui and the overlay lab off the primary nav in development", async () => {
    const pages = await workbenchPages(true);
    expect(pages).toHaveLength(2);
    expect(pages.find((page) => page.id === "page:ui-workbench/overview")).toMatchObject({ path: "/_ui", nav: false });
    expect(pages.find((page) => page.id === "page:ui-workbench/overlays")).toMatchObject({ path: "/_ui/overlays", nav: false });
  });

  it("registers nothing in a production build", async () => {
    expect(await workbenchPages(false)).toHaveLength(0);
    expect(await workbenchPages(false, "")).toHaveLength(0);
  });

  it("registers only the overlay lab in a production build that asks for it", async () => {
    const pages = await workbenchPages(false, "true");
    expect(pages.map((page) => page.path)).toEqual(["/_ui/overlays"]);
  });
});

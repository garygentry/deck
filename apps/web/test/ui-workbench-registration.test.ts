import { afterEach, describe, expect, it, vi } from "vitest";

// Import a fresh workbench entrypoint against a fresh registry singleton, with
// `import.meta.env.DEV` set per case.
async function workbenchPages(dev: boolean) {
  vi.resetModules();
  vi.stubEnv("DEV", dev);
  await import("../src/features/_ui/index.js");
  const registry = await import("../src/registry/registry.js");
  return registry.getPages().filter((page) => page.id === "page:core/ui-workbench");
}

describe("ui workbench registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers /_ui off the primary nav in development", async () => {
    const pages = await workbenchPages(true);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ path: "/_ui", nav: false });
  });

  it("registers nothing in a production build", async () => {
    expect(await workbenchPages(false)).toHaveLength(0);
  });
});

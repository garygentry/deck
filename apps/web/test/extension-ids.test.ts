import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { UiManifest } from "@deck/module-sdk";
import { describe, expect, it, vi } from "vitest";

/**
 * The web registers its built-in extensions under the ids the server's UI manifest lists, so
 * config overrides and the manifest address the same contributions. The server golden for
 * the example estate with every capability on is the reference.
 */
const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../server/test/golden/ui/examples-estate.all-features.json", import.meta.url)),
    "utf8",
  ),
) as UiManifest;

/** Web-only registrations the server does not list: the dev workbench. */
const WEB_ONLY = new Set(["page:ui-workbench/overview"]);

async function webExtensions() {
  vi.resetModules();
  await import("../src/shell/health-header/slot.js");
  await import("../src/registry/discover.js");
  await import("../src/shell/topbar-actions.js");
  const registry = await import("../src/registry/registry.js");
  return registry.getAllExtensions().filter((extension) => !WEB_ONLY.has(extension.id));
}

describe("web extension ids match the server UI manifest", () => {
  it("registers exactly the pages, nav entries and extensions the manifest lists", async () => {
    const web = (await webExtensions()).map(({ id }) => id).sort();
    const server = [...golden.pages, ...golden.nav, ...golden.extensions].map(({ id }) => id).sort();
    expect(web).toEqual(server);
  });

  it("attaches each extension, of the manifest's kind, to the slot and order it gives", async () => {
    const web = (await webExtensions()).filter((extension) => extension.kind !== "page" && extension.kind !== "nav");
    const bySlot = web.map(({ id, kind, attachTo }) => `${attachTo.slot} ${attachTo.order} ${kind} ${id}`).sort();
    expect(bySlot).toEqual(golden.extensions.map(({ id, kind, slot, order }) => `${slot} ${order} ${kind} ${id}`).sort());
  });

  it("gives each entity section the manifest's title and section", async () => {
    const sections = (await webExtensions()).filter((extension) => extension.kind === "entity-section");
    expect(sections.map(({ id, config }) => `${id} ${JSON.stringify(config)}`).sort()).toEqual(
      golden.extensions.filter(({ kind }) => kind === "entity-section").map(({ id, config }) => `${id} ${JSON.stringify(config)}`).sort(),
    );
  });

  it("routes each page at the manifest's path", async () => {
    const pages = (await webExtensions()).filter((extension) => extension.kind === "page");
    expect(pages.map(({ id, config }) => `${id} ${String(config.path)}`).sort()).toEqual(
      golden.pages.map(({ id, path }) => `${id} ${path}`).sort(),
    );
  });
});

describe("web slots match the server UI manifest", () => {
  it("leaves no built-in extension on an undeclared slot", async () => {
    await webExtensions();
    const registry = await import("../src/registry/registry.js");
    expect(registry.getOrphanAttachments()).toEqual([]);
  });

  it("declares each manifest slot with the same accepts and host", async () => {
    await webExtensions();
    const registry = await import("../src/registry/registry.js");
    for (const slot of golden.slots) expect(registry.getSlot(slot.id), slot.id).toEqual(slot);
  });
});

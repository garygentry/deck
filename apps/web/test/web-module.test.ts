import { defineWebModule, type WebModuleManifest } from "@deck/module-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveComponent } from "./support/lazy.js";

const Page = () => null;
const Pill = () => null;
const Card = () => null;

const manifest = (contributes: WebModuleManifest["contributes"]): WebModuleManifest => ({ id: "demo", version: "1.0.0", deckApi: "^0.1", contributes });

const DEMO = manifest({
  pages: [
    { id: "page:demo/overview", path: "/demo", title: "Demo", icon: "gauge", component: "Page" },
    { id: "page:demo/hidden", path: "/demo/hidden", title: "Hidden", component: "Page" },
  ],
  nav: [{ id: "nav:demo/overview", page: "page:demo/overview", group: "health", order: 30 }],
  slots: [{ id: "demo/cards", accepts: "widget" }],
  extensions: [
    { id: "pill:demo/summary", kind: "pill", attachTo: { slot: "app/topbar.status", order: 40 }, component: "Pill" },
    { id: "card:demo/main", kind: "widget", attachTo: { slot: "demo/cards" }, component: "Card", config: { size: "s" } },
    { id: "widget:demo/descriptor", kind: "widget", attachTo: { slot: "demo/cards" }, widget: { type: "demo/stat" } },
  ],
});

async function fresh() {
  vi.resetModules();
  const registry = await import("../src/registry/registry.js");
  const { registerWebModule } = await import("../src/registry/web-module.js");
  return { registry, registerWebModule };
}

describe("registerWebModule", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("derives pages, nav entries, slots and extensions from the manifest, with components from the table", async () => {
    const { registry, registerWebModule } = await fresh();
    registerWebModule(defineWebModule(DEMO, { components: { Page, Pill, Card } }));

    expect(registry.getPages()).toEqual([
      { id: "page:demo/hidden", path: "/demo/hidden", label: "Hidden", component: Page, nav: false },
      { id: "page:demo/overview", path: "/demo", label: "Demo", icon: "gauge", component: Page, group: "health", order: 30 },
    ].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)));
    expect(registry.getExtensions("app/nav").map(({ id, attachTo }) => `${id} ${attachTo.order}`)).toEqual(["nav:demo/overview 30"]);
    expect(registry.getSlot("demo/cards")).toEqual({ id: "demo/cards", accepts: "widget", module: "demo" });

    const pill = registry.getAllExtensions().find(({ id }) => id === "pill:demo/summary")!;
    expect(pill).toMatchObject({ kind: "pill", module: "demo", attachTo: { slot: "app/topbar.status", order: 40 }, enabled: true });
    expect(await resolveComponent(pill.component!)).toBe(Pill);
    expect(registry.getExtensions("demo/cards").map(({ id, config, component }) => ({ id, config, component }))).toEqual([
      { id: "card:demo/main", config: { size: "s" }, component: Card },
    ]);
  });

  it("skips widget-descriptor extensions, which name no component", async () => {
    const { registry, registerWebModule } = await fresh();
    registerWebModule(defineWebModule(DEMO, { components: { Page, Pill, Card } }));
    expect(registry.getAllExtensions().map(({ id }) => id)).not.toContain("widget:demo/descriptor");
  });

  it("refuses a component the manifest names but the table lacks, naming the module and component", async () => {
    const { registry, registerWebModule } = await fresh();
    expect(() => registerWebModule(defineWebModule(DEMO, { components: { Page, Pill } }))).toThrow(
      'registerWebModule(demo): component "Card" is named by the manifest but missing from the component table',
    );
    expect(registry.getAllExtensions().filter(({ module }) => module === "demo")).toEqual([]);
  });

  it("refuses a table entry nothing references, naming the module and component", async () => {
    const { registerWebModule } = await fresh();
    const Spare = () => null;
    expect(() => registerWebModule(defineWebModule(DEMO, { components: { Page, Pill, Card, Spare } }))).toThrow(
      'registerWebModule(demo): component "Spare" is in the component table but no page or extension names it',
    );
  });

  it("refuses nav entries the registry cannot express", async () => {
    const { registerWebModule } = await fresh();
    const page = { id: "page:demo/overview", path: "/demo", title: "Demo", component: "Page" } as const;
    const cases: [WebModuleManifest["contributes"], string][] = [
      [{ pages: [page], nav: [{ id: "nav:demo/docs", href: "https://example.test", group: "knowledge" }] }, 'registerWebModule(demo): nav entry "nav:demo/docs" has no page; href nav entries are not supported'],
      [{ pages: [page], nav: [{ id: "nav:demo/other", page: page.id, group: "health" }] }, 'registerWebModule(demo): nav entry "nav:demo/other" must be named after its page, "nav:demo/overview"'],
      [{ pages: [], nav: [{ id: "nav:demo/overview", page: page.id, group: "health" }] }, 'registerWebModule(demo): a nav entry targets "page:demo/overview", which is not one of the module\'s pages'],
    ];
    for (const [contributes, message] of cases) {
      const components = (contributes?.pages ?? []).length > 0 ? { Page } : {};
      expect(() => registerWebModule(defineWebModule(manifest(contributes), { components }))).toThrow(message);
    }
  });
});

describe("the llm-usage web half", () => {
  it("registers exactly its module's contributions, with no placement of its own", async () => {
    vi.resetModules();
    await import("../src/shell/health-header/slot.js");
    await import("../src/shell/portal-summary-slot.js");
    await import("../src/features/llm-usage/index.js");
    const registry = await import("../src/registry/registry.js");
    const { LLM_USAGE_UI } = await import("@deck/contract/modules/llm-usage");
    const { LlmUsageSummary } = await import("../src/features/llm-usage/LlmUsageSummary.js");
    const { LlmUsagePortalCard } = await import("../src/features/llm-usage/LlmUsagePortalCard.js");
    const { LlmUsagePage } = await import("../src/features/llm-usage/LlmUsagePage.js");

    const ours = registry.getAllExtensions().filter(({ module }) => module === "llm-usage");
    const declared = LLM_USAGE_UI.contributes!;
    expect(ours.map(({ id }) => id).sort()).toEqual(
      [...declared.pages!, ...declared.nav!, ...declared.extensions!].map(({ id }) => id).sort(),
    );
    for (const extension of declared.extensions!) {
      const registered = ours.find(({ id }) => id === extension.id)!;
      expect(registered.attachTo).toEqual({ slot: extension.attachTo.slot, order: extension.attachTo.order ?? 100 });
    }
    const [page] = registry.getPages().filter(({ id }) => id === "page:llm-usage/overview");
    expect(page).toMatchObject({ path: "/usage", label: "LLM usage", icon: "gauge", group: "health" });
    expect(await resolveComponent(page!.component)).toBe(LlmUsagePage);
    expect(await resolveComponent(ours.find(({ id }) => id === "pill:llm-usage/summary")!.component!)).toBe(LlmUsageSummary);
    expect(await resolveComponent(ours.find(({ id }) => id === "card:llm-usage/portal")!.component!)).toBe(LlmUsagePortalCard);
  });
});

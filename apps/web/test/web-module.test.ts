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

// A fresh registry, with the shell's top-bar status slot declared unless `shell` is false.
async function fresh({ shell = true } = {}) {
  vi.resetModules();
  const registry = await import("../src/registry/registry.js");
  if (shell) await import("../src/shell/health-header/slot.js");
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

    // The routes keep the default order; the nav entry's order orders only the nav.
    expect(registry.getPages()).toEqual([
      { id: "page:demo/hidden", path: "/demo/hidden", label: "Hidden", component: Page, nav: false },
      { id: "page:demo/overview", path: "/demo", label: "Demo", icon: "gauge", component: Page, group: "health", navOrder: 30 },
    ]);
    expect(registry.getExtensions("app/routes").map(({ attachTo }) => attachTo.order)).toEqual([100, 100]);
    expect(registry.getExtensions("app/nav").map(({ id, attachTo }) => `${id} ${attachTo.order}`)).toEqual(["nav:demo/overview 30"]);
    expect(registry.getSlot("demo/cards")).toEqual({ id: "demo/cards", accepts: "widget", module: "demo" });

    const pill = registry.getAllExtensions().find(({ id }) => id === "pill:demo/summary")!;
    expect(pill).toMatchObject({ kind: "pill", module: "demo", attachTo: { slot: "app/topbar.status", order: 40 }, enabled: true });
    expect(await resolveComponent(pill.component!)).toBe(Pill);
    expect(registry.getExtensions("demo/cards").map(({ id, config, component }) => ({ id, config, component }))).toEqual([
      { id: "card:demo/main", config: { size: "s" }, component: Card },
    ]);
  });

  it("labels a route by its page's title and icon, whatever its nav entry shows", async () => {
    const { registry, registerWebModule } = await fresh();
    const relabelled = manifest({
      pages: [{ id: "page:demo/overview", path: "/demo", title: "Demo", icon: "gauge", component: "Page" }],
      nav: [{ id: "nav:demo/overview", page: "page:demo/overview", group: "health", label: "Demo nav", icon: "cpu" }],
    });
    registerWebModule(defineWebModule(relabelled, { components: { Page } }));
    expect(registry.getPages()).toMatchObject([{ label: "Demo", icon: "gauge" }]);
  });

  it("skips widget-descriptor extensions, which name no component", async () => {
    const { registry, registerWebModule } = await fresh();
    registerWebModule(defineWebModule(DEMO, { components: { Page, Pill, Card } }));
    expect(registry.getAllExtensions().map(({ id }) => id)).not.toContain("widget:demo/descriptor");
  });

  it("refuses any other extension without a component, naming the module and extension", async () => {
    const { registerWebModule } = await fresh();
    for (const extension of [
      { id: "pill:demo/bare", kind: "pill", attachTo: { slot: "app/topbar.status" } },
      { id: "section:demo/bare", kind: "entity-section", attachTo: { slot: "entity:host/sections" }, config: { title: "Bare" } },
    ] as const) {
      expect(() => registerWebModule(defineWebModule(manifest({ extensions: [extension] }), { components: {} }))).toThrow(
        `registerWebModule(demo): extension "${extension.id}" names no component and is not a widget descriptor`,
      );
    }
  });

  it("counts a widget type's component as named, and leaves it unregistered", async () => {
    const { registry, registerWebModule } = await fresh();
    const Stat = () => null;
    const withType = manifest({ widgetTypes: [{ type: "demo/stat", optionsSchema: {}, component: "Stat" }] });
    expect(() => registerWebModule(defineWebModule(withType, { components: {} }))).toThrow('component "Stat" is named by the manifest');
    registerWebModule(defineWebModule(withType, { components: { Stat } }));
    expect(registry.getAllExtensions().filter(({ module }) => module === "demo")).toEqual([]);
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
      'registerWebModule(demo): component "Spare" is in the component table but no page, extension or widget type names it',
    );
  });

  it("refuses nav entries the registry cannot express", async () => {
    const { registerWebModule } = await fresh();
    const page = { id: "page:demo/overview", path: "/demo", title: "Demo", component: "Page" } as const;
    const cases: [WebModuleManifest["contributes"], string][] = [
      [{ pages: [page], nav: [{ id: "nav:demo/docs", href: "https://example.test", group: "knowledge" }] }, 'registerWebModule(demo): nav entry "nav:demo/docs" has no page; href nav entries are not supported'],
      [{ pages: [page], nav: [{ id: "nav:demo/other", page: page.id, group: "health" }] }, 'registerWebModule(demo): nav entry "nav:demo/other" must be named after its page, "nav:demo/overview"'],
      [{ pages: [page], nav: [{ id: "nav:demo/overview", page: page.id, group: "health" }, { id: "nav:demo/overview", page: page.id, group: "operate" }] }, 'registerWebModule(demo): page "page:demo/overview" has more than one nav entry'],
      [{ pages: [], nav: [{ id: "nav:demo/overview", page: page.id, group: "health" }] }, 'registerWebModule(demo): a nav entry targets "page:demo/overview", which is not one of the module\'s pages'],
    ];
    for (const [contributes, message] of cases) {
      const components = (contributes?.pages ?? []).length > 0 ? { Page } : {};
      expect(() => registerWebModule(defineWebModule(manifest(contributes), { components }))).toThrow(message);
    }
  });

  it("registers nothing of a module it refuses, whichever part is wrong", async () => {
    const { registry, registerWebModule } = await fresh();
    registry.defineSlot({ id: "other/pills", accepts: "pill", module: "other" });
    registry.registerExtension({ id: "pill:other/taken", kind: "pill", attachTo: { slot: "other/pills" }, component: Pill });
    const page = { id: "page:demo/overview", path: "/demo", title: "Demo", component: "Page" } as const;
    const pill = { id: "pill:demo/summary", kind: "pill", attachTo: { slot: "app/topbar.status" }, component: "Pill" } as const;
    const cases: [WebModuleManifest["contributes"], Record<string, unknown>, RegExp][] = [
      // The last extension attaches to a slot of another kind.
      [{ pages: [page], slots: [{ id: "demo/cards", accepts: "widget" }], extensions: [pill, { ...pill, id: "pill:demo/misplaced", attachTo: { slot: "demo/cards" } }] }, { Page, Pill }, /accepts widget/],
      // An entity section with no title.
      [{ pages: [page], extensions: [{ id: "section:demo/host", kind: "entity-section", attachTo: { slot: "entity:host/sections" }, component: "Pill" }] }, { Page, Pill }, /entity section/],
      // An id another module already registered, and one of another module's.
      [{ pages: [page], extensions: [{ ...pill, id: "pill:demo/twice" }, { ...pill, id: "pill:demo/twice" }] }, { Page, Pill }, /duplicate extension id "pill:demo\/twice"/],
      [{ pages: [page], extensions: [{ ...pill, id: "pill:other/taken" }] }, { Page, Pill }, /must name its own module|duplicate extension id/],
      // A bad page path, and a non-finite order.
      [{ pages: [{ ...page, path: "/api/demo" }], extensions: [pill] }, { Page, Pill }, /page "page:demo\/overview"/],
      [{ pages: [page], extensions: [{ ...pill, attachTo: { slot: "app/topbar.status", order: Number.NaN } }] }, { Page, Pill }, /order/],
    ];
    // A table entry that is there but is not a component: undefined, null, a string.
    const card = { id: "card:demo/main", kind: "widget", attachTo: { slot: "demo/cards" }, component: "Card" } as const;
    for (const value of [undefined, null, "Card"]) {
      cases.push([
        { pages: [page], nav: [{ id: "nav:demo/overview", page: page.id, group: "health" }], slots: [{ id: "demo/cards", accepts: "widget" }], extensions: [pill, card] },
        { Page, Pill, Card: value },
        /registerWebModule\(demo\): component "Card" in the component table is not a component/,
      ]);
    }
    for (const [contributes, components, message] of cases) {
      expect(() => registerWebModule(defineWebModule(manifest(contributes), { components }))).toThrow(message);
      expect(registry.getAllExtensions().filter(({ module }) => module === "demo")).toEqual([]);
      expect(registry.getPages().filter(({ id }) => id.startsWith("page:demo/"))).toEqual([]);
      expect(registry.getSlot("demo/cards")).toBeUndefined();
    }
  });

  it("refuses an extension on a core slot that is not declared yet, registering nothing", async () => {
    const { registry, registerWebModule } = await fresh({ shell: false });
    expect(() => registerWebModule(defineWebModule(DEMO, { components: { Page, Pill, Card } }))).toThrowError(
      expect.objectContaining({
        code: "UNKNOWN_SLOT",
        message: 'registerWebModule(demo): extension "pill:demo/summary" attaches to core slot "app/topbar.status", which is not declared yet',
      }),
    );
    expect(registry.getAllExtensions().filter(({ module }) => module === "demo")).toEqual([]);
    expect(registry.getSlot("demo/cards")).toBeUndefined();
  });

  it("accepts an extension on another module's slot that is declared later", async () => {
    const { registry, registerWebModule } = await fresh({ shell: false });
    const early = manifest({ extensions: [{ id: "card:demo/early", kind: "widget", attachTo: { slot: "host/cards" }, component: "Card" }] });
    registerWebModule(defineWebModule(early, { components: { Card } }));
    registry.defineSlot({ id: "host/cards", accepts: "widget", module: "host" });
    expect(registry.getExtensions("host/cards").map(({ id }) => id)).toEqual(["card:demo/early"]);
  });

  it("orders the fallback nav by the nav entries' order, and leaves the routes' order alone", async () => {
    const { registry, registerWebModule } = await fresh();
    const { groupNavPages, resolveNav } = await import("../src/shell/nav.js");
    registerWebModule(defineWebModule(manifest({
      pages: [
        { id: "page:demo/a", path: "/a", title: "A", component: "Page" },
        { id: "page:demo/b", path: "/b", title: "B", component: "Page" },
      ],
      nav: [
        { id: "nav:demo/a", page: "page:demo/a", group: "health", order: 20 },
        { id: "nav:demo/b", page: "page:demo/b", group: "health", order: 10 },
      ],
    }), { components: { Page } }));

    // The manifest cannot be read: the sidebar falls back to the registered pages.
    const fallback = resolveNav({ status: "error", message: "HTTP 502" }, registry.getPages());
    expect(fallback).toEqual(groupNavPages(registry.getPages()));
    expect(fallback.map(({ id, links }) => `${id}: ${links.map(({ label }) => label).join(",")}`)).toEqual(["health: B,A"]);
    // Route precedence keeps the default order (then id).
    expect(registry.getPages().map(({ id }) => id)).toEqual(["page:demo/a", "page:demo/b"]);
    expect(registry.getExtensions("app/routes").map(({ attachTo }) => attachTo.order)).toEqual([100, 100]);
    expect(registry.getPages().map(({ navOrder }) => navOrder)).toEqual([20, 10]);
  });
});

describe("the llm-usage web half", () => {
  it("registers exactly its module's contributions, with no placement of its own", async () => {
    vi.resetModules();
    await import("../src/shell/health-header/slot.js");
    await import("../src/features/portal/index.js");
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

describe("the inventory web half", () => {
  it("registers exactly its module's contributions, with no placement of its own", async () => {
    vi.resetModules();
    await import("../src/features/hosts-and-services/index.js");
    const registry = await import("../src/registry/registry.js");
    const { INVENTORY_UI } = await import("@deck/contract/modules/inventory");
    const pages = await import("../src/features/hosts-and-services/pages.js");

    const ours = registry.getAllExtensions().filter(({ module }) => module === "inventory");
    const declared = INVENTORY_UI.contributes!;
    expect(ours.map(({ id }) => id).sort()).toEqual([...declared.pages!, ...declared.nav!].map(({ id }) => id).sort());
    expect(declared.extensions ?? []).toEqual([]);
    expect(declared.slots ?? []).toEqual([]);

    const registered = registry.getPages().filter(({ id }) => id.startsWith("page:inventory/"));
    for (const page of declared.pages!) {
      const nav = declared.nav!.find((entry) => entry.page === page.id);
      const match = registered.find(({ id }) => id === page.id)!;
      expect({ path: match.path, label: match.label, icon: match.icon }).toEqual({ path: page.path, label: page.title, icon: page.icon });
      expect(match.nav === false ? undefined : match.group).toBe(nav?.group);
      expect(match.nav !== false).toBe(nav !== undefined);
      expect(match.component).toBe(pages[page.component as keyof typeof pages]);
    }
  });
});

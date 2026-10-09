// @vitest-environment jsdom
import { defineWebModule, type ModuleManifest, type UiManifest, type WebModuleManifest } from "@deck/module-sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UiManifestState } from "../src/data/index.js";

/**
 * Runtime modules' web halves: loaded after the UI manifest, once per page load, registered
 * where the server's declarations put them, each component in an error boundary, with
 * stand-ins for pages and extensions of a module whose web half is loading, incompatible or
 * failed.
 */

/** The module as the server loaded it (its deck-module.json). */
const SERVED: ModuleManifest = {
  id: "demo",
  version: "1.0.0",
  deckApi: "^0.1",
  contributes: {
    pages: [{ id: "page:demo/main", path: "/demo", title: "Demo", component: "DemoPage" }],
    extensions: [
      { id: "pill:demo/broken", kind: "pill", attachTo: { slot: "app/topbar.status", order: 1 }, component: "BrokenPill" },
      { id: "pill:demo/fine", kind: "pill", attachTo: { slot: "app/topbar.status", order: 2 }, component: "FinePill" },
    ],
  },
};
const WEB_MANIFEST: WebModuleManifest = SERVED;

const MANIFEST: UiManifest = {
  uiApi: 1,
  brand: { title: "Lab" },
  modules: [{ id: "demo", version: "1.0.0", enabled: true, origin: "module", web: { script: "/modules/demo/web.js" } }],
  slots: [{ id: "app/topbar.status", accepts: "pill", module: "core" }],
  pages: [{ id: "page:demo/main", module: "demo", path: "/demo", title: "Demo", component: "DemoPage" }],
  disabledPages: [],
  navGroups: [],
  nav: [],
  extensions: [
    { id: "pill:demo/broken", kind: "pill", module: "demo", slot: "app/topbar.status", order: 1, component: "BrokenPill" },
    { id: "pill:demo/fine", kind: "pill", module: "demo", slot: "app/topbar.status", order: 2, component: "FinePill" },
  ],
  providers: [],
  findings: [],
};

const components = {
  DemoPage: () => createElement("p", null, "demo page body"),
  BrokenPill: () => {
    throw new Error("render boom");
  },
  FinePill: () => createElement("span", null, "fine pill"),
};

const exporting = (manifest: WebModuleManifest = WEB_MANIFEST, table: Record<string, unknown> = components) =>
  vi.fn(async () => ({ default: defineWebModule(manifest, { components: table }) }));

// A fresh registry and runtime store per test: a page load never unloads a module.
async function fresh() {
  vi.resetModules();
  const registry = await import("../src/registry/registry.js");
  const runtime = await import("../src/runtime/runtime-modules.js");
  const standIns = await import("../src/runtime/stand-ins.js");
  const { placeExtensions } = await import("../src/shell/manifest-slot.js");
  /** Load against `manifest`, with the server serving `served` as the module's deck-module.json. */
  const load = (importer: (url: string) => Promise<unknown>, manifest: UiManifest = MANIFEST, served: unknown = SERVED) =>
    runtime.loadRuntimeWebModules(manifest, { importer, fetchJson: async () => served });
  /** The top bar's status slot as the shell places it: registered extensions, else stand-ins. */
  const renderSlot = (manifest: UiManifest = MANIFEST) => {
    const state: UiManifestState = { status: "ready", manifest };
    const ids = standIns.runtimeModuleIds(state);
    const placed = placeExtensions("app/topbar.status", state, registry.getAllExtensions(), (entry) => standIns.runtimeExtensionStandIn(entry, ids));
    return render(createElement("div", null, ...placed.map((extension) => createElement(extension.component as ComponentType, { key: extension.id }))));
  };
  /** What the router renders for a page: the registered page, else its stand-in. */
  const route = (id = "page:demo/main", manifest: UiManifest = MANIFEST) => {
    const pages = registry.getPages();
    return [...pages, ...standIns.runtimePageRegistrations({ status: "ready", manifest }, pages)].find((page) => page.id === id);
  };
  return { registry, runtime, load, route, renderSlot };
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const link of document.head.querySelectorAll("link[data-deck-module]")) link.remove();
});

describe("loading a runtime module's web half", () => {
  it("registers it, with each extension in its own boundary: one that throws becomes a tile, its sibling renders", async () => {
    const { runtime, load, route, renderSlot } = await fresh();
    const importer = exporting();
    await load(importer);
    expect(importer).toHaveBeenCalledWith("/modules/demo/web.js");
    expect(runtime.getRuntimeModuleState("demo")).toBe("ready");

    renderSlot();
    expect(screen.getByText("fine pill")).toBeInTheDocument();
    expect(screen.getByText("demo: failed to load")).toBeInTheDocument();
    cleanup();

    render(createElement(route()!.component));
    expect(screen.getByText("demo page body")).toBeInTheDocument();
  });

  it("shows a page that throws as the module-failed page, not a white screen", async () => {
    const { registry, load } = await fresh();
    await load(exporting(WEB_MANIFEST, { ...components, DemoPage: components.BrokenPill }));
    const page = registry.getPages().find((candidate) => candidate.id === "page:demo/main")!;
    render(createElement(page.component));
    expect(screen.getByRole("heading", { level: 1, name: "Module failed to load" })).toBeInTheDocument();
  });

  it("stands in while loading: the page shows a loading state and the slot nothing", async () => {
    const { runtime, load, route, renderSlot } = await fresh();
    let resolve: ((value: unknown) => void) | undefined;
    const loading = load(() => new Promise((settle) => (resolve = settle)));
    expect(runtime.getRuntimeModuleState("demo")).toBe("pending");
    render(createElement(route()!.component));
    expect(screen.getByRole("status")).toHaveTextContent("Loading page…");
    cleanup();
    expect(renderSlot().container.textContent).toBe("");
    await vi.waitFor(() => expect(resolve).toBeDefined());
    resolve!({ default: defineWebModule(WEB_MANIFEST, { components }) });
    await loading;
    expect(runtime.getRuntimeModuleState("demo")).toBe("ready");
  });

  it("links the module's stylesheet before importing its script, and keeps it once ready", async () => {
    const { load } = await fresh();
    const withStyles: UiManifest = { ...MANIFEST, modules: [{ ...MANIFEST.modules[0]!, web: { script: "/modules/demo/web.js", styles: "/modules/demo/web.css" } }] };
    const importer = vi.fn(async () => {
      expect(document.head.querySelector('link[rel="stylesheet"][href="/modules/demo/web.css"]')).not.toBeNull();
      return { default: defineWebModule(WEB_MANIFEST, { components }) };
    });
    const loading = load(importer, withStyles);
    await vi.waitFor(() => expect(document.head.querySelector('link[href="/modules/demo/web.css"]')).not.toBeNull());
    expect(importer).not.toHaveBeenCalled();
    document.head.querySelector('link[href="/modules/demo/web.css"]')!.dispatchEvent(new Event("load"));
    await loading;
    expect(importer).toHaveBeenCalledOnce();
    expect(document.head.querySelector('link[data-deck-module="demo"]')).not.toBeNull();
  });
});

describe("the server's declarations place a runtime module", () => {
  it("routes a page at the server's path, whatever path the web half declares", async () => {
    const { registry, load } = await fresh();
    const elsewhere = { ...WEB_MANIFEST, contributes: { ...WEB_MANIFEST.contributes, pages: [{ id: "page:demo/main", path: "/elsewhere", title: "Elsewhere", component: "DemoPage" }] } } as WebModuleManifest;
    await load(exporting(elsewhere));
    expect(registry.getPages().map((page) => [page.id, page.path, page.label])).toEqual([["page:demo/main", "/demo", "Demo"]]);
  });

  it("attaches extensions where the UI manifest places them, and skips one an override switched off", async () => {
    const { registry, runtime, load } = await fresh();
    const moved: UiManifest = { ...MANIFEST, extensions: [{ ...MANIFEST.extensions[1]!, order: 40 }] };
    await load(exporting(), moved);
    expect(runtime.getRuntimeModuleState("demo")).toBe("ready");
    expect(registry.getAllExtensions().filter((extension) => extension.module === "demo" && extension.kind === "pill").map((extension) => [extension.id, extension.attachTo.order])).toEqual([["pill:demo/fine", 40]]);
  });

  it("fails a web half that lacks a component the server's declarations name: the page says so, never loading forever", async () => {
    const { runtime, load, route } = await fresh();
    await load(exporting(WEB_MANIFEST, { BrokenPill: components.BrokenPill, FinePill: components.FinePill }));
    expect(runtime.getRuntimeModuleState("demo")).toBe("failed");
    render(createElement(route()!.component));
    expect(screen.getByRole("alert")).toHaveTextContent("Module failed to load");
  });

  it("fails a web half that declares contributions the server's module does not have", async () => {
    const { registry, runtime, load } = await fresh();
    const extra = { ...WEB_MANIFEST, contributes: { ...WEB_MANIFEST.contributes, extensions: [...WEB_MANIFEST.contributes!.extensions!, { id: "pill:demo/extra", kind: "pill", attachTo: { slot: "app/topbar.status" }, component: "FinePill" }] } } as WebModuleManifest;
    await load(exporting(extra));
    expect(runtime.getRuntimeModuleState("demo")).toBe("failed");
    expect(registry.getAllExtensions().filter((extension) => extension.module === "demo")).toEqual([]);
    expect(String(errors.mock.calls[0]![1])).toContain("declares other extensions than the module the server loaded");
  });

  it("shows a page the module settled without as failed, not loading", async () => {
    const { load, route } = await fresh();
    await load(exporting());
    // The manifest refreshes with a page the loaded web half never registered.
    const later: UiManifest = { ...MANIFEST, pages: [...MANIFEST.pages, { id: "page:demo/new", module: "demo", path: "/demo/new", title: "New", component: "DemoPage" }] };
    render(createElement(route("page:demo/new", later)!.component));
    expect(screen.getByRole("alert")).toHaveTextContent("Module failed to load");
  });
});

describe("a runtime module whose web half cannot run", () => {
  for (const [label, manifest] of [
    ["built for another deck module API (deckApi)", { ...WEB_MANIFEST, deckApi: "^9.0" }],
    ["built for another version of the module", { ...WEB_MANIFEST, version: "2.0.0" }],
    ["built as another module", { ...WEB_MANIFEST, id: "other" }],
  ] as const) {
    it(`is incompatible when ${label}: a tile and a page say so, nothing crashes`, async () => {
      const { runtime, registry, load, route, renderSlot } = await fresh();
      await load(exporting(manifest));
      expect(runtime.getRuntimeModuleState("demo")).toBe("incompatible");
      expect(registry.getAllExtensions().filter((extension) => extension.module === "demo" || extension.module === "other")).toEqual([]);

      renderSlot();
      expect(screen.getAllByText("demo: incompatible")).toHaveLength(2);
      cleanup();
      render(createElement(route()!.component));
      expect(screen.getByRole("heading", { level: 1, name: "Demo" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Module incompatible");
      expect(errors).toHaveBeenCalledOnce();
    });
  }

  it("is incompatible when it imports a name deck does not export (a link-time SyntaxError)", async () => {
    const { runtime, load } = await fresh();
    await load(async () => Promise.reject(new SyntaxError("The requested module '@deck/sdk' does not provide an export named 'Nope'")));
    expect(runtime.getRuntimeModuleState("demo")).toBe("incompatible");
  });

  for (const [label, importer] of [
    ["its import throws", async () => Promise.reject(new TypeError("Failed to fetch dynamically imported module"))],
    ["its script does not parse", async () => Promise.reject(new SyntaxError("Unexpected token '<'"))],
    ["it exports no web module", async () => ({ default: { components } })],
  ] as const) {
    it(`has failed when ${label}: the tile says to reload, and it is not tried again`, async () => {
      const { runtime, load, route, renderSlot } = await fresh();
      const spy = vi.fn(importer);
      await load(spy);
      expect(runtime.getRuntimeModuleState("demo")).toBe("failed");
      // The manifest refreshes: the module is not loaded again in this page load.
      await load(spy);
      expect(spy).toHaveBeenCalledOnce();
      expect(errors).toHaveBeenCalledOnce();
      expect(String(errors.mock.calls[0]![0])).toContain('runtime module "demo" failed to load');

      renderSlot();
      expect(screen.getAllByText("demo: failed to load")).toHaveLength(2);
      cleanup();
      render(createElement(route()!.component));
      expect(screen.getByRole("alert")).toHaveTextContent(/Reload this page to try again/);
    });
  }

  it("removes its stylesheet when it ends incompatible or failed", async () => {
    const { load } = await fresh();
    const withStyles: UiManifest = { ...MANIFEST, modules: [{ ...MANIFEST.modules[0]!, web: { script: "/modules/demo/web.js", styles: "/modules/demo/web.css" } }] };
    const loading = load(exporting({ ...WEB_MANIFEST, deckApi: "^9.0" }), withStyles);
    await vi.waitFor(() => expect(document.head.querySelector('link[data-deck-module="demo"]')).not.toBeNull());
    document.head.querySelector('link[data-deck-module="demo"]')!.dispatchEvent(new Event("load"));
    await loading;
    expect(document.head.querySelector('link[data-deck-module="demo"]')).toBeNull();
  });

  it("is not loaded, and has no stand-ins, when the manifest offers no usable web half or the module is off", async () => {
    const { load, route } = await fresh();
    const importer = exporting();
    for (const module of [
      { ...MANIFEST.modules[0]!, web: undefined },
      { ...MANIFEST.modules[0]!, enabled: false },
      { ...MANIFEST.modules[0]!, web: { script: "https://evil.example/web.js" } },
      { ...MANIFEST.modules[0]!, web: { script: "/modules/other/web.js" } },
    ]) {
      const manifest = { ...MANIFEST, modules: [module] } as UiManifest;
      await load(importer, manifest);
      // The loader and the stand-ins agree: no endless "Loading" for a module never loaded.
      expect(route("page:demo/main", manifest)).toBeUndefined();
    }
    expect(importer).not.toHaveBeenCalled();
  });
});

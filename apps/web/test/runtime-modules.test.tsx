// @vitest-environment jsdom
import { defineWebModule, type UiManifest, type WebModuleManifest } from "@deck/module-sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UiManifestState } from "../src/data/index.js";

/**
 * Runtime modules' web halves: loaded after the UI manifest, once per page load, each
 * component in an error boundary, with stand-ins for pages and extensions of a module whose
 * web half is loading, incompatible or failed.
 */

const WEB_MANIFEST: WebModuleManifest = {
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
const READY: UiManifestState = { status: "ready", manifest: MANIFEST };

const components = {
  DemoPage: () => createElement("p", null, "demo page body"),
  BrokenPill: () => {
    throw new Error("render boom");
  },
  FinePill: () => createElement("span", null, "fine pill"),
};

const exporting = (manifest: WebModuleManifest = WEB_MANIFEST) => vi.fn(async () => ({ default: defineWebModule(manifest, { components }) }));

// A fresh registry and runtime store per test: a page load never unloads a module.
async function fresh() {
  vi.resetModules();
  const registry = await import("../src/registry/registry.js");
  const runtime = await import("../src/runtime/runtime-modules.js");
  const standIns = await import("../src/runtime/stand-ins.js");
  const { placeExtensions } = await import("../src/shell/manifest-slot.js");
  /** The top bar's status slot as the shell places it: registered extensions, else stand-ins. */
  const renderSlot = () => {
    const ids = standIns.runtimeModuleIds(READY);
    const placed = placeExtensions("app/topbar.status", READY, registry.getAllExtensions(), (entry) => standIns.runtimeExtensionStandIn(entry, ids));
    return render(createElement("div", null, ...placed.map((extension) => createElement(extension.component as ComponentType, { key: extension.id }))));
  };
  /** The route `/demo` renders: the registered page, else its stand-in. */
  const demoRoute = () => {
    const pages = registry.getPages();
    return [...pages, ...standIns.runtimePageRegistrations(READY, pages)].find((page) => page.id === "page:demo/main")!;
  };
  return { registry, runtime, demoRoute, renderSlot };
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("loading a runtime module's web half", () => {
  it("registers it, with each extension in its own boundary: one that throws becomes a tile, its sibling renders", async () => {
    const { runtime, demoRoute, renderSlot } = await fresh();
    const importer = exporting();
    await runtime.loadRuntimeWebModules(MANIFEST, importer);
    expect(importer).toHaveBeenCalledWith("/modules/demo/web.js");
    expect(runtime.getRuntimeModuleState("demo")).toBe("ready");

    renderSlot();
    expect(screen.getByText("fine pill")).toBeInTheDocument();
    expect(screen.getByText("demo: failed to load")).toBeInTheDocument();
    cleanup();

    render(createElement(demoRoute().component));
    expect(screen.getByText("demo page body")).toBeInTheDocument();
  });

  it("shows a page that throws as the module-failed page, not a white screen", async () => {
    const { runtime, registry } = await fresh();
    const throwing = { ...components, DemoPage: components.BrokenPill };
    await runtime.loadRuntimeWebModules(MANIFEST, async () => ({ default: defineWebModule(WEB_MANIFEST, { components: throwing }) }));
    const page = registry.getPages().find((candidate) => candidate.id === "page:demo/main")!;
    render(createElement(page.component));
    expect(screen.getByRole("heading", { level: 1, name: "Module failed to load" })).toBeInTheDocument();
  });

  it("stands in while loading: the page shows a loading state and the slot nothing", async () => {
    const { runtime, demoRoute, renderSlot } = await fresh();
    let resolve!: (value: unknown) => void;
    const loading = runtime.loadRuntimeWebModules(MANIFEST, () => new Promise((settle) => (resolve = settle)));
    expect(runtime.getRuntimeModuleState("demo")).toBe("pending");
    render(createElement(demoRoute().component));
    expect(screen.getByRole("status")).toHaveTextContent("Loading page…");
    cleanup();
    expect(renderSlot().container.textContent).toBe("");
    resolve({ default: defineWebModule(WEB_MANIFEST, { components }) });
    await loading;
    expect(runtime.getRuntimeModuleState("demo")).toBe("ready");
  });

  it("links the module's stylesheet before importing its script", async () => {
    const { runtime } = await fresh();
    const withStyles: UiManifest = { ...MANIFEST, modules: [{ ...MANIFEST.modules[0]!, web: { script: "/modules/demo/web.js", styles: "/modules/demo/web.css" } }] };
    const importer = vi.fn(async () => {
      expect(document.head.querySelector('link[rel="stylesheet"][href="/modules/demo/web.css"]')).not.toBeNull();
      return { default: defineWebModule(WEB_MANIFEST, { components }) };
    });
    const loading = runtime.loadRuntimeWebModules(withStyles, importer);
    await vi.waitFor(() => expect(document.head.querySelector('link[href="/modules/demo/web.css"]')).not.toBeNull());
    expect(importer).not.toHaveBeenCalled();
    document.head.querySelector('link[href="/modules/demo/web.css"]')!.dispatchEvent(new Event("load"));
    await loading;
    expect(importer).toHaveBeenCalledOnce();
  });
});

describe("a runtime module whose web half cannot run", () => {
  for (const [label, manifest] of [
    ["built for another deck module API (deckApi)", { ...WEB_MANIFEST, deckApi: "^9.0" }],
    ["built for another version of the module", { ...WEB_MANIFEST, version: "2.0.0" }],
    ["built as another module", { ...WEB_MANIFEST, id: "other" }],
  ] as const) {
    it(`is incompatible when ${label}: a tile and a page say so, nothing crashes`, async () => {
      const { runtime, registry, demoRoute, renderSlot } = await fresh();
      await runtime.loadRuntimeWebModules(MANIFEST, exporting(manifest));
      expect(runtime.getRuntimeModuleState("demo")).toBe("incompatible");
      // Nothing of it registered.
      expect(registry.getAllExtensions().filter((extension) => extension.module === "demo" || extension.module === "other")).toEqual([]);

      renderSlot();
      expect(screen.getAllByText("demo: incompatible")).toHaveLength(2);
      cleanup();
      render(createElement(demoRoute().component));
      expect(screen.getByRole("heading", { level: 1, name: "Demo" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Module incompatible");
      expect(errors).toHaveBeenCalledOnce();
    });
  }

  for (const [label, importer] of [
    ["its import throws", async () => Promise.reject(new TypeError("Failed to fetch dynamically imported module"))],
    ["it exports no web module", async () => ({ default: { components } })],
    ["the registry refuses it", async () => ({ default: defineWebModule(WEB_MANIFEST, { components: { DemoPage: components.DemoPage } }) })],
  ] as const) {
    it(`has failed when ${label}: the tile says to reload, and it is not tried again`, async () => {
      const { runtime, demoRoute, renderSlot } = await fresh();
      const spy = vi.fn(importer);
      await runtime.loadRuntimeWebModules(MANIFEST, spy);
      expect(runtime.getRuntimeModuleState("demo")).toBe("failed");
      // The manifest refreshes: the module is not loaded again in this page load.
      await runtime.loadRuntimeWebModules(MANIFEST, spy);
      expect(spy).toHaveBeenCalledOnce();
      expect(errors).toHaveBeenCalledOnce();
      expect(String(errors.mock.calls[0]![0])).toContain('runtime module "demo" failed to load');

      renderSlot();
      expect(screen.getAllByText("demo: failed to load")).toHaveLength(2);
      cleanup();
      render(createElement(demoRoute().component));
      expect(screen.getByRole("alert")).toHaveTextContent(/Reload this page to try again/);
    });
  }

  it("is not loaded at all when the manifest offers no web half, or the module is off", async () => {
    const { runtime } = await fresh();
    const importer = exporting();
    await runtime.loadRuntimeWebModules({ ...MANIFEST, modules: [{ ...MANIFEST.modules[0]!, web: undefined } as never] }, importer);
    await runtime.loadRuntimeWebModules({ ...MANIFEST, modules: [{ ...MANIFEST.modules[0]!, enabled: false }] }, importer);
    await runtime.loadRuntimeWebModules({ ...MANIFEST, modules: [{ ...MANIFEST.modules[0]!, web: { script: "https://evil.example/web.js" } }] }, importer);
    expect(importer).not.toHaveBeenCalled();
  });
});

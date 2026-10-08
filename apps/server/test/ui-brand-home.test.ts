/**
 * The `ui` config section through the UI manifest: the brand, the home page, and the
 * `ui.extensions` overrides reaching `GET /api/ui` from a real config overlay.
 */

import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { DEFAULT_UI } from "../src/ui/defaults.js";
import { KERNEL_FEATURES } from "../src/ui/kernel-features.js";
import { resolveUiManifest, uiConfigOf, type ResolveUiInput } from "../src/ui/resolve.js";
import { capture, createdApps, layersDir, SETTLE_TIMEOUT_MS } from "./parity/harness.js";

vi.setConfig({ testTimeout: SETTLE_TIMEOUT_MS * 3 });

vi.mock("../src/server/app.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/app.js")>();
  return {
    ...original,
    createApp: (deps: Parameters<typeof original.createApp>[0]): Hono => {
      const app = original.createApp(deps);
      createdApps.push(app);
      return app;
    },
  };
});

const kernel = (ui: ResolveUiInput["ui"] = DEFAULT_UI, extra: Partial<ResolveUiInput> = {}): ResolveUiInput => ({
  modules: BUILTIN_MODULES.map((module) => ({ manifest: module.manifest, enabled: true, builtin: true })),
  kernelFeatures: KERNEL_FEATURES,
  capabilities: { actions: true },
  ui,
  ...extra,
});
const withUi = (ui: unknown) => uiConfigOf({ ui });
const findings = (manifest: ReturnType<typeof resolveUiManifest>) => manifest.findings.map((f) => `${f.code} ${f.id ?? f.slot}`);

describe("brand", () => {
  it("takes the configured title, else the estate's name, else deck's", () => {
    expect(resolveUiManifest(kernel(withUi({ brand: { title: "Gentry Lab" } }), { estateName: "estate" })).brand).toEqual({ title: "Gentry Lab" });
    expect(resolveUiManifest(kernel(withUi({ brand: { icon: "server" } }), { estateName: " estate " })).brand).toEqual({ title: "estate", icon: "server" });
    expect(resolveUiManifest(kernel(withUi({}))).brand).toEqual({ title: "Deck" });
  });

  it("passes the icon and logo through", () => {
    const brand = { title: "Lab", icon: "server", logoUrl: "https://lab.example/logo.svg" };
    expect(resolveUiManifest(kernel(withUi({ brand }))).brand).toEqual(brand);
  });

  it("reads only the brand and home fields of the ui config, and only strings", () => {
    expect(uiConfigOf({ ui: { brand: { title: 3, icon: "server", extra: "x" }, home: 1 } })).toEqual({ ...DEFAULT_UI, brand: { icon: "server" } });
    expect(uiConfigOf(null)).toEqual({ ...DEFAULT_UI, brand: {} });
  });
});

describe("home", () => {
  it("is the portal by default, which is routed at /portal (no built-in page declares /)", () => {
    const ui = resolveUiManifest(kernel());
    expect(ui.home).toEqual({ page: "page:portal/overview", path: "/portal" });
    expect(ui.pages.filter((page) => page.path === "/")).toEqual([]);
    expect(ui.findings).toEqual([]);
  });

  it("can be any routed page with no path parameters", () => {
    const ui = resolveUiManifest(kernel(withUi({ home: "page:inventory/hosts" })));
    expect(ui.home).toEqual({ page: "page:inventory/hosts", path: "/hosts" });
    // The portal is still routed at its own path.
    expect(ui.pages.find((page) => page.id === "page:portal/overview")?.path).toBe("/portal");
    expect(ui.findings).toEqual([]);
  });

  it.each([
    ["an unknown page", "page:nope/overview", {}, "UI_HOME_UNKNOWN"],
    ["a page an override switches off", "page:inventory/hosts", { overrides: { "page:inventory/hosts": false } }, "UI_HOME_DISABLED"],
    ["a page with path parameters", "page:inventory/host-detail", {}, "UI_HOME_NOT_ROUTABLE"],
  ])("falls back to the default for %s, with a finding", (_name, home, extra, code) => {
    const ui = resolveUiManifest(kernel(withUi({ home }), extra));
    expect(ui.home).toEqual({ page: "page:portal/overview", path: "/portal" });
    expect(findings(ui)).toEqual([`${code} ${home}`]);
  });

  it("says why a configured home page is not routed", () => {
    const off = resolveUiManifest(kernel(withUi({ home: "page:inventory/hosts" }), { overrides: { "page:inventory/hosts": false } }));
    expect(off.findings[0]?.message).toBe('home page "page:inventory/hosts" is not routed: a ui.extensions override switches it off; "/" renders "page:portal/overview" instead');
  });

  it("falls back for a page of a module that is off", () => {
    const input = kernel(withUi({ home: "page:actions/overview" }));
    const modules = input.modules.map((module) => (module.manifest.id === "actions" ? { ...module, enabled: false } : module));
    const ui = resolveUiManifest({ ...input, modules });
    expect(ui.home?.page).toBe("page:portal/overview");
    expect(findings(ui)).toEqual(["UI_HOME_DISABLED page:actions/overview"]);
    expect(ui.findings[0]?.message).toContain('is not routed: its module "actions" is off');
  });

  it("is null (not absent, which means an older server) when no page can be home", () => {
    const ui = resolveUiManifest(kernel(DEFAULT_UI, { overrides: { "page:portal/overview": false } }));
    expect(ui.home).toBeNull();
    const configured = resolveUiManifest(kernel(withUi({ home: "page:nope/overview" }), { overrides: { "page:portal/overview": false } }));
    expect(configured.home).toBeNull();
    expect(configured.findings.map((f) => f.message)).toEqual(['home page "page:nope/overview" names no known page; nothing renders at "/"']);
  });

  it("owns /: a page declaring it is not routed, with a finding", () => {
    const squatter = { id: "squat", version: "1.0.0", deckApi: "^0.1", contributes: { pages: [{ id: "page:squat/home" as const, path: "/", title: "Squat", component: "S" }] } };
    const input = kernel();
    const on = resolveUiManifest({ ...input, modules: [...input.modules, { manifest: squatter, enabled: true }] });
    expect(on.pages.map((page) => page.id)).not.toContain("page:squat/home");
    expect(findings(on)).toEqual(["UI_PAGE_PATH_COLLISION page:squat/home"]);
    expect(on.home?.page).toBe("page:portal/overview");
    // Off, it is not offered as a disabled page on / either.
    const off = resolveUiManifest({ ...input, modules: [...input.modules, { manifest: squatter, enabled: false }] });
    expect(off.disabledPages?.map((page) => page.path)).not.toContain("/");
  });
});

describe("ui config through GET /api/ui", () => {
  const base = { schemaVersion: 2, estate: { name: "ui-estate" } };

  async function uiFor(overlay: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const layers = layersDir({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, ui: overlay } });
    let result = { status: 0, body: {} as Record<string, unknown> };
    try {
      await capture({ id: "ui", dir: layers.dir }, {
        onApp: async (app) => {
          const response = await app.request("/api/ui");
          result = { status: response.status, body: (await response.json()) as Record<string, unknown> };
        },
      });
    } finally {
      layers.cleanup();
    }
    return result;
  }

  it("applies the overlay's brand, home and extension overrides; an unknown id is the resolver's finding", async () => {
    const { status, body } = await uiFor({
      brand: { title: "Gentry Lab", icon: "server" },
      home: "page:inventory/hosts",
      extensions: { "pill:portal/endpoints": false, "pill:nope/missing": false },
    });
    expect(status).toBe(200);
    expect(body.brand).toEqual({ title: "Gentry Lab", icon: "server" });
    expect(body.home).toEqual({ page: "page:inventory/hosts", path: "/hosts" });
    const extensions = body.extensions as { id: string }[];
    expect(extensions.map((extension) => extension.id)).not.toContain("pill:portal/endpoints");
    expect(extensions.map((extension) => extension.id)).toContain("pill:drift/summary");
    expect(body.findings).toEqual([
      { code: "UI_UNKNOWN_EXTENSION", severity: "warning", message: 'override "pill:nope/missing" names no known extension, page or nav entry', id: "pill:nope/missing" },
    ]);
  });
});

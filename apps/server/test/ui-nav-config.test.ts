/**
 * `ui.nav` and the `ui.extensions` overrides through the UI manifest: group order, headings
 * and icons, the config's own nav entries (links and separators), and disabling, re-ordering
 * and re-attaching built-ins by id (including moving a nav entry to another group).
 */

import type { UiManifest } from "@deck/module-sdk";
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

/** The built-ins (every module on) with a `ui` config section and overrides. */
const resolveWith = (ui: unknown, overrides: Record<string, unknown> = {}): UiManifest =>
  resolveUiManifest({
    modules: BUILTIN_MODULES.map((module) => ({ manifest: module.manifest, enabled: true, builtin: true })),
    kernelFeatures: KERNEL_FEATURES,
    capabilities: { actions: true },
    ui: uiConfigOf({ ui }),
    overrides,
  } satisfies ResolveUiInput);
const groupIds = (manifest: UiManifest) => manifest.navGroups.map((group) => group.id);
const navOf = (manifest: UiManifest, id: string) => manifest.nav.find((item) => item.id === id);

const GRAFANA = { id: "nav:ui/grafana", group: "lab", label: "Grafana", href: "https://grafana.example.net", icon: "gauge" };

describe("ui.nav groups", () => {
  it("with no nav config, the built-in groups in their default order", () => {
    expect(resolveWith({}).navGroups).toEqual(DEFAULT_UI.nav.groups);
  });

  it("puts the listed groups first, relabelled and with icons; the unlisted built-ins keep their order", () => {
    const ui = resolveWith({ nav: { groups: [{ id: "health", label: "Monitoring", icon: "activity" }, { id: "overview" }] } });
    expect(ui.navGroups).toEqual([
      { id: "health", label: "Monitoring", icon: "activity" },
      { id: "overview", label: "Overview" },
      { id: "inventory", label: "Inventory" },
      { id: "operate", label: "Operate" },
      { id: "knowledge", label: "Knowledge" },
    ]);
    // Entries follow their group.
    expect(ui.nav[0]?.group).toBe("health");
    expect(ui.findings).toEqual([]);
  });

  it("lists a config-defined group only once an entry is in it", () => {
    expect(groupIds(resolveWith({ nav: { groups: [{ id: "lab", label: "Lab", icon: "boxes" }] } }))).not.toContain("lab");
    const ui = resolveWith({ nav: { groups: [{ id: "lab", label: "Lab", icon: "boxes" }], items: [GRAFANA] } });
    expect(ui.navGroups[0]).toEqual({ id: "lab", label: "Lab", icon: "boxes" });
  });
});

describe("ui.nav items", () => {
  it("adds external links under module ui, in their group by order", () => {
    const ui = resolveWith({ nav: { items: [GRAFANA, { ...GRAFANA, id: "nav:ui/alpha", label: "Alpha", order: 1 }] } });
    expect(ui.nav.filter((item) => item.group === "lab")).toEqual([
      { id: "nav:ui/alpha", module: "ui", slot: "app/nav", href: "https://grafana.example.net", group: "lab", label: "Alpha", icon: "gauge", order: 1 },
      { id: "nav:ui/grafana", module: "ui", slot: "app/nav", href: "https://grafana.example.net", group: "lab", label: "Grafana", icon: "gauge", order: 100 },
    ]);
    // An unconfigured group follows the built-ins, headed by its id.
    expect(ui.navGroups.at(-1)).toEqual({ id: "lab", label: "lab" });
  });

  it("adds separators, with no label; a group of separators alone is not listed", () => {
    const ui = resolveWith({
      nav: { items: [{ id: "nav:ui/rule", group: "health", separator: true, order: 150 }, { id: "nav:ui/lonely", group: "empty", separator: true }] },
    });
    expect(navOf(ui, "nav:ui/rule")).toEqual({ id: "nav:ui/rule", module: "ui", slot: "app/nav", group: "health", label: "", order: 150, separator: true });
    expect(groupIds(ui)).not.toContain("empty");
  });

  it("refuses an item outside the nav:ui/ namespace: a module's nav id stays the module's", () => {
    const ui = resolveWith({ nav: { items: [{ ...GRAFANA, id: "nav:drift/x" }, { ...GRAFANA, id: "nav:drift/overview" }] } });
    expect(navOf(ui, "nav:drift/x")).toBeUndefined();
    expect(navOf(ui, "nav:drift/overview")).toMatchObject({ module: "drift", page: "page:drift/overview" });
    expect(ui.findings).toEqual([]);
  });

  it("drops entries missing what they need, and links that are not http(s)", () => {
    const config = uiConfigOf({
      ui: { nav: { items: [{ id: "nav:ui/x", group: "lab", label: "X", href: "javascript:alert(1)" }, { id: "nav:ui/y", label: "Y" }, "nope", GRAFANA] } },
    });
    expect(config.nav.items).toEqual([GRAFANA]);
  });

  it("take overrides like any nav entry", () => {
    const ui = resolveWith({ nav: { items: [GRAFANA] } }, { "nav:ui/grafana": { attachTo: { group: "overview", order: 0 } } });
    expect(navOf(ui, "nav:ui/grafana")).toMatchObject({ group: "overview", order: 0 });
    expect(resolveWith({ nav: { items: [GRAFANA] } }, { "nav:ui/grafana": false }).nav.map((item) => item.id)).not.toContain("nav:ui/grafana");
  });
});

describe("ui.extensions overrides", () => {
  it("disable a header pill by id", () => {
    const ui = resolveWith({}, { "pill:drift/summary": false });
    expect(ui.extensions.map((extension) => extension.id)).not.toContain("pill:drift/summary");
    expect(ui.extensions.map((extension) => extension.id)).toContain("pill:portal/endpoints");
  });

  it("re-order a pill by id", () => {
    const ui = resolveWith({}, { "pill:drift/summary": { attachTo: { order: 1 } } });
    const pills = ui.extensions.filter((extension) => extension.slot === "app/topbar.status").map((extension) => extension.id);
    expect(pills[0]).toBe("pill:drift/summary");
  });

  it("move a nav entry to another group (a new one), replacing its attachment: the order is the default", () => {
    const ui = resolveWith({ nav: { groups: [{ id: "overview" }, { id: "lab", label: "Lab" }] } }, { "nav:actions/overview": { attachTo: { group: "lab" } } });
    expect(navOf(ui, "nav:actions/overview")).toMatchObject({ slot: "app/nav", group: "lab", order: 100 });
    expect(groupIds(ui)).toEqual(["overview", "lab", "inventory", "health", "knowledge"]);
    expect(ui.findings).toEqual([]);
  });

  it("an attachTo without a group keeps the entry's group", () => {
    const ui = resolveWith({}, { "nav:inventory/services": { attachTo: { order: 1 } } });
    expect(navOf(ui, "nav:inventory/services")).toMatchObject({ group: "inventory", order: 1 });
    expect(ui.nav.filter((item) => item.group === "inventory").map((item) => item.id)).toEqual(["nav:inventory/services", "nav:inventory/hosts"]);
  });

  it("refuse a group for anything but a nav entry, and a malformed group", () => {
    const ui = resolveWith({}, {
      "pill:drift/summary": { attachTo: { group: "lab" } },
      "nav:drift/overview": { attachTo: { group: "Not A Group" } },
    });
    expect(ui.findings.map((finding) => finding.message)).toEqual([
      'override "nav:drift/overview" is ignored: attachTo.group must be a nav group id (lower-case letters, digits and hyphens)',
      'override "pill:drift/summary" is ignored: attachTo.group applies only to a nav entry',
    ]);
    expect(navOf(ui, "nav:drift/overview")?.group).toBe("health");
  });
});

describe("ui.nav and ui.extensions through GET /api/ui", () => {
  it("a real overlay reaches the manifest", async () => {
    const layers = layersDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "ui-estate" } },
      "10-overlay.yaml": {
        schemaVersion: 2,
        ui: {
          nav: { groups: [{ id: "lab", label: "Lab", icon: "boxes" }], items: [GRAFANA] },
          extensions: { "pill:drift/summary": false, "nav:inventory/services": { attachTo: { group: "lab", order: 10 } } },
        },
      },
    });
    let body = {} as UiManifest;
    try {
      await capture({ id: "ui-nav", dir: layers.dir }, {
        onApp: async (app) => {
          const response = await app.request("/api/ui");
          expect(response.status).toBe(200);
          body = (await response.json()) as UiManifest;
        },
      });
    } finally {
      layers.cleanup();
    }
    expect(body.navGroups[0]).toEqual({ id: "lab", label: "Lab", icon: "boxes" });
    expect(body.nav.filter((item) => item.group === "lab").map((item) => item.id)).toEqual(["nav:inventory/services", "nav:ui/grafana"]);
    expect(body.extensions.map((extension) => extension.id)).not.toContain("pill:drift/summary");
    expect(body.findings).toEqual([]);
  });

  it("a later overlay's override replaces an earlier one's attachTo and config whole", async () => {
    const layers = layersDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "ui-estate" } },
      "10-overlay.yaml": {
        schemaVersion: 2,
        ui: {
          nav: { groups: [{ id: "lab", label: "Lab" }], items: [GRAFANA] },
          extensions: {
            "nav:inventory/services": { attachTo: { group: "lab", order: 3 } },
            "nav:ui/grafana": { attachTo: { group: "overview", order: 0 } },
            "pill:drift/summary": false,
          },
        },
      },
      "20-overlay.yaml": {
        schemaVersion: 2,
        ui: { extensions: { "nav:inventory/services": { attachTo: { order: 9 } }, "nav:ui/grafana": { attachTo: { group: "health" } } } },
      },
    });
    let body = {} as UiManifest;
    try {
      await capture({ id: "ui-nav-layers", dir: layers.dir }, {
        onApp: async (app) => {
          body = (await (await app.request("/api/ui")).json()) as UiManifest;
        },
      });
    } finally {
      layers.cleanup();
    }
    // The first overlay's group (and order) do not survive the second's attachTo.
    expect(navOf(body, "nav:inventory/services")).toMatchObject({ group: "inventory", order: 9 });
    expect(navOf(body, "nav:ui/grafana")).toMatchObject({ group: "health", order: 100 });
    // A different id from the first overlay still applies.
    expect(body.extensions.map((extension) => extension.id)).not.toContain("pill:drift/summary");
    expect(body.findings).toEqual([]);
  });
});

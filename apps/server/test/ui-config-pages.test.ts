/**
 * Config pages (`ui.pages`) through the UI manifest: each is a `page:ui/<id>` page with its
 * layout (sections, columns, widgets with resolved sources), a `nav:ui/<id>` entry, and
 * widgets addressable by id; the widget types it may use; the selects the provider registry
 * evaluates into envelope projections; and the whole path through a booted deck.
 */

import type { UiManifest } from "@deck/module-sdk";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validate } from "@deck/schema";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { composeModules } from "../src/modules/config.js";
import { read, register, setProjections, stopScheduler } from "../src/providers/registry.js";
import { configPagesOf, deriveProjections } from "../src/ui/config-pages.js";
import { KERNEL_FEATURES } from "../src/ui/kernel-features.js";
import { resolveUiManifest, uiConfigOf, type ResolveUiInput } from "../src/ui/resolve.js";
import { uiContributionProblem } from "../src/ui/validate.js";
import { testModule } from "./util/modules.js";
import { capture, createdApps, layersDir, SETTLE_TIMEOUT_MS } from "./parity/harness.js";
import { makeConfigDir } from "./util/tmp-config.js";

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

const PROVIDERS = [
  { id: "ups", kind: "http-json" },
  { id: "wiki", kind: "link" },
  { id: "a-wiki", kind: "link" },
];

/** The built-ins (every module on) with a `ui` section: its pages and overrides. */
const resolveWith = (ui: Record<string, unknown>, providers = PROVIDERS): UiManifest =>
  resolveUiManifest({
    modules: BUILTIN_MODULES.map((module) => ({ manifest: module.manifest, enabled: true, builtin: true })),
    kernelFeatures: KERNEL_FEATURES,
    capabilities: { actions: true },
    providers,
    ui: uiConfigOf({ ui }),
    overrides: (ui.extensions ?? {}) as Record<string, unknown>,
    configPages: configPagesOf({ ui }),
  } satisfies ResolveUiInput);

const LAB = {
  id: "lab",
  path: "/lab",
  title: "Lab overview",
  icon: "flask-conical",
  nav: { group: "lab", order: 0 },
  sections: [
    {
      title: "Power",
      columns: 3,
      widgets: [
        { id: "load", type: "core/json", title: "UPS load", source: "ups", select: "load_pct", span: 2 },
        { type: "core/json", source: { kind: "link" }, options: { wrap: true }, rows: 2 },
      ],
    },
    { title: "Notes", widgets: [{ type: "core/json", title: "Wide", span: 3 }] },
  ],
};

const pageOf = (manifest: UiManifest, id: string) => manifest.pages.find((page) => page.id === id);
const codes = (manifest: UiManifest) => manifest.findings.map(({ code, severity, id }) => ({ code, severity, id }));

describe("config pages in the UI manifest", () => {
  it("lists a config page as page:ui/<id> with its layout, in config order", () => {
    const manifest = resolveWith({ pages: [LAB] });
    expect(pageOf(manifest, "page:ui/lab")).toEqual({
      id: "page:ui/lab",
      module: "ui",
      path: "/lab",
      title: "Lab overview",
      icon: "flask-conical",
      component: "ConfigPage",
      layout: {
        sections: [
          {
            title: "Power",
            columns: 3,
            widgets: [
              {
                id: "widget:ui/lab.load",
                type: "core/json",
                title: "UPS load",
                source: { id: "ups", kind: "http-json" },
                select: "load_pct",
                projection: "widget:ui/lab.load",
                options: {},
                span: 2,
                rows: 1,
              },
              // Positional id; a kind resolves to its first provider by id.
              { id: "widget:ui/lab.s1w2", type: "core/json", source: { id: "a-wiki", kind: "link" }, options: { wrap: true }, span: 1, rows: 2 },
            ],
          },
          // Columns default to 1, and a span is clamped to them (a finding).
          { title: "Notes", columns: 1, widgets: [{ id: "widget:ui/lab.s2w1", type: "core/json", title: "Wide", source: null, options: {}, span: 1, rows: 1 }] },
        ],
      },
    });
    expect(codes(manifest)).toEqual([{ code: "UI_WIDGET_SPAN", severity: "warning", id: "widget:ui/lab.s2w1" }]);
  });

  it("adds its nav entry, labelled by its title unless the nav sets one", () => {
    const manifest = resolveWith({ pages: [LAB, { ...LAB, id: "power", path: "/power", nav: { group: "lab", label: "UPS" } }] });
    expect(manifest.nav.filter((item) => item.module === "ui")).toEqual([
      { id: "nav:ui/lab", module: "ui", slot: "app/nav", page: "page:ui/lab", group: "lab", label: "Lab overview", icon: "flask-conical", order: 0 },
      { id: "nav:ui/power", module: "ui", slot: "app/nav", page: "page:ui/power", group: "lab", label: "UPS", icon: "flask-conical", order: 100 },
    ]);
    expect(manifest.navGroups.map((group) => group.id)).toContain("lab");
    // Without `nav`, the page is routed but has no entry.
    const quiet = resolveWith({ pages: [{ ...LAB, nav: undefined }] });
    expect(pageOf(quiet, "page:ui/lab")).toBeDefined();
    expect(quiet.nav.some((item) => item.page === "page:ui/lab")).toBe(false);
  });

  it("lists the kernel's widget types, and those of enabled modules", () => {
    expect(resolveWith({}).widgetTypes).toEqual([{ type: "core/json", module: "core" }]);
  });

  it("reports a source that names no registered provider, and leaves the widget without one", () => {
    const manifest = resolveWith({ pages: [{ ...LAB, sections: [{ title: "S", widgets: [{ id: "a", type: "core/json", source: "nope" }, { id: "b", type: "core/json", source: { kind: "gatus" } }] }] }] });
    expect(codes(manifest)).toEqual([
      { code: "UI_WIDGET_SOURCE_UNKNOWN", severity: "warning", id: "widget:ui/lab.a" },
      { code: "UI_WIDGET_SOURCE_UNKNOWN", severity: "warning", id: "widget:ui/lab.b" },
    ]);
    expect(pageOf(manifest, "page:ui/lab")?.layout?.sections[0]?.widgets.map((widget) => widget.source)).toEqual([null, null]);
  });

  it("hides a page by override, with its nav entry; a home there falls back with a reason", () => {
    const manifest = resolveWith({ pages: [LAB], home: "page:ui/lab", extensions: { "page:ui/lab": false } });
    expect(pageOf(manifest, "page:ui/lab")).toBeUndefined();
    expect(manifest.nav.some((item) => item.id === "nav:ui/lab")).toBe(false);
    expect(manifest.home).toEqual({ page: "page:portal/overview", path: "/portal" });
    expect(manifest.findings).toContainEqual(expect.objectContaining({ code: "UI_HOME_DISABLED", message: expect.stringContaining("override switches it off") }));
  });

  it("can be the home page", () => {
    expect(resolveWith({ pages: [LAB], home: "page:ui/lab" }).home).toEqual({ page: "page:ui/lab", path: "/lab" });
  });

  it("switches a widget off by id; a positional id works but is reported as fragile", () => {
    const manifest = resolveWith({ pages: [LAB], extensions: { "widget:ui/lab.load": false, "widget:ui/lab.s1w2": { enabled: false } } });
    const sections = pageOf(manifest, "page:ui/lab")?.layout?.sections ?? [];
    // The Power section lost both widgets, so it is dropped.
    expect(sections.map((section) => section.title)).toEqual(["Notes"]);
    expect(codes(manifest)).toContainEqual({ code: "UI_OVERRIDE_POSITIONAL", severity: "info", id: "widget:ui/lab.s1w2" });
    expect(codes(manifest).filter((finding) => finding.id === "widget:ui/lab.load")).toEqual([]);
  });

  it("takes only enabled in a widget override", () => {
    const manifest = resolveWith({ pages: [LAB], extensions: { "widget:ui/lab.load": { config: { title: "x" } } } });
    expect(manifest.findings).toContainEqual(expect.objectContaining({ code: "UI_INVALID_OVERRIDE", id: "widget:ui/lab.load", message: expect.stringContaining("a widget") }));
  });

  it("leaves a module's page its path, and reports the config page", () => {
    const manifest = resolveWith({ pages: [{ ...LAB, path: "/portal" }] });
    expect(pageOf(manifest, "page:ui/lab")).toBeUndefined();
    expect(pageOf(manifest, "page:portal/overview")).toBeDefined();
    expect(codes(manifest)).toContainEqual({ code: "UI_PAGE_PATH_COLLISION", severity: "warning", id: "page:ui/lab" });
  });

  it("refuses a path the server answers", () => {
    for (const path of ["/api/lab", "/metrics"]) {
      const manifest = resolveWith({ pages: [{ ...LAB, path }] });
      expect(pageOf(manifest, "page:ui/lab")).toBeUndefined();
      expect(codes(manifest)).toContainEqual({ code: "UI_INVALID_PAGE", severity: "warning", id: "page:ui/lab" });
    }
  });

  it("derives the selects the registry projects, by provider and widget id", () => {
    const selects = deriveProjections(resolveWith({ pages: [LAB] }));
    expect([...selects].map(([id, map]) => [id, [...map]])).toEqual([["ups", [["widget:ui/lab.load", "load_pct"]]]]);
  });
});

describe("a module's widget types", () => {
  const gauges = testModule({
    id: "gauges",
    contributes: {
      widgetTypes: [
        { type: "gauges/dial", component: "Dial", sources: ["http-json"], optionsSchema: { type: "object", additionalProperties: false, properties: { max: { type: "number" } } } },
      ],
    },
  });
  const context = { sectionOf: () => undefined, env: {} };
  const document = (options: unknown) => ({
    schemaVersion: 2,
    estate: { name: "x" },
    ui: { pages: [{ id: "lab", path: "/lab", title: "Lab", sections: [{ title: "S", widgets: [{ type: "gauges/dial", options }] }] }] },
  });

  it("are checked in the manifest: own namespace, an options schema, string fields", () => {
    expect(uiContributionProblem(gauges.manifest)).toBeNull();
    const bad = (widgetType: Record<string, unknown>) =>
      uiContributionProblem({ id: "gauges", version: "1", deckApi: "^0.1", contributes: { widgetTypes: [widgetType as never] } });
    expect(bad({ type: "other/dial", optionsSchema: {} })).toMatch(/gauges\/<name>/);
    expect(bad({ type: "gauges/dial" })).toMatch(/optionsSchema/);
    expect(bad({ type: "gauges/dial", optionsSchema: {}, sources: [1] })).toMatch(/sources/);
  });

  it("compose their option schemas next to the kernel's, so a bad option fails validation", () => {
    const { composed } = composeModules([...BUILTIN_MODULES, gauges], context);
    expect([...composed.widgetTypes].sort()).toEqual(["core/json", "gauges/dial"]);
    expect(validate(document({ max: 5 }), { composed }).findings).toEqual([]);
    expect(validate(document({ max: "five" }), { composed }).findings).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_INVALID", path: "/ui/pages/0/sections/0/widgets/0/options/max" }),
    );
  });

  it("of a module that is off are not applied; the widget is reported", () => {
    const off = testModule({ ...gauges.manifest, enabledBy: { env: "GAUGES_ON" } });
    const { composed } = composeModules([...BUILTIN_MODULES, off], context);
    expect(validate(document({ max: "five" }), { composed }).findings.map((finding) => finding.code)).toEqual(["UI_WIDGET_TYPE_DISABLED"]);
  });

  it("are listed in the UI manifest with their sources", () => {
    const manifest = resolveUiManifest({ modules: [{ manifest: gauges.manifest, enabled: true }], kernelFeatures: KERNEL_FEATURES });
    expect(manifest.widgetTypes).toEqual([{ type: "core/json", module: "core" }, { type: "gauges/dial", module: "gauges", sources: ["http-json"] }]);
  });

  it("from a module that takes a kernel id do not break composition", () => {
    const impostor = testModule({ id: "core", contributes: { widgetTypes: [{ type: "core/json", optionsSchema: {} }] } });
    const { composed } = composeModules([...BUILTIN_MODULES, impostor], context);
    expect([...composed.widgetTypes]).toEqual(["core/json"]);
  });
});

describe("provider envelope projections", () => {
  afterEach(() => stopScheduler());

  const feed = (data: unknown) => ({
    id: "feed",
    kind: "test-feed",
    health: async () => ({ ok: true }),
    fetch: async () => data,
  });

  it("evaluates each select over the data, isolating a failing one, and keeps a provider without selects bare", async () => {
    const handle = register(feed({ load: 42, outlets: [{ name: "nas", on: true }] }));
    expect(read("feed")?.projections).toBeUndefined();
    setProjections(new Map([["feed", new Map([["w:ok", "outlets[?on].name"], ["w:bad", "abs(load, load)"]])]]));
    // No data yet: nothing to project.
    expect(read("feed")?.projections).toEqual({});
    await handle.runNow();
    const envelope = read("feed")!;
    expect(envelope.error).toBeNull();
    expect(envelope.projections).toEqual({ "w:bad": { error: expect.stringMatching(/abs\(\)/) }, "w:ok": { value: ["nas"] } });
    // Read again: evaluated once per data, the same frozen object.
    expect(read("feed")!.projections).toBe(envelope.projections);
    // A new set re-evaluates over the retained data.
    setProjections(new Map([["feed", new Map([["w:load", "load"]])]]));
    expect(read("feed")?.projections).toEqual({ "w:load": { value: 42 } });
    setProjections(new Map());
    expect(read("feed")?.projections).toBeUndefined();
  });
});

describe("config pages through a booted deck", () => {
  const estate = (widget: Record<string, unknown>) => ({
    "00-base.yaml": {
      schemaVersion: 2,
      estate: { name: "dash-estate" },
      hosts: [{ name: "nas", kind: "vm", purpose: "Storage" }],
    },
    "10-overlay.yaml": {
      schemaVersion: 2,
      hosts: [{ name: "nas", bindings: { link: { id: "nas-wiki", href: "https://wiki.example.net/nas", label: "Wiki" } } }],
      ui: { pages: [{ id: "lab", path: "/lab", title: "Lab", nav: { group: "lab" }, sections: [{ title: "Links", columns: 2, widgets: [widget] }] }] },
    },
  });

  it("serves the page in /api/ui and the widget's projection in its provider's envelope", async () => {
    const layers = layersDir(estate({ id: "wiki", type: "core/json", title: "Wiki link", source: "nas-wiki", select: "href" }));
    let ui = {} as UiManifest;
    let envelope: { projections?: unknown; data?: unknown } = {};
    try {
      const projection = await capture({ id: "ui-config-pages", dir: layers.dir }, {
        onApp: async (app) => {
          ui = (await (await app.request("/api/ui")).json()) as UiManifest;
          envelope = (await (await app.request("/api/providers/nas-wiki")).json()) as typeof envelope;
        },
      });
      expect(projection.validate).toMatchObject({ exitClass: 0 });
    } finally {
      layers.cleanup();
    }
    expect(pageOf(ui, "page:ui/lab")?.layout?.sections[0]?.widgets[0]).toMatchObject({
      id: "widget:ui/lab.wiki",
      source: { id: "nas-wiki", kind: "link" },
      projection: "widget:ui/lab.wiki",
    });
    expect(ui.widgetTypes).toEqual([{ type: "core/json", module: "core" }]);
    expect(envelope.projections).toEqual({ "widget:ui/lab.wiki": { value: "https://wiki.example.net/nas" } });
  });

  it("refuses to boot on a widget option its type does not accept", async () => {
    const dir = makeConfigDir(estate({ type: "core/json", source: "nas-wiki", options: { wrap: "yes" } }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      const { boot } = await import("../src/server/boot.js");
      await expect(boot({ configDir: dir.dir, port: 0 })).rejects.toThrow(/^exit:/);
      const printed = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(printed).toContain("SCHEMA_INVALID");
      expect(printed).toContain("/ui/pages/0/sections/0/widgets/0/options/wrap");
    } finally {
      vi.restoreAllMocks();
      dir.cleanup();
    }
  });

  it("refuses to boot on a select that is not JMESPath", async () => {
    const dir = makeConfigDir(estate({ type: "core/json", source: "nas-wiki", select: "href[" }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      const { boot } = await import("../src/server/boot.js");
      await expect(boot({ configDir: dir.dir, port: 0 })).rejects.toThrow(/^exit:/);
      const printed = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(printed).toContain("UI_WIDGET_SELECT_INVALID");
    } finally {
      vi.restoreAllMocks();
      dir.cleanup();
    }
  });
});

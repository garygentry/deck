/**
 * Config pages (`ui.pages`) through the UI manifest: each is a `page:ui/<id>` page with its
 * layout (sections, columns, widgets with resolved sources), a `nav:ui/<id>` entry, and
 * widgets addressable by id; the widget types it may use; the selects the provider registry
 * evaluates into envelope projections; and the whole path through a booted deck.
 */

import type { UiManifest, UiWidgetSection } from "@deck/module-sdk";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_CONTRIBUTIONS, composeDefault, validate } from "@deck/schema";
import { CORE_WIDGET_TYPES } from "@deck/contract/modules/core";
import { compileSelect } from "@deck/schema/select";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { composeModules } from "../src/modules/config.js";
import { read, register, setProjections, stopScheduler } from "../src/providers/registry.js";
import { configPagesOf, deriveProjections } from "../src/ui/config-pages.js";
import { KERNEL_FEATURES } from "../src/ui/kernel-features.js";
import { resolveUiManifest, uiConfigOf, type ResolveUiInput } from "../src/ui/resolve.js";
import { uiContributionProblem } from "../src/ui/validate.js";
import { testHost, testModule } from "./util/modules.js";
import { buildUiManifest } from "../src/ui/manifest.js";
import { load } from "../src/config/load.js";
import { capture, captureValidate, createdApps, layersDir, SETTLE_TIMEOUT_MS } from "./parity/harness.js";
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
  icon: "gauge",
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

/** The kernel's widget types as the manifest lists them, and their names. */
const CORE_TYPE_NAMES = CORE_WIDGET_TYPES.map(({ type }) => type as string);
const CORE_TYPES = [...CORE_TYPE_NAMES].sort().map((type) => ({ type, module: "core" }));
/** The built-in modules' own widget types (the portal's groups), after the kernel's. */
const BUILTIN_TYPE_NAMES = [...CORE_TYPE_NAMES, "portal/groups"];
const BUILTIN_TYPES = [...CORE_TYPES, { type: "portal/groups", module: "portal" }];

const pageOf = (manifest: UiManifest, id: string) => manifest.pages.find((page) => page.id === id);
/** A config page's sections, which are all widget sections. */
const sectionsOf = (manifest: UiManifest, id: string) => (pageOf(manifest, id)?.layout?.sections ?? []) as UiWidgetSection[];
const codes = (manifest: UiManifest) => manifest.findings.map(({ code, severity, id }) => ({ code, severity, id }));

describe("config pages in the UI manifest", () => {
  it("lists a config page as page:ui/<id> with its layout, in config order", () => {
    const manifest = resolveWith({ pages: [LAB] });
    expect(pageOf(manifest, "page:ui/lab")).toEqual({
      id: "page:ui/lab",
      module: "ui",
      path: "/lab",
      title: "Lab overview",
      icon: "gauge",
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
      { id: "nav:ui/lab", module: "ui", slot: "app/nav", page: "page:ui/lab", group: "lab", label: "Lab overview", icon: "gauge", order: 0 },
      { id: "nav:ui/power", module: "ui", slot: "app/nav", page: "page:ui/power", group: "lab", label: "UPS", icon: "gauge", order: 100 },
    ]);
    expect(manifest.navGroups.map((group) => group.id)).toContain("lab");
    // Without `nav`, the page is routed but has no entry.
    const quiet = resolveWith({ pages: [{ ...LAB, nav: undefined }] });
    expect(pageOf(quiet, "page:ui/lab")).toBeDefined();
    expect(quiet.nav.some((item) => item.page === "page:ui/lab")).toBe(false);
  });

  it("declares the kernel's widget types once for the UI and once for validation, kept equal", () => {
    const composed = composeDefault();
    expect([...composed.widgetTypes]).toEqual(CORE_WIDGET_TYPES.map(({ type }) => type));
    const core = BUILTIN_CONTRIBUTIONS.find((contribution) => contribution.id === "core");
    expect(core?.widgetTypes).toEqual(CORE_WIDGET_TYPES.map(({ type, optionsSchema }) => ({ type, optionsSchema })));
  });

  it("lists the kernel's widget types, and those of enabled modules", () => {
    expect(resolveWith({}).widgetTypes).toEqual(BUILTIN_TYPES);
  });

  it("reports a source that names no registered provider, and leaves the widget without one", () => {
    const manifest = resolveWith({ pages: [{ ...LAB, sections: [{ title: "S", widgets: [{ id: "a", type: "core/json", source: "nope" }, { id: "b", type: "core/json", source: { kind: "gatus" } }] }] }] });
    expect(codes(manifest)).toEqual([
      { code: "UI_WIDGET_SOURCE_UNKNOWN", severity: "warning", id: "widget:ui/lab.a" },
      { code: "UI_WIDGET_SOURCE_UNKNOWN", severity: "warning", id: "widget:ui/lab.b" },
    ]);
    expect(sectionsOf(manifest, "page:ui/lab")[0]?.widgets.map(({ source, sourceProblem }) => ({ source, sourceProblem }))).toEqual([
      { source: null, sourceProblem: 'It reads provider "nope", which is not configured.' },
      { source: null, sourceProblem: 'It reads a provider of kind "gatus", which is not configured.' },
    ]);
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
    const sections = sectionsOf(manifest, "page:ui/lab");
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

  it("derives the selects the registry projects, compiled, by provider and widget id", () => {
    const selects = deriveProjections(resolveWith({ pages: [LAB] }));
    expect([...selects].map(([id, map]) => [id, [...map].map(([name, select]) => [name, select.expression, select.problem])])).toEqual([
      ["ups", [["widget:ui/lab.load", "load_pct", undefined]]],
    ]);
  });

  it("marks a widget of a type no enabled module provides as unavailable, reading and projecting nothing", () => {
    const manifest = resolveWith({ pages: [{ ...LAB, sections: [{ title: "S", widgets: [{ id: "off", type: "gauges/dial", source: "ups", select: "load" }, { id: "on", type: "core/json", source: "ups", select: "load" }] }] }] });
    const [off, on] = sectionsOf(manifest, "page:ui/lab")[0]?.widgets ?? [];
    expect(off).toEqual({
      id: "widget:ui/lab.off",
      type: "gauges/dial",
      source: null,
      typeProblem: 'No enabled module provides the widget type "gauges/dial".',
      options: {},
      span: 1,
      rows: 1,
    });
    expect(on).toMatchObject({ source: { id: "ups" }, projection: "widget:ui/lab.on" });
    expect([...deriveProjections(manifest).get("ups")!.keys()]).toEqual(["widget:ui/lab.on"]);
  });

  it("keeps explicit and positional widgets apart: their own projections and overrides", () => {
    const ui = { pages: [{ ...LAB, sections: [{ title: "S", widgets: [{ id: "w2", type: "core/json", source: "ups", select: "a" }, { type: "core/json", source: "ups", select: "b" }] }] }] };
    const manifest = resolveWith({ ...ui, extensions: { "widget:ui/lab.s1w2": false } });
    expect(sectionsOf(manifest, "page:ui/lab")[0]?.widgets.map((widget) => widget.id)).toEqual(["widget:ui/lab.w2"]);
    const both = deriveProjections(resolveWith(ui)).get("ups")!;
    expect([...both].map(([name, select]) => [name, select.expression])).toEqual([["widget:ui/lab.w2", "a"], ["widget:ui/lab.s1w2", "b"]]);
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
    expect([...composed.widgetTypes].sort()).toEqual([...BUILTIN_TYPE_NAMES, "gauges/dial"].sort());
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
    expect(manifest.widgetTypes).toEqual([...CORE_TYPES, { type: "gauges/dial", module: "gauges", sources: ["http-json"] }]);
  });

  it("refuse a source of a kind they do not render", () => {
    const manifest = resolveUiManifest({
      modules: [{ manifest: gauges.manifest, enabled: true }],
      kernelFeatures: KERNEL_FEATURES,
      providers: PROVIDERS,
      configPages: configPagesOf({ ui: { pages: [{ ...LAB, sections: [{ title: "S", widgets: [{ id: "a", type: "gauges/dial", source: "wiki" }, { id: "b", type: "gauges/dial", source: "ups" }] }] }] } }),
    });
    const widgets = sectionsOf(manifest, "page:ui/lab")[0]?.widgets ?? [];
    expect(widgets.map(({ source, sourceProblem }) => ({ source, sourceProblem }))).toEqual([
      { source: null, sourceProblem: 'It cannot render provider "wiki" (kind link).' },
      { source: { id: "ups", kind: "http-json" }, sourceProblem: undefined },
    ]);
    expect(codes(manifest)).toContainEqual({ code: "UI_WIDGET_SOURCE_KIND", severity: "warning", id: "widget:ui/lab.a" });
  });

  it("listed twice by one module disable that module, never boot", () => {
    const twice = testModule({
      id: "gauges",
      contributes: { widgetTypes: [{ type: "gauges/dial", optionsSchema: {} }, { type: "gauges/dial", optionsSchema: {} }] },
    });
    const { composed, invalid } = composeModules([...BUILTIN_MODULES, twice], context);
    expect(invalid.get("gauges")).toMatch(/declared twice/);
    expect(composed.widgetTypes.has("gauges/dial")).toBe(false);
    const { host } = testHost([twice]);
    expect(host.plan).toContainEqual(expect.objectContaining({ id: "gauges", enabled: false, reason: expect.stringContaining("listed twice") }));
  });

  it("from a module that takes a kernel id do not break composition", () => {
    const impostor = testModule({ id: "core", contributes: { widgetTypes: [{ type: "core/json", optionsSchema: {} }] } });
    const { composed } = composeModules([...BUILTIN_MODULES, impostor], context);
    expect([...composed.widgetTypes].sort()).toEqual([...BUILTIN_TYPE_NAMES].sort());
  });
});

describe("status maps in the UI manifest", () => {
  const MAPS = {
    outlet: { values: { on: "ok", off: "neutral" } },
    "ups-load": { rules: [{ lt: 60, tone: "ok" }, { tone: "danger" }] },
  };

  it("publishes ui.statusMaps by name, copied", () => {
    const ui = { statusMaps: MAPS };
    const manifest = resolveWith(ui);
    expect(manifest.statusMaps).toEqual(MAPS);
    expect(Object.keys(manifest.statusMaps ?? {})).toEqual(["outlet", "ups-load"]);
    expect(manifest.statusMaps?.outlet).not.toBe(MAPS.outlet);
  });

  it("leaves the field out when the config declares none, so a manifest without them is unchanged", () => {
    expect("statusMaps" in resolveWith({})).toBe(false);
    expect("statusMaps" in resolveWith({ statusMaps: {} })).toBe(false);
  });

  it("reads the config leniently: malformed names, tones and conditions are dropped", () => {
    const manifest = resolveWith({
      statusMaps: {
        "Bad Name": { values: { on: "ok" } },
        mixed: { values: { on: "ok", off: "green", bad: 3 }, rules: [{ lt: 5, tone: "ok" }, { lt: "5", tone: "warn" }, { tone: "red" }, { eq: { a: 1 }, tone: "info" }, { gte: Infinity, tone: "info" }, { eq: "x", tone: "pending" }] },
        empty: { values: { on: "green" } },
        notAMap: "ok",
      },
    });
    expect(manifest.statusMaps).toEqual({
      empty: { values: {} },
      mixed: { values: { on: "ok" }, rules: [{ lt: 5, tone: "ok" }, { eq: "x", tone: "pending" }] },
    });
  });

  it("serves the overlay's maps in /api/ui beside the widgets that name them", async () => {
    const layers = layersDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "dash-estate" }, hosts: [{ name: "nas", kind: "vm", purpose: "Storage" }] },
      "10-overlay.yaml": {
        schemaVersion: 2,
        hosts: [{ name: "nas", bindings: { link: { id: "nas-wiki", href: "https://wiki.example.net/nas", label: "Wiki" } } }],
        ui: {
          statusMaps: MAPS,
          pages: [{ id: "lab", path: "/lab", title: "Lab", sections: [{ title: "S", widgets: [{ type: "core/stat", source: "nas-wiki", select: "label", options: { statusMap: "outlet" } }] }] }],
        },
      },
    });
    let ui = {} as UiManifest;
    try {
      const projection = await capture({ id: "ui-status-maps", dir: layers.dir }, {
        onApp: async (app) => {
          ui = (await (await app.request("/api/ui")).json()) as UiManifest;
        },
      });
      expect(projection.validate).toMatchObject({ exitClass: 0 });
    } finally {
      layers.cleanup();
    }
    expect(ui.statusMaps).toEqual(MAPS);
    expect(sectionsOf(ui, "page:ui/lab")[0]?.widgets[0]?.options).toEqual({ statusMap: "outlet" });
  });
});

describe("the embed gate in the UI manifest", () => {
  it("publishes allowUnsafeEmbeds only when the config sets it to true", () => {
    expect(resolveWith({ allowUnsafeEmbeds: true }).allowUnsafeEmbeds).toBe(true);
    for (const ui of [{}, { allowUnsafeEmbeds: false }, { allowUnsafeEmbeds: "true" }, { allowUnsafeEmbeds: 1 }]) {
      expect("allowUnsafeEmbeds" in resolveWith(ui)).toBe(false);
    }
  });

  it("lists core/embed among core's widget types", () => {
    expect(resolveWith({}).widgetTypes).toContainEqual({ type: "core/embed", module: "core" });
  });

  it("serves the gate and the embed's options in /api/ui, with no finding when it is open", async () => {
    const embed = { id: "graph", type: "core/embed", title: "UPS graph", options: { url: "https://grafana.example.net/d/ups", height: "lg" } };
    const layers = layersDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "embed-estate" } },
      "10-overlay.yaml": { schemaVersion: 2, ui: { allowUnsafeEmbeds: true, pages: [{ id: "lab", path: "/lab", title: "Lab", sections: [{ title: "S", widgets: [embed] }] }] } },
    });
    let ui = {} as UiManifest;
    try {
      const projection = await capture({ id: "ui-embed", dir: layers.dir }, {
        onApp: async (app) => {
          ui = (await (await app.request("/api/ui")).json()) as UiManifest;
        },
      });
      expect(projection.validate).toMatchObject({ exitClass: 0 });
    } finally {
      layers.cleanup();
    }
    expect(ui.allowUnsafeEmbeds).toBe(true);
    expect(pageOf(ui, "page:ui/lab")?.layout?.sections.flatMap((section) => ("widgets" in section ? section.widgets : []))[0]).toMatchObject({ type: "core/embed", source: null, options: embed.options });
  });

  const EMBED_PAGE = { pages: [{ id: "lab", path: "/lab", title: "Lab", sections: [{ title: "S", widgets: [{ id: "graph", type: "core/embed", options: { url: "https://grafana.example.net/d/ups" } }] }] }] };
  const codes = (findings: ReadonlyArray<{ code: string }>) => findings.filter((finding) => finding.code === "UI_EMBED_DISALLOWED");

  it("boots with an embed while the gate is shut, noting it once (UI_EMBED_DISALLOWED, info), and serves no gate", async () => {
    const layers = layersDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "embed-estate" } },
      "10-overlay.yaml": { schemaVersion: 2, ui: EMBED_PAGE },
    });
    let ui = {} as UiManifest;
    try {
      const projection = await capture({ id: "ui-embed-shut", dir: layers.dir }, {
        onApp: async (app) => {
          ui = (await (await app.request("/api/ui")).json()) as UiManifest;
        },
      });
      expect(projection.validate.exitClass).toBe(0);
      expect(projection.validate.stdout).toContain("UI_EMBED_DISALLOWED");
      const loaded = load({ arg: layers.dir, env: {}, boot: true });
      expect(loaded.exitClass).toBe(0);
      // Reported for the merged document only, not again for the overlay layer.
      expect(codes(loaded.findings)).toEqual([expect.objectContaining({ severity: "info", path: "/ui/pages/0/sections/0/widgets/0/type" })]);
    } finally {
      layers.cleanup();
    }
    expect("allowUnsafeEmbeds" in ui).toBe(false);
    expect(pageOf(ui, "page:ui/lab")?.layout?.sections.flatMap((section) => ("widgets" in section ? section.widgets : []))[0]?.type).toBe("core/embed");
  });

  it("finds nothing when the gate and the embed are in different layers", () => {
    const layers = layersDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "embed-estate" } },
      "10-o.yaml": { schemaVersion: 2, ui: { allowUnsafeEmbeds: true } },
      "20-d.yaml": { schemaVersion: 2, ui: EMBED_PAGE },
    });
    try {
      const loaded = load({ arg: layers.dir, env: {} });
      expect(loaded.exitClass).toBe(0);
      expect(codes(loaded.findings)).toEqual([]);
    } finally {
      layers.cleanup();
    }
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

  /** Compiled selects by provider id, then projection name. */
  const selects = (byProvider: Record<string, Record<string, string>>) =>
    new Map(Object.entries(byProvider).map(([id, named]) => [id, new Map(Object.entries(named).map(([name, expression]) => [name, compileSelect(expression)]))]));

  it("evaluates each select over the data, isolating a failing one, and keeps a provider without selects bare", async () => {
    const handle = register(feed({ load: 42, outlets: [{ name: "nas", on: true }] }));
    expect(read("feed")?.projections).toBeUndefined();
    setProjections(selects({ feed: { "w:ok": "outlets[?on].name", "w:bad": "abs(outlets)" } }));
    // No data yet: nothing to project.
    expect(read("feed")?.projections).toEqual({});
    await handle.runNow();
    const envelope = read("feed")!;
    expect(envelope.error).toBeNull();
    expect(envelope.projections).toEqual({ "w:bad": { error: expect.stringMatching(/abs\(\)/) }, "w:ok": { value: ["nas"] } });
    // Read again: evaluated once per data, the same frozen object.
    expect(read("feed")!.projections).toBe(envelope.projections);
    // A new set re-evaluates over the retained data.
    setProjections(selects({ feed: { "w:load": "load" } }));
    expect(read("feed")?.projections).toEqual({ "w:load": { value: 42 } });
    setProjections(new Map());
    expect(read("feed")?.projections).toBeUndefined();
  });

  it("bounds each projection: one past its limits is an error, its siblings and the provider are unaffected", async () => {
    const items = Array.from({ length: 20_000 }, (_, index) => ({ index, name: `item-${index}` }));
    const handle = register(feed({ items }));
    setProjections(selects({ feed: { "w:all": "@", "w:count": "length(items)", "w:first": "items[0].name" } }));
    await handle.runNow();
    const envelope = read("feed")!;
    expect(envelope.projections).toEqual({
      "w:all": { error: "the result has more than 10000 values" },
      "w:count": { value: 20_000 },
      "w:first": { value: "item-0" },
    });
    expect(envelope.error).toBeNull();
    expect(envelope.freshness.state).toBe("fresh");
    // The envelope stays small: the oversized projection carries no value.
    expect(JSON.stringify(envelope.projections).length).toBeLessThan(1000);
  });

  it("keeps pathological selects inside their own projection: fast, bounded, siblings and health intact", async () => {
    const wide = `[${Array.from({ length: 14 }, () => "@").join(", ")}]`;
    const chain = Array.from({ length: 7 }, () => wide).join(" | ");
    const handle = register(feed({ list: Array.from({ length: 4000 }, () => "x".repeat(1000)), n: 3, f: { type: "Field", name: "n", jmespathType: "Expref" } }));
    setProjections(selects({
      feed: {
        "w:compare": `${chain} | [0] < [1]`,
        "w:join": "join(',', list)",
        "w:forged": "map(f, list)",
        "w:ok": "n",
      },
    }));
    const started = performance.now();
    await handle.runNow();
    const envelope = read("feed")!;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(envelope.projections).toEqual({
      "w:compare": { value: null },
      "w:forged": { error: expect.stringMatching(/TypeError/) },
      "w:join": { error: "the select built more than 262144 characters of text" },
      "w:ok": { value: 3 },
    });
    expect(envelope.error).toBeNull();
    expect(envelope.freshness.state).toBe("fresh");
  });

  it("is wired by every manifest build: a rebuilt manifest replaces the selects", async () => {
    const handle = register(feed({ load: 7 }));
    await handle.runNow();
    const providers = { listProviders: () => [{ id: "feed", kind: "test-feed" }], setProjections };
    const page = (select: string) => ({ ui: { pages: [{ ...LAB, sections: [{ title: "S", widgets: [{ id: "w", type: "core/json", source: "feed", select }] }] }] } });
    buildUiManifest({ config: page("load"), providers, capabilities: {} });
    expect(read("feed")?.projections).toEqual({ "widget:ui/lab.w": { value: 7 } });
    buildUiManifest({ config: page("to_string(load)"), providers, capabilities: {} });
    expect(read("feed")?.projections).toEqual({ "widget:ui/lab.w": { value: "7" } });
    buildUiManifest({ config: {}, providers, capabilities: {} });
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
    expect(sectionsOf(ui, "page:ui/lab")[0]?.widgets[0]).toMatchObject({
      id: "widget:ui/lab.wiki",
      source: { id: "nas-wiki", kind: "link" },
      projection: "widget:ui/lab.wiki",
    });
    expect(ui.widgetTypes).toEqual(BUILTIN_TYPES);
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

  it("deck validate reports a select with an unknown function or a wrong argument count", () => {
    const dir = makeConfigDir(estate({ type: "core/json", source: "nas-wiki", select: "lenght(href)" }));
    try {
      const result = captureValidate(dir.dir);
      expect(result.exitClass).toBe(1);
      expect(result.stdout + result.stderr).toContain("UI_WIDGET_SELECT_INVALID");
      expect(result.stdout + result.stderr).toContain("unknown function lenght()");
    } finally {
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

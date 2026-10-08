import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_CONTRIBUTIONS, ComposeError, composeConfig, IDENTITY, resolveOwner, validate } from "../src/index.js";
import { evaluateSelect, selectProblem } from "../src/select.js";
import type { ConfigContribution } from "../src/types.js";

const base = { schemaVersion: 2, estate: { name: "test" } };
const withPages = (pages: unknown) => ({ ...base, ui: { pages } });
const page = (widgets: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "lab",
  path: "/lab",
  title: "Lab overview",
  sections: [{ title: "Power", columns: 3, widgets }],
  ...extra,
});

/** A module declaring a gauge whose options need a format, and a free-form note. */
const gauges: ConfigContribution = {
  id: "gauges",
  widgetTypes: [
    {
      type: "gauges/dial",
      optionsSchema: {
        type: "object",
        additionalProperties: false,
        required: ["format"],
        properties: { format: { enum: ["percent", "number"] }, max: { type: "number" } },
      },
    },
    { type: "gauges/note" },
  ],
};
const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, gauges], { selectProblem });
const check = (document: unknown, options: Parameters<typeof validate>[1] = {}) => validate(document, { composed, ...options });
const located = (result: ReturnType<typeof validate>) => result.findings.map(({ code, path, severity }) => ({ code, path, severity }));

describe("ui.pages", () => {
  it("accepts a page of sections and widgets", () => {
    const result = check(withPages([
      page([
        { id: "load", type: "gauges/dial", title: "UPS load", source: "ups", select: "load_pct", options: { format: "percent" }, span: 2, rows: 1 },
        { type: "gauges/note", source: { kind: "http-json" }, options: { anything: [1, "two"] } },
      ], { icon: "flask-conical", nav: { group: "lab", order: 0, label: "Lab" } }),
    ]));
    expect(located(result)).toEqual([]);
    expect(result.classification).toBe(0);
  });

  it.each([
    ["a page without sections", { id: "lab", path: "/lab", title: "Lab", sections: [] }, "/ui/pages/0/sections"],
    ["a dotted page id", page([{ type: "gauges/note" }], { id: "lab.one" }), "/ui/pages/0/id"],
    ["a path with a parameter", page([{ type: "gauges/note" }], { path: "/lab/:id" }), "/ui/pages/0/path"],
    ["a relative path", page([{ type: "gauges/note" }], { path: "lab" }), "/ui/pages/0/path"],
    ["a blank title", page([{ type: "gauges/note" }], { title: "  " }), "/ui/pages/0/title"],
    ["five columns", { ...page([]), sections: [{ title: "Power", columns: 5, widgets: [{ type: "gauges/note" }] }] }, "/ui/pages/0/sections/0/columns"],
    ["a section without widgets", { ...page([]), sections: [{ title: "Power", widgets: [] }] }, "/ui/pages/0/sections/0/widgets"],
    ["a span of five", page([{ type: "gauges/note", span: 5 }]), "/ui/pages/0/sections/0/widgets/0/span"],
    ["seven rows", page([{ type: "gauges/note", rows: 7 }]), "/ui/pages/0/sections/0/widgets/0/rows"],
    ["a type without a module", page([{ type: "dial" }]), "/ui/pages/0/sections/0/widgets/0/type"],
    ["a dotted widget id", page([{ id: "a.b", type: "gauges/note" }]), "/ui/pages/0/sections/0/widgets/0/id"],
    ["a source of another shape", page([{ type: "gauges/note", source: { id: "ups" } }]), "/ui/pages/0/sections/0/widgets/0/source"],
  ])("rejects %s", (_name, value, path) => {
    const result = check(withPages([value]));
    expect(result.classification).toBe(1);
    expect(result.findings.map((item) => item.path)).toContain(path);
  });

  it("rejects a section without a title (every section is a heading)", () => {
    const result = check(withPages([{ ...page([]), sections: [{ widgets: [{ type: "gauges/note" }] }] }]));
    expect(located(result)).toContainEqual({ code: "SCHEMA_REQUIRED_MISSING", path: "/ui/pages/0/sections/0/title", severity: "error" });
  });

  it("checks a widget's options against its type's schema: a bad option is an error at its path", () => {
    const bad = check(withPages([page([{ type: "gauges/dial", options: { format: "kelvin" } }])]));
    expect(bad.classification).toBe(1);
    expect(located(bad)).toContainEqual({ code: "SCHEMA_INVALID", path: "/ui/pages/0/sections/0/widgets/0/options/format", severity: "error" });
    const extra = check(withPages([page([{ type: "gauges/dial", options: { format: "percent", colour: "red" } }])]));
    expect(located(extra)).toContainEqual({ code: "SCHEMA_UNKNOWN_PROPERTY", path: "/ui/pages/0/sections/0/widgets/0/options/colour", severity: "error" });
    // A type whose options require a field needs options.
    const missing = check(withPages([page([{ type: "gauges/dial" }])]));
    expect(located(missing)).toContainEqual({ code: "SCHEMA_REQUIRED_MISSING", path: "/ui/pages/0/sections/0/widgets/0/options", severity: "error" });
    // Another type's options are not checked against this schema.
    expect(check(withPages([page([{ type: "gauges/note", options: { format: "kelvin" } }])])).classification).toBe(0);
  });

  it("reports an unknown widget type as a warning, not a shape error", () => {
    const result = check(withPages([page([{ type: "nobody/gauge", options: { format: "kelvin" } }])]));
    expect(located(result)).toEqual([{ code: "UI_WIDGET_TYPE_UNKNOWN", path: "/ui/pages/0/sections/0/widgets/0/type", severity: "warning" }]);
  });

  it("reports a disabled module's widget type at info, or as a warning when strict", () => {
    const off = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...gauges, disabled: "switched off" }], { selectProblem });
    const document = withPages([page([{ type: "gauges/dial", options: { format: "kelvin" } }])]);
    // An off module's option schema is not applied either.
    expect(located(validate(document, { composed: off }))).toEqual([
      { code: "UI_WIDGET_TYPE_DISABLED", path: "/ui/pages/0/sections/0/widgets/0/type", severity: "info" },
    ]);
    expect(located(validate(document, { composed: off, disabledSections: "strict" }))).toEqual([
      { code: "UI_WIDGET_TYPE_DISABLED", path: "/ui/pages/0/sections/0/widgets/0/type", severity: "warning" },
    ]);
  });

  it("reports a select that does not parse, when composition has the check", () => {
    const document = withPages([page([{ type: "gauges/note", source: "ups", select: "outlets[?state == 'on'" }])]);
    expect(located(check(document))).toEqual([
      { code: "UI_WIDGET_SELECT_INVALID", path: "/ui/pages/0/sections/0/widgets/0/select", severity: "error" },
    ]);
    // Without the hook (the library's default composition) select is not checked.
    const unchecked = composeConfig([...BUILTIN_CONTRIBUTIONS, gauges]);
    expect(validate(document, { composed: unchecked }).findings).toEqual([]);
    expect(located(check(withPages([page([{ type: "gauges/note", select: "outlets[?state == 'on'].name | [0]" }])])))).toEqual([]);
  });

  it("keeps page ids and a page's widget ids unique", () => {
    const pages = check(withPages([page([{ type: "gauges/note" }]), page([{ type: "gauges/note" }], { path: "/lab2" })]));
    expect(located(pages)).toContainEqual({ code: "ID_DUPLICATE", path: "/ui/pages/1", severity: "error" });
    const widgets = check(withPages([
      { ...page([]), sections: [{ title: "A", widgets: [{ id: "w", type: "gauges/note" }] }, { title: "B", widgets: [{ id: "w", type: "gauges/note" }] }] },
      page([{ id: "w", type: "gauges/note" }], { id: "other", path: "/other" }),
    ]));
    expect(located(widgets)).toEqual([{ code: "ID_DUPLICATE", path: "/ui/pages/0/sections/1/widgets/0", severity: "error" }]);
    expect(IDENTITY["ui.pages"]).toEqual(["id"]);
  });

  it("is overlay-owned", () => {
    expect(resolveOwner("ui.pages")).toBe("overlay");
    const result = check(withPages([page([{ type: "gauges/note" }])]), { layer: "base" });
    expect(located(result)).toContainEqual(expect.objectContaining({ code: "LAYER_OVERLAY_KEY_IN_BASE" }));
  });
});

describe("widget type composition", () => {
  it("refuses a type outside the contribution's namespace", () => {
    expect(() => composeConfig([{ id: "gauges", widgetTypes: [{ type: "other/dial" }] }])).toThrow(ComposeError);
    expect(() => composeConfig([{ id: "gauges", widgetTypes: [{ type: "dial" }] }])).toThrow(/gauges\/<name>/);
  });

  it("refuses a type declared twice", () => {
    const twice: ConfigContribution = { id: "gauges", widgetTypes: [{ type: "gauges/dial" }, { type: "gauges/dial" }] };
    expect(() => composeConfig([twice])).toThrow(expect.objectContaining({ code: "MODULE_MANIFEST_CONFLICT" }));
  });

  it("lists the enabled types, and an off module's separately", () => {
    const composition = composeConfig([gauges, { id: "meters", disabled: "off", widgetTypes: [{ type: "meters/bar" }] }]);
    expect([...composition.widgetTypes].sort()).toEqual(["gauges/dial", "gauges/note"]);
    expect([...composition.disabledWidgetTypes]).toEqual([["meters/bar", "meters"]]);
  });
});

describe("@deck/schema/select", () => {
  it("names a parse problem, or none", () => {
    expect(selectProblem("load_pct")).toBeNull();
    expect(selectProblem("a[")).toMatch(/./);
  });

  it("evaluates to plain JSON", () => {
    const data = { outlets: [{ name: "nas", state: "on" }, { name: "tv", state: "off" }], load: 41.5 };
    expect(evaluateSelect("outlets[?state == 'on'].name", data)).toEqual({ value: ["nas"] });
    expect(evaluateSelect("load", data)).toEqual({ value: 41.5 });
    expect(evaluateSelect("missing", data)).toEqual({ value: null });
    // Inherited properties are not data.
    expect(evaluateSelect("constructor", data)).toEqual({ value: null });
    expect(evaluateSelect("__proto__", data)).toEqual({ value: null });
    expect(evaluateSelect("{c: outlets[0].constructor}", data)).toEqual({ value: { c: null } });
  });

  it("returns a runtime error instead of throwing", () => {
    expect(evaluateSelect("abs(load, load)", { load: 1 })).toEqual({ error: expect.stringMatching(/abs\(\)/) });
  });

  it("is the only module that loads the engine, and the main entry does not reach it", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts")).map((file) => join(src, file));
    const importers = files.filter((file) => /from\s+["']jmespath["']/.test(readFileSync(file, "utf8")));
    expect(importers.map((file) => relative(src, file))).toEqual(["select.ts"]);
    const selectImporters = files.filter((file) => /from\s+["'][./]*select\.js["']/.test(readFileSync(file, "utf8")));
    expect(selectImporters).toEqual([]);
  });
});

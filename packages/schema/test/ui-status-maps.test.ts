import { describe, expect, it } from "vitest";
import { BUILTIN_CONTRIBUTIONS, composeDefault, validate } from "../src/index.js";
import { CORE_WIDGET_TYPE_SCHEMAS } from "../src/core-widgets.js";

const base = { schemaVersion: 2, estate: { name: "test" } };
const dashboard = (widgets: unknown[], ui: Record<string, unknown> = {}) => ({
  ...base,
  ui: { pages: [{ id: "lab", path: "/lab", title: "Lab", sections: [{ title: "Power", columns: 3, widgets }] }], ...ui },
});
const located = (result: ReturnType<typeof validate>) => result.findings.map(({ code, path, severity }) => ({ code, path, severity }));

const STATUS_MAPS = {
  "ups-load": { rules: [{ lt: 60, tone: "ok" }, { lt: 85, tone: "warn" }, { tone: "danger" }] },
  outlet: { values: { on: "ok", off: "neutral", fault: "danger" } },
};

describe("ui.statusMaps", () => {
  it("accepts value maps and threshold rules over the six tones", () => {
    const result = validate({ ...base, ui: { statusMaps: { ...STATUS_MAPS, any: { values: { "404": "warn" }, rules: [{ gte: 1, lte: 2, eq: 1, tone: "info" }, { eq: "x", tone: "pending" }, { eq: true, tone: "neutral" }] } } } });
    expect(located(result)).toEqual([]);
  });

  it.each([
    ["an unknown tone in values", { a: { values: { on: "green" } } }, "/ui/statusMaps/a/values/on"],
    ["an unknown tone in a rule", { a: { rules: [{ lt: 1, tone: "red" }] } }, "/ui/statusMaps/a/rules/0/tone"],
    ["a rule without a tone", { a: { rules: [{ lt: 1 }] } }, "/ui/statusMaps/a/rules/0/tone"],
    ["a text bound", { a: { rules: [{ lt: "5", tone: "ok" }] } }, "/ui/statusMaps/a/rules/0/lt"],
    ["an unknown rule key", { a: { rules: [{ below: 5, tone: "ok" }] } }, "/ui/statusMaps/a/rules/0/below"],
    ["an empty map", { a: {} }, "/ui/statusMaps/a"],
    ["an empty rule list", { a: { rules: [] } }, "/ui/statusMaps/a/rules"],
    ["a colour in place of a map", { a: { values: { on: "#00ff00" } } }, "/ui/statusMaps/a/values/on"],
  ])("rejects %s", (_name, statusMaps, path) => {
    const result = validate({ ...base, ui: { statusMaps } });
    expect(result.classification).toBe(1);
    expect(result.findings.map((finding) => finding.path)).toContain(path);
    expect(result.findings.every((finding) => finding.severity === "error")).toBe(true);
  });

  it("rejects a map name that is not lowercase words and dashes", () => {
    const result = validate({ ...base, ui: { statusMaps: { "UPS Load": STATUS_MAPS.outlet } } });
    expect(result.classification).toBe(1);
  });

  it("is overlay-owned, like the rest of ui", () => {
    const result = validate({ ...base, ui: { statusMaps: STATUS_MAPS } }, { layer: "base" });
    expect(result.findings.map((finding) => finding.code)).toContain("LAYER_OVERLAY_KEY_IN_BASE");
  });

  it("reports a core widget's statusMap the config does not declare, at any depth (UI_STATUS_MAP_UNKNOWN)", () => {
    const result = validate(dashboard(
      [
        { id: "load", type: "core/stat", source: "ups", options: { statusMap: "ups-load" } },
        { id: "outlets", type: "core/table", source: "ups", options: { columns: [{ field: "name" }, { field: "state", statusMap: "outlet" }, { field: "mode", statusMap: "nope" }] } },
        { id: "grid", type: "core/stat-grid", source: "ups", options: { items: [{ field: "load", statusMap: "missing" }] } },
      ],
      { statusMaps: STATUS_MAPS },
    ));
    expect(located(result)).toEqual([
      { code: "UI_STATUS_MAP_UNKNOWN", path: "/ui/pages/0/sections/0/widgets/1/options/columns/2/statusMap", severity: "warning" },
      { code: "UI_STATUS_MAP_UNKNOWN", path: "/ui/pages/0/sections/0/widgets/2/options/items/0/statusMap", severity: "warning" },
    ]);
  });

  it("names no inherited key as declared", () => {
    const result = validate(dashboard([{ type: "core/stat", source: "ups", options: { statusMap: "constructor" } }]));
    expect(result.findings.map((finding) => finding.code)).toEqual(["UI_STATUS_MAP_UNKNOWN"]);
  });
});

describe("core widget options", () => {
  it("composes every core widget type into the default composition", () => {
    expect([...composeDefault().widgetTypes].filter((type) => type.startsWith("core/")).sort()).toEqual(
      CORE_WIDGET_TYPE_SCHEMAS.map(({ type }) => type).sort(),
    );
    const core = BUILTIN_CONTRIBUTIONS.find((contribution) => contribution.id === "core");
    expect(core?.widgetTypes?.map(({ type }) => type)).toEqual(CORE_WIDGET_TYPE_SCHEMAS.map(({ type }) => type));
  });

  it("accepts each type's documented options", () => {
    const result = validate(dashboard(
      [
        { type: "core/stat", source: "ups", select: "load", options: { label: "Load", format: "percent", statusMap: "ups-load" } },
        { type: "core/stat-grid", source: "ups", options: { items: [{ field: "load.avg", label: "Load", format: "number", unit: "W" }] } },
        { type: "core/meter", source: "ups", options: { max: 200, format: "number", unit: "W" } },
        { type: "core/key-value", source: "ups", options: { layout: "inline", items: [{ field: "model" }] } },
        { type: "core/list", source: "ups", options: { titleField: "name", descriptionField: "host", metaField: "seen", metaFormat: "relative-time", statusField: "state", statusMap: "outlet", hrefField: "url", limit: 10 } },
        { type: "core/table", source: "ups", options: { columns: [{ field: "name", header: "Outlet" }, { field: "watts", format: "number", unit: "W", align: "end" }], limit: 50 } },
        { type: "core/status-grid", source: "ups", options: { labelField: "name", statusField: "state", hrefField: "url", statusMap: "outlet" } },
        { type: "core/link-tiles", options: { links: [{ title: "Hosts", href: "/hosts", icon: "server" }, { title: "Vendor", href: "https://vendor.example/x", description: "Status" }] } },
        { type: "core/markdown", options: { content: "**Hello**" } },
        { type: "core/health-pills", options: { pills: ["pill:drift/summary"] } },
        { type: "core/health-pills" },
        { type: "core/json", options: { wrap: true } },
      ],
      { statusMaps: STATUS_MAPS },
    ));
    expect(located(result)).toEqual([]);
  });

  it.each([
    ["a format outside the list", { type: "core/stat", options: { format: "currency" } }, "/format"],
    ["an option the type does not take", { type: "core/stat", options: { colour: "red" } }, "/colour"],
    ["a table without columns", { type: "core/table", options: {} }, ""],
    ["a table with no options at all", { type: "core/table" }, null],
    ["a column without a field", { type: "core/table", options: { columns: [{ header: "Name" }] } }, "/columns/0"],
    ["a field that is a query", { type: "core/table", options: { columns: [{ field: "items[0].name" }] } }, "/columns/0/field"],
    ["a field with an empty step", { type: "core/list", options: { titleField: "a..b" } }, "/titleField"],
    ["a meter max of zero", { type: "core/meter", options: { max: 0 } }, "/max"],
    ["a javascript: link", { type: "core/link-tiles", options: { links: [{ title: "x", href: "javascript:alert(1)" }] } }, "/links/0/href"],
    ["a protocol-relative link", { type: "core/link-tiles", options: { links: [{ title: "x", href: "//evil.example" }] } }, "/links/0/href"],
    ["a pill that is not a pill id", { type: "core/health-pills", options: { pills: ["card:llm-usage/portal"] } }, "/pills/0"],
    ["a statusMap name with spaces", { type: "core/stat", options: { statusMap: "UPS load" } }, "/statusMap"],
  ])("rejects %s", (_name, widget, pointer) => {
    const result = validate(dashboard([widget]));
    expect(result.classification).toBe(1);
    // At the option, or at the widget when it has no options to point into.
    const at = `/ui/pages/0/sections/0/widgets/0${pointer === null ? "" : `/options${pointer}`}`;
    expect(result.findings.some((finding) => finding.path === at || finding.path.startsWith(`${at}/`))).toBe(true);
  });
});

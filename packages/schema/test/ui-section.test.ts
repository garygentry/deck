import { describe, expect, it } from "vitest";
import { merge, resolveOwner, validate } from "../src/index.js";

const base = { schemaVersion: 2, estate: { name: "test" } };
const codes = (result: ReturnType<typeof validate>) => result.findings.map((item) => item.code);
const withUi = (ui: unknown) => ({ ...base, ui });

const full = {
  brand: { title: "Gentry Lab", icon: "server", logoUrl: "https://lab.example/logo.svg" },
  theme: { mode: "dark", preset: "teal", density: "compact", radius: "sm" },
  home: "page:inventory/hosts",
  nav: {
    groups: [{ id: "overview" }, { id: "health", label: "Monitoring" }, { id: "lab", label: "Lab", icon: "flask-conical" }],
    items: [
      { id: "nav:ui/grafana", group: "lab", label: "Grafana", href: "https://grafana.lab", icon: "chart-line", order: 1 },
      { id: "nav:ui/lab-break", group: "lab", separator: true },
    ],
  },
  extensions: {
    "pill:drift/summary": false,
    "pill:llm-usage/summary": { attachTo: { slot: "app/topbar.status", order: 5 } },
    "nav:actions/main": { attachTo: { slot: "app/nav", group: "lab" } },
    "card:llm-usage/portal": { enabled: true, config: { title: "Usage", limit: 3 } },
  },
};

describe("the ui section", () => {
  it("accepts every key it defines", () => {
    expect(validate(withUi(full))).toMatchObject({ classification: 0, findings: [] });
    expect(validate(withUi({}))).toMatchObject({ classification: 0, findings: [] });
    expect(validate(withUi({ brand: { logoUrl: "/assets/logo.png" } })).classification).toBe(0);
    // A module's contributed icon, `<module>/<name>`.
    expect(validate(withUi({ brand: { icon: "maintenance/wrench" } })).classification).toBe(0);
  });

  it.each(["teal", "slate", "copper", "rose", "high-contrast"])("accepts the %s preset", (preset) => {
    expect(validate(withUi({ theme: { preset } }))).toMatchObject({ classification: 0, findings: [] });
  });

  it.each([
    ["an unknown key", { dashboards: [] }, "/ui/dashboards"],
    ["an unknown brand key", { brand: { colour: "red" } }, "/ui/brand/colour"],
    ["a blank title", { brand: { title: "   " } }, "/ui/brand/title"],
    ["a brand icon with two module segments", { brand: { icon: "a/b/c" } }, "/ui/brand/icon"],
    ["a javascript: logo", { brand: { logoUrl: "javascript:alert(1)" } }, "/ui/brand/logoUrl"],
    ["a data: logo", { brand: { logoUrl: "data:image/svg+xml,<svg/>" } }, "/ui/brand/logoUrl"],
    ["a protocol-relative logo", { brand: { logoUrl: "//evil.example/logo.svg" } }, "/ui/brand/logoUrl"],
    ["a logo URL that breaks out of an attribute", { brand: { logoUrl: "https://x.example/\"onerror=alert(1)" } }, "/ui/brand/logoUrl"],
    ["an icon that is not a name", { brand: { icon: "<svg>" } }, "/ui/brand/icon"],
    ["a colour in the theme", { theme: { primary: "#00ff00" } }, "/ui/theme/primary"],
    ["an unknown mode", { theme: { mode: "dim" } }, "/ui/theme/mode"],
    ["an unknown preset", { theme: { preset: "#00ff00" } }, "/ui/theme/preset"],
    ["an unknown density", { theme: { density: "cosy" } }, "/ui/theme/density"],
    ["a radius that is a length", { theme: { radius: "4px" } }, "/ui/theme/radius"],
    ["a home that is not a page id", { home: "/hosts" }, "/ui/home"],
    ["a nav link to a non-http URL", { nav: { items: [{ id: "nav:ui/x", group: "lab", label: "X", href: "javascript:alert(1)" }] } }, "/ui/nav/items/0"],
    ["a nav item outside the ui namespace", { nav: { items: [{ id: "nav:drift/x", group: "lab", label: "X", href: "https://x.example" }] } }, "/ui/nav/items/0"],
    ["a nav group without an id", { nav: { groups: [{ label: "Lab" }] } }, "/ui/nav/groups/0/id"],
    ["an override that is neither a boolean nor an object", { extensions: { "pill:drift/summary": "off" } }, "/ui/extensions/pill:drift~1summary"],
    ["an override with an unknown key", { extensions: { "pill:drift/summary": { hidden: true } } }, "/ui/extensions/pill:drift~1summary"],
  ])("rejects %s", (_name, ui, path) => {
    const result = validate(withUi(ui));
    expect(result.classification).toBe(1);
    expect(result.findings.map((finding) => finding.path)).toContain(path);
  });

  it("is owned by the overlay: a ui value in the base layer is a layer finding", () => {
    expect(resolveOwner("ui.brand.title")).toBe("overlay");
    expect(resolveOwner("ui.extensions")).toBe("overlay");
    const result = validate(withUi({ brand: { title: "Lab" } }), { layer: "base" });
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "LAYER_OVERLAY_KEY_IN_BASE",
      path: "/ui/brand/title",
      message: "overlay-owned value is present in the base layer at /ui/brand/title",
    }));
    expect(codes(validate({ schemaVersion: 2, ui: { brand: { title: "Lab" } } }, { layer: "overlay", base }))).toEqual([]);
  });

  it("merges nav groups and items by id across overlays", () => {
    const first = { schemaVersion: 2, ui: { nav: { groups: [{ id: "lab", label: "Lab" }], items: [{ id: "nav:ui/a", group: "lab", label: "A", href: "https://a.example" }] } } };
    const second = { schemaVersion: 2, ui: { nav: { groups: [{ id: "lab", icon: "flask-conical" }], items: [{ id: "nav:ui/b", group: "lab", label: "B", href: "https://b.example" }] } } };
    const merged = merge(merge(base, first), second) as unknown as { ui: { nav: { groups: unknown[]; items: { id: string }[] } } };
    expect(merged.ui.nav.groups).toEqual([{ id: "lab", label: "Lab", icon: "flask-conical" }]);
    expect(merged.ui.nav.items.map(({ id }) => id)).toEqual(["nav:ui/a", "nav:ui/b"]);
  });

  it("replaces an override's attachTo and config whole across overlays; different ids still merge", () => {
    const first = { schemaVersion: 2, ui: { extensions: {
      "nav:actions/overview": { attachTo: { group: "lab", order: 3 } },
      "card:x/y": { enabled: true, config: { title: "Old", limit: 3 } },
      "pill:drift/summary": false,
    } } };
    const second = { schemaVersion: 2, ui: { extensions: {
      "nav:actions/overview": { attachTo: { slot: "app/nav" } },
      "card:x/y": { config: { title: "New" } },
    } } };
    const merged = merge(merge(base, first), second);
    expect(validate(merged).classification).toBe(0);
    expect((merged as unknown as { ui: { extensions: unknown } }).ui.extensions).toEqual({
      "nav:actions/overview": { attachTo: { slot: "app/nav" } },
      "card:x/y": { enabled: true, config: { title: "New" } },
      "pill:drift/summary": false,
    });
  });

  it("refuses a nav id twice in one layer", () => {
    const twice = { nav: { groups: [{ id: "lab" }, { id: "lab" }] } };
    expect(validate(withUi(twice)).findings).toContainEqual(expect.objectContaining({ code: "ID_DUPLICATE", path: "/ui/nav/groups/1" }));
    const items = { nav: { items: [{ id: "nav:ui/x", group: "lab", separator: true }, { id: "nav:ui/x", group: "lab", label: "X", href: "https://x.example" }] } };
    expect(validate(withUi(items)).findings).toContainEqual(expect.objectContaining({ code: "ID_DUPLICATE", path: "/ui/nav/items/1" }));
  });
});

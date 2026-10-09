import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";

const base = { schemaVersion: 2, estate: { name: "test" } };
const dashboard = (widgets: unknown[], ui: Record<string, unknown> = {}) => ({
  ...base,
  ui: { pages: [{ id: "lab", path: "/lab", title: "Lab", sections: [{ title: "Graphs", widgets }] }], ...ui },
});
const located = (result: ReturnType<typeof validate>) => result.findings.map(({ code, path, severity }) => ({ code, path, severity }));
const embed = (options: unknown) => ({ id: "ups", type: "core/embed", title: "UPS graph", options });

describe("ui.allowUnsafeEmbeds and core/embed", () => {
  it("accepts an embed when the config allows embeds", () => {
    const result = validate(dashboard([embed({ url: "https://grafana.lab/d/ups?kiosk", height: "lg", sandbox: ["allow-scripts"] })], { allowUnsafeEmbeds: true }));
    expect(located(result)).toEqual([]);
  });

  it.each([
    ["no ui.allowUnsafeEmbeds", {}],
    ["ui.allowUnsafeEmbeds: false", { allowUnsafeEmbeds: false }],
  ])("reports an embed with %s (UI_EMBED_DISALLOWED, a warning)", (_name, ui) => {
    const result = validate(dashboard([embed({ url: "https://grafana.lab/d/ups" })], ui));
    expect(located(result)).toEqual([{ code: "UI_EMBED_DISALLOWED", path: "/ui/pages/0/sections/0/widgets/0/type", severity: "warning" }]);
  });

  it("is overlay-owned, like the rest of ui", () => {
    const result = validate({ ...base, ui: { allowUnsafeEmbeds: true } }, { layer: "base" });
    expect(result.findings.map((finding) => finding.code)).toContain("LAYER_OVERLAY_KEY_IN_BASE");
  });

  it("refuses a gate that is not a boolean", () => {
    const result = validate({ ...base, ui: { allowUnsafeEmbeds: "yes" } });
    expect(located(result)).toContainEqual({ code: "SCHEMA_INVALID", path: "/ui/allowUnsafeEmbeds", severity: "error" });
  });

  it.each([
    ["no url", {}, "/ui/pages/0/sections/0/widgets/0/options/url"],
    ["a javascript: url", { url: "javascript:alert(1)" }, "/ui/pages/0/sections/0/widgets/0/options/url"],
    ["a data: url", { url: "data:text/html,<script>1</script>" }, "/ui/pages/0/sections/0/widgets/0/options/url"],
    ["a path in deck", { url: "/hosts" }, "/ui/pages/0/sections/0/widgets/0/options/url"],
    ["a scheme-relative url", { url: "//grafana.lab/d/ups" }, "/ui/pages/0/sections/0/widgets/0/options/url"],
    ["a backslash host", { url: "https://\\\\evil.example/" }, "/ui/pages/0/sections/0/widgets/0/options/url"],
    ["a url with a space", { url: "https://grafana.lab/d/a b" }, "/ui/pages/0/sections/0/widgets/0/options/url"],
    ["top navigation in the sandbox", { url: "https://grafana.lab", sandbox: ["allow-top-navigation"] }, "/ui/pages/0/sections/0/widgets/0/options/sandbox/0"],
    ["modals in the sandbox", { url: "https://grafana.lab", sandbox: ["allow-modals"] }, "/ui/pages/0/sections/0/widgets/0/options/sandbox/0"],
    ["a repeated sandbox token", { url: "https://grafana.lab", sandbox: ["allow-forms", "allow-forms"] }, "/ui/pages/0/sections/0/widgets/0/options/sandbox"],
    ["a height in pixels", { url: "https://grafana.lab", height: 480 }, "/ui/pages/0/sections/0/widgets/0/options/height"],
    ["an unknown height", { url: "https://grafana.lab", height: "huge" }, "/ui/pages/0/sections/0/widgets/0/options/height"],
    ["an unknown option", { url: "https://grafana.lab", allow: "camera" }, "/ui/pages/0/sections/0/widgets/0/options/allow"],
  ])("refuses %s", (_name, options, path) => {
    const result = validate(dashboard([embed(options)], { allowUnsafeEmbeds: true }));
    expect(result.classification).toBe(1);
    expect(result.findings.map((finding) => finding.path)).toContain(path);
  });

  it("accepts an empty sandbox list (the frame may do nothing)", () => {
    const result = validate(dashboard([embed({ url: "http://grafana.lab:3000/d/ups", sandbox: [] })], { allowUnsafeEmbeds: true }));
    expect(located(result)).toEqual([]);
  });
});

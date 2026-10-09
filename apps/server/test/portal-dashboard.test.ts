import type { ModuleManifest, ProviderKindDecl, UiManifest } from "@deck/module-sdk";
import { BUILTIN_STATUS_KINDS } from "@deck/contract/modules/data-sources";
import { PORTAL_UI } from "@deck/contract/modules/portal";
import { validate } from "@deck/schema";
import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { composeModules } from "../src/modules/config.js";
import { moduleKindsProblem } from "../src/modules/host.js";
import { deriveProjections } from "../src/ui/config-pages.js";
import { KERNEL_FEATURES } from "../src/ui/kernel-features.js";
import { resolveUiManifest } from "../src/ui/resolve.js";
import { uiContributionProblem } from "../src/ui/validate.js";
import { testModule } from "./util/modules.js";

/** The built-ins, each on unless named off, with the given overrides. */
const resolveBuiltins = (options: { off?: readonly string[]; overrides?: Record<string, unknown> } = {}): UiManifest =>
  resolveUiManifest({
    modules: BUILTIN_MODULES.map((module) => ({ manifest: module.manifest, enabled: !(options.off ?? []).includes(module.manifest.id), builtin: true })),
    kernelFeatures: KERNEL_FEATURES,
    capabilities: { actions: true },
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });

const portalPage = (manifest: UiManifest) => manifest.pages.find((page) => page.id === "page:portal/overview");
const codes = (manifest: UiManifest) => manifest.findings.map(({ code, id }) => ({ code, id }));

const GROUPS_WIDGET = {
  id: "widget:portal/overview.groups",
  type: "portal/groups",
  source: null,
  options: {},
  span: 1,
  rows: 1,
};

describe("the portal page as a dashboard", () => {
  it("lists its default layout: the portal/summary slot, then one portal/groups widget", () => {
    const manifest = resolveBuiltins();
    expect(portalPage(manifest)?.layout).toEqual({
      sections: [{ slot: "portal/summary" }, { columns: 1, widgets: [GROUPS_WIDGET] }],
    });
    expect(manifest.widgetTypes).toContainEqual({ type: "portal/groups", module: "portal" });
    expect(codes(manifest)).toEqual([]);
    // Its widgets read no provider, so nothing is projected for them.
    expect(deriveProjections(manifest).size).toBe(0);
  });

  it("lets config switch the groups widget off by id, taking only enabled", () => {
    const off = resolveBuiltins({ overrides: { "widget:portal/overview.groups": false } });
    expect(portalPage(off)?.layout).toEqual({ sections: [{ slot: "portal/summary" }] });
    expect(codes(off)).toEqual([]);

    const moved = resolveBuiltins({ overrides: { "widget:portal/overview.groups": { attachTo: { slot: "portal/summary" } } } });
    expect(portalPage(moved)?.layout?.sections).toHaveLength(2);
    expect(codes(moved)).toEqual([{ code: "UI_INVALID_OVERRIDE", id: "widget:portal/overview.groups" }]);
  });

  it("drops a slot section whose host is off, and reports one no module declares", () => {
    const host = testModule({
      id: "board",
      contributes: {
        slots: [{ id: "board/top", accepts: "widget" }],
        pages: [{ id: "page:board/main", path: "/board", title: "Board", component: "Board", layout: { sections: [{ slot: "board/top" }, { widgets: [{ id: "j", type: "core/json" }] }] } }],
      },
    });
    const manifest = resolveUiManifest({ modules: [{ manifest: host.manifest, enabled: true }], kernelFeatures: KERNEL_FEATURES });
    expect(manifest.pages.find((page) => page.id === "page:board/main")?.layout?.sections).toEqual([
      { slot: "board/top" },
      { columns: 1, widgets: [{ id: "widget:board/main.j", type: "core/json", source: null, options: {}, span: 1, rows: 1 }] },
    ]);

    // A type no enabled module provides renders as unavailable, as on a config page.
    const strange = testModule({
      id: "board",
      contributes: {
        pages: [{ id: "page:board/main", path: "/board", title: "Board", component: "Board", layout: { sections: [{ slot: "elsewhere/top" }, { widgets: [{ id: "g", type: "board/gone" }] }] } }],
      },
    });
    const resolved = resolveUiManifest({ modules: [{ manifest: strange.manifest, enabled: true }], kernelFeatures: KERNEL_FEATURES });
    const layout = resolved.pages.find((page) => page.id === "page:board/main")?.layout;
    expect(layout?.sections).toEqual([
      { columns: 1, widgets: [expect.objectContaining({ id: "widget:board/main.g", typeProblem: 'No enabled module provides the widget type "board/gone".' })] },
    ]);
    expect(codes(resolved)).toContainEqual({ code: "UI_UNKNOWN_SLOT", id: "page:board/main" });
  });

  it("is not routed while the portal is off, so neither is its layout", () => {
    expect(portalPage(resolveBuiltins({ off: ["portal"] }))).toBeUndefined();
  });
});

describe("a module page's layout in its manifest", () => {
  const manifest = (layout: unknown, extra: Partial<ModuleManifest["contributes"]> = {}): ModuleManifest => ({
    id: "board",
    version: "1",
    deckApi: "^0.1",
    contributes: {
      slots: [{ id: "board/top", accepts: "widget" }, { id: "board/pills", accepts: "pill" }],
      widgetTypes: [{ type: "board/tile", optionsSchema: {} }],
      pages: [{ id: "page:board/main", path: "/board", title: "Board", component: "Board", layout: layout as never }],
      ...extra,
    },
  });

  it("accepts its own widget slots and widget types, and core's types", () => {
    expect(uiContributionProblem(PORTAL_UI as ModuleManifest)).toBeNull();
    expect(uiContributionProblem(manifest({ sections: [{ slot: "board/top" }, { widgets: [{ id: "a", type: "board/tile" }, { id: "b", type: "core/json" }] }] }))).toBeNull();
  });

  it.each([
    ["not a sections object", [], /layout must be \{ sections/],
    ["an extra layout key", { sections: [], columns: 2 }, /layout must be \{ sections/],
    ["a slot it does not host", { sections: [{ slot: "other/top" }] }, /widget slot the module hosts/],
    ["a slot that is not a widget slot", { sections: [{ slot: "board/pills" }] }, /widget slot the module hosts/],
    ["a section of neither shape", { sections: [{ title: "x", widgets: [] }] }, /\{ slot \} or \{ widgets/],
    ["an empty widget section", { sections: [{ widgets: [] }] }, /1 to 24 widgets/],
    ["widget options", { sections: [{ widgets: [{ id: "a", type: "board/tile", options: {} }] }] }, /take no options or source/],
    ["a malformed widget id", { sections: [{ widgets: [{ id: "A b", type: "board/tile" }] }] }, /lowercase letters/],
    ["a widget id used twice", { sections: [{ widgets: [{ id: "a", type: "board/tile" }] }, { widgets: [{ id: "a", type: "core/json" }] }] }, /used twice/],
    ["another module's widget type", { sections: [{ widgets: [{ id: "a", type: "portal/groups" }] }] }, /own widget types or core's/],
    ["an own type it does not declare", { sections: [{ widgets: [{ id: "a", type: "board/other" }] }] }, /own widget types or core's/],
  ])("refuses %s", (_label, layout, problem) => {
    expect(uiContributionProblem(manifest(layout))).toMatch(problem);
  });
});

describe("status kinds", () => {
  it("lists every enabled bindable, status-capable kind's declaration, by kind", () => {
    expect(resolveBuiltins().statusKinds).toEqual(BUILTIN_STATUS_KINDS);
    expect(resolveBuiltins({ off: ["docker"] }).statusKinds?.map(({ kind }) => kind)).toEqual(["gatus", "http-health"]);
  });

  it("leaves the field out when no enabled kind declares one", () => {
    const manifest = resolveUiManifest({ modules: [], kernelFeatures: KERNEL_FEATURES });
    expect(manifest).not.toHaveProperty("statusKinds");
  });

  const withKind = (decl: Partial<ProviderKindDecl>) =>
    testModule({ id: "ups", providerKinds: [{ kind: "ups", bindable: true, statusCapable: true, ...decl }] });
  const bindingHandler = { ups: { binding: () => [] } };
  const kindsProblem = (decl: Partial<ProviderKindDecl>) => moduleKindsProblem({ ...withKind(decl), kinds: bindingHandler });
  const UP = [{ field: "power.on", in: [true, "on"] }];

  it("accepts a well-formed declaration on a bindable, status-capable kind", () => {
    expect(kindsProblem({ fixedId: "ups", status: { provider: "fixed", match: { list: "outlets", key: "id", binding: "outlet" }, up: UP } })).toBeNull();
    expect(kindsProblem({ status: { provider: "binding", up: UP } })).toBeNull();
  });

  it.each([
    ["on a kind that is not status-capable", { statusCapable: false, status: { provider: "binding", up: UP } }, /not bindable and statusCapable/],
    ["on a kind that is not bindable", { bindable: false, status: { provider: "binding", up: UP } }, /not bindable and statusCapable/],
    ["an unknown key", { status: { provider: "binding", up: UP, tone: "ok" } }, /unknown key "tone"/],
    ["an unknown provider", { status: { provider: "any", up: UP } }, /provider must be/],
    ["fixed without a fixedId", { status: { provider: "fixed", up: UP } }, /needs the kind's fixedId/],
    ["a query in a match", { fixedId: "ups", status: { provider: "fixed", match: { list: "outlets[0]", key: "id", binding: "outlet" }, up: UP } }, /each a key path/],
    ["no conditions", { status: { provider: "binding", up: [] } }, /1 to 8 conditions/],
    ["a query as a field", { status: { provider: "binding", up: [{ field: "a | b", in: [true] }] } }, /field a key path/],
    ["an object value", { status: { provider: "binding", up: [{ field: "a", in: [{}] }] } }, /text, number or boolean/],
  ])("refuses a declaration %s, disabling its module", (_label, decl, problem) => {
    expect(kindsProblem(decl as Partial<ProviderKindDecl>)).toMatch(problem);
  });

  it("disables a module whose kind declares a bad status, never failing boot", () => {
    const bad = { ...withKind({ fixedId: "ups", status: { provider: "fixed", up: [] } as never }), kinds: bindingHandler };
    const { invalid } = composeModules([...BUILTIN_MODULES, bad], { sectionOf: () => undefined, env: {} });
    expect(invalid.get("ups")).toMatch(/status up must list/);
  });
});

describe("portal/groups on a config page", () => {
  const { composed } = composeModules(BUILTIN_MODULES, { sectionOf: () => undefined, env: {} });
  const document = (options: unknown) => ({
    schemaVersion: 2,
    estate: { name: "x" },
    ui: { pages: [{ id: "media", path: "/media", title: "Media", sections: [{ title: "Apps", widgets: [{ type: "portal/groups", options }] }] }] },
  });

  it("validates its options against the portal's schema", () => {
    expect(validate(document({ groups: ["media", "infra"] }), { composed }).findings).toEqual([]);
    expect(validate(document(undefined), { composed }).findings).toEqual([]);
    for (const bad of [{ groups: [] }, { groups: ["a", "a"] }, { groups: [""] }, { facets: false }]) {
      expect(validate(document(bad), { composed }).findings).toContainEqual(expect.objectContaining({ code: expect.stringMatching(/^SCHEMA_/) }));
    }
  });
});

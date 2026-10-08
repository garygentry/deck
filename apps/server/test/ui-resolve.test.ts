import { SHELL_SLOTS as SHARED_SHELL_SLOTS } from "@deck/contract/modules/core";
import { isKernelSlot, type ModuleManifest } from "@deck/module-sdk";
import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { planningRouteTable, RESERVED_ROOT_PATHS } from "../src/server/app.js";
import { KERNEL_FEATURES, SHELL_SLOTS, type KernelFeature } from "../src/ui/kernel-features.js";
import { DEFAULT_UI } from "../src/ui/defaults.js";
import { estateNameOf, resolveUiManifest, uiOverridesOf, type ResolveUiInput } from "../src/ui/resolve.js";
import { uiContributionProblem } from "../src/ui/validate.js";
import { testHost, testModule } from "./util/modules.js";

const shell: KernelFeature = { manifest: { id: "core", version: "0.1.0", deckApi: "^0.1", contributes: { slots: [...SHELL_SLOTS] } } };

function manifest(id: string, contributes: ModuleManifest["contributes"]): ModuleManifest {
  return { id, version: "1.0.0", deckApi: "^0.1", contributes };
}

const gadgets = manifest("gadgets", {
  pages: [{ id: "page:gadgets/overview", path: "/gadgets", title: "Gadgets", icon: "boxes", component: "GadgetsPage" }],
  nav: [{ id: "nav:gadgets/main", page: "page:gadgets/overview", group: "lab" }],
  slots: [
    { id: "gadgets/cards", accepts: "widget" },
    { id: "gadgets/side", accepts: "widget" },
  ],
  extensions: [
    { id: "pill:gadgets/summary", kind: "pill", attachTo: { slot: "app/topbar.status", order: 5 }, component: "GadgetPill" },
    { id: "card:gadgets/hidden", kind: "widget", attachTo: { slot: "gadgets/cards" }, component: "Hidden", enabled: false },
  ],
});

const widgets = manifest("widgets", {
  extensions: [
    { id: "card:widgets/tile", kind: "widget", attachTo: { slot: "gadgets/cards", order: 1 }, component: "Tile", config: { size: 2 } },
  ],
});

function resolve(input: Partial<ResolveUiInput> = {}) {
  return resolveUiManifest({
    modules: [
      { manifest: gadgets, enabled: true },
      { manifest: widgets, enabled: true },
    ],
    kernelFeatures: [shell],
    ...input,
  });
}

const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

describe("resolveUiManifest", () => {
  it("collects every enabled module's contributions with defaults, sorted", () => {
    const ui = resolve({ providers: [{ id: "b", kind: "link" }, { id: "a", kind: "docker" }] });
    expect(ui.uiApi).toBe(1);
    expect(ids(ui.modules)).toEqual(["core", "gadgets", "widgets"]);
    expect(ui.modules.map((m) => m.origin)).toEqual(["kernel", "module", "module"]);
    expect(ids(ui.slots)).toEqual(["app/nav", "app/routes", "app/topbar.actions", "app/topbar.status", "entity:host/sections", "entity:service/sections", "gadgets/cards", "gadgets/side"]);
    expect(ui.pages).toEqual([
      { id: "page:gadgets/overview", module: "gadgets", path: "/gadgets", title: "Gadgets", icon: "boxes", component: "GadgetsPage" },
    ]);
    // The entry shows its page's title and icon; its group is not configured, so it is headed by its id.
    expect(ui.nav).toEqual([
      { id: "nav:gadgets/main", module: "gadgets", slot: "app/nav", page: "page:gadgets/overview", group: "lab", label: "Gadgets", icon: "boxes", order: 100 },
    ]);
    expect(ui.navGroups).toEqual([{ id: "lab", label: "lab" }]);
    expect(ui.brand).toEqual({ title: "Deck" });
    // An extension declared `enabled: false` stays off without an override.
    expect(ui.extensions.map((e) => `${e.slot} ${e.order} ${e.id}`)).toEqual([
      "app/topbar.status 5 pill:gadgets/summary",
      "gadgets/cards 1 card:widgets/tile",
    ]);
    expect(ui.extensions[1]).toMatchObject({ kind: "widget", module: "widgets", component: "Tile", config: { size: 2 } });
    expect(ui.providers).toEqual([{ id: "a", kind: "docker" }, { id: "b", kind: "link" }]);
    expect(ui.findings).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const forward = resolve();
    const reversed = resolve({ modules: [{ manifest: widgets, enabled: true }, { manifest: gadgets, enabled: true }] });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("drops the contributions of a disabled module, and the extensions on its slots", () => {
    const ui = resolve({ modules: [{ manifest: gadgets, enabled: false, reason: "not enabled: no modules.gadgets section" }, { manifest: widgets, enabled: true }] });
    expect(ui.modules.find((m) => m.id === "gadgets")).toEqual({
      id: "gadgets", version: "1.0.0", enabled: false, reason: "not enabled: no modules.gadgets section", origin: "module",
    });
    expect(ui.pages).toEqual([]);
    expect(ui.nav).toEqual([]);
    // widgets' card targets a slot of the disabled module: dropped with its host, no finding.
    expect(ui.extensions).toEqual([]);
    expect(ui.findings).toEqual([]);
  });

  it("disables a kernel feature whose capability is off, and enables it when on", () => {
    const gated: KernelFeature = {
      manifest: manifest("ops", {
        pages: [{ id: "page:ops/overview", path: "/ops", title: "Ops", component: "OpsPage" }],
        nav: [{ id: "nav:ops/main", page: "page:ops/overview", group: "operate" }],
      }),
      requires: "ops",
    };
    const off = resolve({ kernelFeatures: [shell, gated] });
    expect(off.modules.find((m) => m.id === "ops")).toMatchObject({ enabled: false, reason: 'capability "ops" is off', origin: "kernel" });
    expect(ids(off.pages)).toEqual(["page:gadgets/overview"]);
    const on = resolve({ kernelFeatures: [shell, gated], capabilities: { ops: true } });
    expect(ids(on.pages)).toEqual(["page:gadgets/overview", "page:ops/overview"]);
    // "operate" is a configured group, so it comes before the unconfigured "lab".
    expect(ids(on.nav)).toEqual(["nav:ops/main", "nav:gadgets/main"]);
  });

  it("lets a module replace the kernel feature with the same id", () => {
    const legacy: KernelFeature = { manifest: manifest("gadgets", { pages: [{ id: "page:gadgets/legacy", path: "/old", title: "Old", component: "Old" }] }) };
    const ui = resolve({ kernelFeatures: [shell, legacy] });
    expect(ui.modules.filter((m) => m.id === "gadgets")).toEqual([{ id: "gadgets", version: "1.0.0", enabled: true, origin: "module" }]);
    expect(ids(ui.pages)).toEqual(["page:gadgets/overview"]);
  });

  describe("overrides (replace semantics)", () => {
    it("false disables an extension; true enables one that is off by default", () => {
      const ui = resolve({ overrides: { "pill:gadgets/summary": false, "card:gadgets/hidden": true } });
      expect(ids(ui.extensions)).toEqual(["card:widgets/tile", "card:gadgets/hidden"]);
      expect(ui.findings).toEqual([]);
    });

    it("an object replaces attachTo and config wholesale", () => {
      const ui = resolve({
        overrides: {
          "card:widgets/tile": { attachTo: { slot: "gadgets/side" }, config: { tint: "x" } },
          "pill:gadgets/summary": { enabled: false },
        },
      });
      expect(ui.extensions).toEqual([
        // The replacement attachTo has no order, so the declared order 1 gives way to the default.
        { id: "card:widgets/tile", kind: "widget", module: "widgets", slot: "gadgets/side", order: 100, component: "Tile", config: { tint: "x" } },
      ]);
    });

    it("disabling a page drops its route and the nav entries to it", () => {
      const ui = resolve({ overrides: { "page:gadgets/overview": false } });
      expect(ui.pages).toEqual([]);
      expect(ui.nav).toEqual([]);
      expect(ui.findings).toEqual([]);
    });

    it("a nav override can disable an entry or replace its order", () => {
      expect(resolve({ overrides: { "nav:gadgets/main": false } }).nav).toEqual([]);
      expect(resolve({ overrides: { "nav:gadgets/main": { attachTo: { slot: "app/nav", order: 3 } } } }).nav[0]?.order).toBe(3);
    });

    it("an override for an unknown id is a finding; one for a disabled module's extension is not", () => {
      const ui = resolve({
        modules: [{ manifest: gadgets, enabled: true }, { manifest: widgets, enabled: false }],
        overrides: { "pill:nobody/thing": false, "card:widgets/tile": false },
      });
      expect(ui.findings).toEqual([
        { code: "UI_UNKNOWN_EXTENSION", severity: "warning", message: 'override "pill:nobody/thing" names no known extension, page or nav entry', id: "pill:nobody/thing" },
      ]);
    });
  });

  describe("findings", () => {
    it("an extension attached to an unknown slot is dropped with a finding", () => {
      const stray = manifest("stray", { extensions: [{ id: "pill:stray/x", kind: "pill", attachTo: { slot: "app/nowhere" }, component: "X" }] });
      const ui = resolve({ modules: [{ manifest: stray, enabled: true }] });
      expect(ui.extensions).toEqual([]);
      expect(ui.findings).toEqual([
        { code: "UI_UNKNOWN_SLOT", severity: "warning", message: '"pill:stray/x" attaches to unknown slot "app/nowhere"', id: "pill:stray/x", slot: "app/nowhere" },
      ]);
    });

    it("an override re-attaching to an unknown slot is a finding too", () => {
      const ui = resolve({ overrides: { "pill:gadgets/summary": { attachTo: { slot: "app/footer" } } } });
      expect(ui.findings.map((f) => f.code)).toEqual(["UI_UNKNOWN_SLOT"]);
      expect(ids(ui.extensions)).toEqual(["card:widgets/tile"]);
    });

    it("two pages on one path: the first by id is routed, the other is a finding", () => {
      const other = manifest("other", { pages: [{ id: "page:other/gadgets", path: "/gadgets", title: "Clash", component: "Clash" }] });
      const ui = resolve({ modules: [{ manifest: other, enabled: true }, { manifest: gadgets, enabled: true }] });
      expect(ids(ui.pages)).toEqual(["page:gadgets/overview"]);
      expect(ui.findings).toEqual([
        {
          code: "UI_PAGE_PATH_COLLISION",
          severity: "warning",
          message: 'page "page:other/gadgets" uses path "/gadgets", already served by "page:gadgets/overview"; it is not routed',
          id: "page:other/gadgets",
        },
      ]);
    });

    it("an id or slot contributed twice keeps the copy of the first module by id, with a finding", () => {
      const copy = manifest("replica", {
        slots: [{ id: "gadgets/cards", accepts: "widget" }],
        extensions: [{ id: "pill:gadgets/summary", kind: "pill", attachTo: { slot: "app/topbar.status" }, component: "Copy" }],
      });
      const ui = resolve({ modules: [{ manifest: gadgets, enabled: true }, { manifest: copy, enabled: true }] });
      expect(ui.extensions.find((e) => e.id === "pill:gadgets/summary")?.module).toBe("gadgets");
      expect(ui.slots.find((s) => s.id === "gadgets/cards")?.module).toBe("gadgets");
      expect(ui.findings.map((f) => `${f.code} ${f.id ?? f.slot}`)).toEqual([
        "UI_DUPLICATE_ID gadgets/cards",
        "UI_DUPLICATE_ID pill:gadgets/summary",
      ]);
    });

    it("a nav entry to a page no module declares is a finding", () => {
      const lost = manifest("lost", { nav: [{ id: "nav:lost/main", page: "page:lost/none", group: "lab" }] });
      const ui = resolve({ modules: [{ manifest: lost, enabled: true }] });
      expect(ui.nav).toEqual([]);
      expect(ui.findings.map((f) => f.code)).toEqual(["UI_UNKNOWN_EXTENSION"]);
    });
  });
});

describe("shell: brand and nav groups", () => {
  const groups = (navGroups: { id: string; label: string; icon?: string }[]) => ({ nav: { groups: navGroups } });
  const nav = (id: string, group: string, extra: Partial<{ order: number; label: string; icon: string }> = {}) => ({
    id: `nav:shelf/${id}` as const,
    href: `/${id}`,
    group,
    ...extra,
  });
  const shelf = manifest("shelf", {
    nav: [nav("a", "zeta"), nav("b", "health", { order: 2 }), nav("c", "overview", { label: "Home", icon: "house" }), nav("d", "alpha"), nav("e", "health", { order: 1 })],
  });

  it("brands the shell with the estate's name, or deck's when it has none", () => {
    expect(resolve({ estateName: "Gentry Lab" }).brand).toEqual({ title: "Gentry Lab" });
    expect(resolve({ estateName: "  Lab  " }).brand).toEqual({ title: "Lab" });
    expect(resolve({ estateName: " " }).brand).toEqual({ title: "Deck" });
    expect(resolve().brand).toEqual({ title: "Deck" });
  });

  it("orders groups by the ui config, then the others by id; only groups with an entry are listed", () => {
    const ui = resolve({ modules: [{ manifest: shelf, enabled: true }] });
    // The default ui config: overview, inventory, health, operate, knowledge (no entries for inventory, operate, knowledge).
    expect(ui.navGroups).toEqual([
      { id: "overview", label: "Overview" },
      { id: "health", label: "Health" },
      { id: "alpha", label: "alpha" },
      { id: "zeta", label: "zeta" },
    ]);
    // Entries follow their group's position, then order, then id.
    expect(ids(ui.nav)).toEqual(["nav:shelf/c", "nav:shelf/e", "nav:shelf/b", "nav:shelf/d", "nav:shelf/a"]);
    // An href entry without a label is labelled by its href.
    expect(ui.nav.map((item) => item.label)).toEqual(["Home", "/e", "/b", "/d", "/a"]);
    expect(ui.nav[0]).toMatchObject({ icon: "house" });
  });

  it("takes group order, labels and icons from the given ui config", () => {
    const ui = resolve({
      modules: [{ manifest: shelf, enabled: true }],
      ui: groups([{ id: "zeta", label: "Last", icon: "flask-conical" }, { id: "health", label: "Monitoring" }]),
    });
    expect(ui.navGroups).toEqual([
      { id: "zeta", label: "Last", icon: "flask-conical" },
      { id: "health", label: "Monitoring" },
      { id: "alpha", label: "alpha" },
      { id: "overview", label: "overview" },
    ]);
    expect(ids(ui.nav)).toEqual(["nav:shelf/a", "nav:shelf/e", "nav:shelf/b", "nav:shelf/d", "nav:shelf/c"]);
  });

  it("a group configured twice keeps its first entry, with a finding", () => {
    const ui = resolve({
      modules: [{ manifest: shelf, enabled: true }],
      ui: groups([{ id: "health", label: "First" }, { id: "zeta", label: "Zeta" }, { id: "health", label: "Again" }]),
    });
    expect(ui.navGroups.map(({ id, label }) => `${id}:${label}`)).toEqual(["health:First", "zeta:Zeta", "alpha:alpha", "overview:overview"]);
    expect(ui.findings).toEqual([
      { code: "UI_DUPLICATE_ID", severity: "warning", message: 'nav group "health" is configured more than once; its first entry is used', id: "health" },
    ]);
  });

  it("lists only the groups of entries in app/nav", () => {
    const menus = manifest("menus", { slots: [{ id: "menus/side", accepts: "nav" }] });
    const ui = resolve({
      modules: [{ manifest: shelf, enabled: true }, { manifest: menus, enabled: true }],
      overrides: { "nav:shelf/a": { attachTo: { slot: "menus/side" } } },
    });
    expect(ui.navGroups.map((group) => group.id)).toEqual(["overview", "health", "alpha"]);
    // The re-attached entry sorts after every listed group.
    expect(ids(ui.nav).at(-1)).toBe("nav:shelf/a");
  });

  it("the built-ins' nav groups are all in the default ui config", () => {
    const used = [...BUILTIN_MODULES.map((module) => module.manifest), ...KERNEL_FEATURES.map((feature) => feature.manifest)].flatMap((m) => (m.contributes?.nav ?? []).map((n) => n.group));
    const configured = DEFAULT_UI.nav.groups.map((group) => group.id);
    expect(used.filter((group) => !configured.includes(group))).toEqual([]);
  });
});

describe("estateNameOf", () => {
  it("reads estate.name when it is a string, else none", () => {
    expect(estateNameOf({ estate: { name: "lab" } })).toBe("lab");
    expect(estateNameOf({ estate: { name: 3 } })).toBeUndefined();
    expect(estateNameOf({})).toBeUndefined();
    expect(estateNameOf(null)).toBeUndefined();
  });
});

describe("uiOverridesOf", () => {
  it("reads ui.extensions when it is a map, else none", () => {
    expect(uiOverridesOf({ ui: { extensions: { "pill:a/b": false } } })).toEqual({ "pill:a/b": false });
    expect(uiOverridesOf({ ui: {} })).toEqual({});
    expect(uiOverridesOf({ ui: { extensions: [] } })).toEqual({});
    expect(uiOverridesOf(null)).toEqual({});
  });
});

describe("kernel-wired features", () => {
  it("declare well-formed UI contributions; only core hosts the kernel-reserved slots", () => {
    for (const { manifest: feature } of KERNEL_FEATURES) {
      expect(uiContributionProblem(feature, { kernel: feature.id === "core" }), feature.id).toBeNull();
    }
  });

  it("give core exactly the shared shell slots, the list the web registry declares", () => {
    expect(SHELL_SLOTS).toBe(SHARED_SHELL_SLOTS);
    const core = KERNEL_FEATURES.find(({ manifest }) => manifest.id === "core")!;
    expect(core.manifest.contributes?.slots).toEqual(SHARED_SHELL_SLOTS);
    // Every kernel-reserved slot is core's, so none can be declared later by anything else.
    expect(SHARED_SHELL_SLOTS.every(({ id }) => isKernelSlot(id))).toBe(true);
  });

  it("resolve with no findings", () => {
    const ui = resolveUiManifest({
      modules: BUILTIN_MODULES.map((module) => ({ manifest: module.manifest, enabled: true })),
      kernelFeatures: KERNEL_FEATURES,
      capabilities: { actions: true },
    });
    expect(ui.findings).toEqual([]);
  });

  it("are not also built-in modules (move the entry into the module once it exists)", () => {
    const moduleIds = new Set(BUILTIN_MODULES.map((module) => module.manifest.id));
    const overlaps = KERNEL_FEATURES.filter(({ manifest: feature }) => moduleIds.has(feature.id)).map(
      ({ manifest: feature }) =>
        `"${feature.id}" is now a built-in module: move its KERNEL_FEATURES entry (apps/server/src/ui/kernel-features.ts, ` +
        `feature("${feature.id}", …)) into contributes of the "${feature.id}" module manifest, then delete the entry`,
    );
    expect(overlaps).toEqual([]);
  });

  it.each([
    ["portal", ["page:portal/overview", "nav:portal/overview", "pill:portal/endpoints"], ["portal/summary"]],
    ["inventory", ["page:inventory/hosts", "page:inventory/services", "page:inventory/host-detail", "page:inventory/service-detail", "nav:inventory/hosts", "nav:inventory/services"], []],
    ["drift", ["page:drift/overview", "nav:drift/overview", "pill:drift/summary", "section:drift/host-findings", "section:drift/service-findings"], []],
    ["monitoring", ["page:monitoring/overview", "nav:monitoring/overview", "pill:monitoring/alerts", "pill:monitoring/metrics"], []],
    ["sources", ["page:sources/docs", "page:sources/configs", "nav:sources/docs", "nav:sources/configs", "section:sources/host-configs", "section:sources/service-configs"], []],
  ])("moved %s's UI entries into its module manifest", (id, extensionIds, slotIds) => {
    expect(KERNEL_FEATURES.map(({ manifest }) => manifest.id)).not.toContain(id);
    const module = BUILTIN_MODULES.find(({ manifest }) => manifest.id === id);
    expect(module, id).toBeDefined();
    const contributes = module!.manifest.contributes ?? {};
    const declared = [...(contributes.pages ?? []), ...(contributes.nav ?? []), ...(contributes.extensions ?? [])].map((entry) => entry.id);
    expect(declared).toEqual(extensionIds);
    expect((contributes.slots ?? []).map((slot) => slot.id)).toEqual(slotIds);
  });

  it("leaves only core, now that every feature is a module", () => {
    expect(KERNEL_FEATURES.map(({ manifest }) => manifest.id)).toEqual(["core"]);
  });
});

describe("buildUiManifest", () => {
  it("lists a module with an unusable manifest by id, contributing nothing", async () => {
    const { buildUiManifest } = await import("../src/ui/manifest.js");
    const ui = buildUiManifest({
      config: {},
      providers: { listProviders: () => [{ id: "nas", kind: "docker" }] },
      modules: {
        plan: [
          { id: "gadgets", enabled: true },
          { id: "broken", enabled: false, reason: "Module \"broken\" has an invalid manifest: bad." },
        ],
        manifests: new Map([["gadgets", gadgets]]),
        builtinIds: new Set(),
      },
      capabilities: {},
    });
    expect(ui.modules.find((m) => m.id === "broken")).toEqual({
      id: "broken", version: "unknown", enabled: false, reason: "Module \"broken\" has an invalid manifest: bad.", origin: "module",
    });
    expect(ui.pages.map((p) => p.id)).toContain("page:gadgets/overview");
    expect(ui.providers).toEqual([{ id: "nas", kind: "docker" }]);
    // The kernel's own features (core) are listed beside the modules. Actions, drift and
    // sources are modules now: no kernel feature stands in for them, so without them in the
    // plan they are not listed.
    expect(ui.modules.find((m) => m.id === "core")).toMatchObject({ enabled: true, origin: "kernel" });
    expect(ui.modules.find((m) => m.id === "sources")).toBeUndefined();
    expect(ui.modules.find((m) => m.id === "actions")).toBeUndefined();
    expect(ui.modules.find((m) => m.id === "drift")).toBeUndefined();
  });
});

describe("review round 1 regressions", () => {
  const kernel = (): ResolveUiInput => ({
    modules: BUILTIN_MODULES.map((module) => ({ manifest: module.manifest, enabled: true, builtin: true })),
    kernelFeatures: KERNEL_FEATURES,
    capabilities: { actions: true },
  });
  const finding = (ui: ReturnType<typeof resolveUiManifest>) => ui.findings.map((f) => `${f.code} ${f.id ?? f.slot}`);

  describe("L1: an extension renders only in a slot that accepts its kind", () => {
    it("a topbar pill re-attached to an entity-section slot is dropped with UI_SLOT_KIND_MISMATCH", () => {
      const ui = resolveUiManifest({ ...kernel(), overrides: { "pill:drift/summary": { attachTo: { slot: "entity:host/sections" } } } });
      expect(ui.extensions.map((e) => e.id)).not.toContain("pill:drift/summary");
      expect(ui.findings).toEqual([
        {
          code: "UI_SLOT_KIND_MISMATCH",
          severity: "warning",
          message: '"pill:drift/summary" (pill) attaches to slot "entity:host/sections", which accepts entity-section',
          id: "pill:drift/summary",
          slot: "entity:host/sections",
        },
      ]);
    });

    it("a declared extension of the wrong kind for its slot is dropped too", () => {
      const pills = manifest("pills", { extensions: [{ id: "pill:pills/x", kind: "pill", attachTo: { slot: "gadgets/cards" }, component: "X" }] });
      const ui = resolve({ modules: [{ manifest: gadgets, enabled: true }, { manifest: pills, enabled: true }] });
      expect(ui.extensions.map((e) => e.id)).not.toContain("pill:pills/x");
      expect(finding(ui)).toEqual(["UI_SLOT_KIND_MISMATCH pill:pills/x"]);
    });

    it("validate restricts an extension's kind to the slot vocabulary", () => {
      const card = manifest("x", { extensions: [{ id: "card:x/c", kind: "card", attachTo: { slot: "x/s" }, component: "C" }] });
      expect(uiContributionProblem(card)).toMatch(/kind must be one of pill, widget, entity-section, action/);
    });

    it("the built-ins resolve with every extension in an accepting slot", () => {
      const ui = resolveUiManifest(kernel());
      const accepts = new Map(ui.slots.map((slot) => [slot.id, slot.accepts]));
      for (const extension of ui.extensions) expect(accepts.get(extension.slot), extension.id).toBe(extension.kind);
      expect(ui.extensions.find((e) => e.id === "card:llm-usage/portal")).toMatchObject({ kind: "widget", slot: "portal/summary" });
    });
  });

  describe("L2: the incumbent keeps contested routes and slots; slots are namespaced", () => {
    // The reviewer's probe: a module "alerts" claiming the portal's path and the shell's status slot. Validation
    // rejects the slot (the host would disable the module); resolution alone still keeps the incumbents.
    const alerts = manifest("alerts", {
      pages: [{ id: "page:alerts/home", path: "/portal", title: "Alerts", component: "AlertsHome" }],
      slots: [{ id: "app/topbar.status", accepts: "widget" }],
    });

    it("validate rejects a module slot in a kernel-reserved or foreign namespace", () => {
      expect(uiContributionProblem(alerts)).toMatch(/slot "app\/topbar.status" is in a kernel-reserved namespace/);
      expect(uiContributionProblem(manifest("alerts", { slots: [{ id: "entity:host/extra", accepts: "entity-section" }] }))).toMatch(/kernel-reserved namespace/);
      expect(uiContributionProblem(manifest("alerts", { slots: [{ id: "portal/summary", accepts: "widget" }] }))).toMatch(/must be namespaced to its module \("alerts\/<name>"\)/);
      expect(uiContributionProblem(manifest("alerts", { slots: [{ id: "alerts/cards", accepts: "widget" }] }))).toBeNull();
      // A module named "app" cannot claim the shell namespace either.
      expect(uiContributionProblem(manifest("app", { slots: [{ id: "app/topbar.status", accepts: "pill" }] }))).toMatch(/kernel-reserved/);
    });

    it("core keeps its slot and the built-in portal keeps /portal, whatever the newcomer's id sorts as", () => {
      const input = kernel();
      const ui = resolveUiManifest({ ...input, modules: [...input.modules, { manifest: alerts, enabled: true }] });
      expect(ui.pages.find((page) => page.path === "/portal")?.id).toBe("page:portal/overview");
      expect(ui.slots.find((slot) => slot.id === "app/topbar.status")).toEqual({ id: "app/topbar.status", accepts: "pill", module: "core" });
      expect(ui.extensions.filter((e) => e.slot === "app/topbar.status")).toHaveLength(5);
      expect(finding(ui)).toEqual(["UI_DUPLICATE_ID app/topbar.status", "UI_PAGE_PATH_COLLISION page:alerts/home"]);
      // Disabling the newcomer changes nothing for the shell.
      const without = resolveUiManifest({ ...input, modules: [...input.modules, { manifest: alerts, enabled: false }] });
      expect(without.extensions).toEqual(ui.extensions);
    });

    it("a built-in module keeps a contested page path over another module", () => {
      const squatter = manifest("aaa", { pages: [{ id: "page:aaa/drift", path: "/drift", title: "Squat", component: "S" }] });
      const input = kernel();
      const ui = resolveUiManifest({ ...input, modules: [...input.modules, { manifest: squatter, enabled: true }] });
      expect(ui.pages.find((page) => page.path === "/drift")?.id).toBe("page:drift/overview");
      expect(finding(ui)).toEqual(["UI_PAGE_PATH_COLLISION page:aaa/drift"]);
    });

    it("a kernel-wired feature keeps a contested page path over a module", () => {
      const squatter = manifest("aaa", { pages: [{ id: "page:aaa/docs", path: "/docs", title: "Squat", component: "S" }] });
      const input = kernel();
      const ui = resolveUiManifest({ ...input, modules: [...input.modules, { manifest: squatter, enabled: true }] });
      expect(ui.pages.find((page) => page.path === "/docs")?.id).toBe("page:sources/docs");
      expect(finding(ui)).toEqual(["UI_PAGE_PATH_COLLISION page:aaa/docs"]);
    });

    it("built-in modules stay incumbent at runtime, through the real host plan (L1)", async () => {
      const { buildUiManifest } = await import("../src/ui/manifest.js");
      const squatter = testModule({
        id: "aaa",
        contributes: {
          pages: [
            { id: "page:aaa/home", path: "/portal", title: "Squat", component: "S" },
            { id: "page:aaa/drift", path: "/drift", title: "Squat", component: "S" },
            { id: "page:aaa/hosts", path: "/hosts", title: "Squat", component: "S" },
          ],
        },
      });
      // The host snapshots each manifest, so built-ins are recognised by id, not by object.
      const { host } = testHost([...BUILTIN_MODULES, squatter], {
        env: { DECK_ACTIONS_ENABLED: "1" },
        kernelRoutes: planningRouteTable(),
        reservedRootPaths: RESERVED_ROOT_PATHS,
      });
      expect(host.manifests.get("portal")).not.toBe(BUILTIN_MODULES.find(({ manifest: m }) => m.id === "portal")!.manifest);
      expect([...host.builtinIds].sort()).toEqual(BUILTIN_MODULES.map(({ manifest: m }) => m.id).sort());
      const ui = buildUiManifest({ config: {}, providers: { listProviders: () => [] }, modules: host, capabilities: { actions: true } });
      expect(ui.pages.find((page) => page.path === "/portal")?.id).toBe("page:portal/overview");
      expect(ui.pages.find((page) => page.path === "/drift")?.id).toBe("page:drift/overview");
      expect(ui.pages.find((page) => page.path === "/hosts")?.id).toBe("page:inventory/hosts");
      expect(ui.findings.map((f) => `${f.code} ${f.id ?? f.slot}`).sort()).toEqual([
        "UI_PAGE_PATH_COLLISION page:aaa/drift",
        "UI_PAGE_PATH_COLLISION page:aaa/home",
        "UI_PAGE_PATH_COLLISION page:aaa/hosts",
      ]);
    });

    it("a module the host does not count as built in gets no incumbency", async () => {
      const { buildUiManifest } = await import("../src/ui/manifest.js");
      const squatter = testModule({ id: "aaa", contributes: { pages: [{ id: "page:aaa/home", path: "/portal", title: "Squat", component: "S" }] } });
      const { host } = testHost([...BUILTIN_MODULES, squatter], { builtins: new Set(), kernelRoutes: planningRouteTable(), reservedRootPaths: RESERVED_ROOT_PATHS });
      expect(host.builtinIds.size).toBe(0);
      const ui = buildUiManifest({ config: {}, providers: { listProviders: () => [] }, modules: host, capabilities: {} });
      expect(ui.pages.find((page) => page.path === "/portal")?.id).toBe("page:aaa/home");
    });
  });

  describe("C1: nav attachment overrides resolve like any attachment", () => {
    const ordered = manifest("gadgets", {
      ...gadgets.contributes,
      nav: [{ id: "nav:gadgets/main", page: "page:gadgets/overview", group: "lab", order: 3 }],
    });
    const run = (override: unknown, extra: ResolveUiInput["modules"] = []) =>
      resolve({ modules: [{ manifest: ordered, enabled: true }, ...extra], overrides: { "nav:gadgets/main": override } });

    it("an unknown slot drops the entry with UI_UNKNOWN_SLOT", () => {
      const ui = run({ attachTo: { slot: "missing/slot" } });
      expect(ui.nav).toEqual([]);
      expect(finding(ui)).toEqual(["UI_UNKNOWN_SLOT nav:gadgets/main"]);
    });

    it("re-attaching without an order resets the order to the default", () => {
      expect(run({ attachTo: { slot: "app/nav" } }).nav[0]).toMatchObject({ slot: "app/nav", order: 100 });
      expect(run(true).nav[0]).toMatchObject({ slot: "app/nav", order: 3 });
    });

    it("a slot of a disabled module drops the entry silently; one that is not a nav slot is a mismatch", () => {
      const menus = manifest("menus", { slots: [{ id: "menus/side", accepts: "nav" }] });
      const off = run({ attachTo: { slot: "menus/side" } }, [{ manifest: menus, enabled: false }]);
      expect(off.nav).toEqual([]);
      expect(off.findings).toEqual([]);
      const on = run({ attachTo: { slot: "menus/side", order: 2 } }, [{ manifest: menus, enabled: true }]);
      expect(on.nav[0]).toMatchObject({ slot: "menus/side", order: 2 });
      expect(finding(run({ attachTo: { slot: "gadgets/cards" } }))).toEqual(["UI_SLOT_KIND_MISMATCH nav:gadgets/main"]);
    });
  });

  describe("L4: malformed overrides are ignored with UI_INVALID_OVERRIDE", () => {
    it("re-ordering without a slot keeps the slot", () => {
      const ui = resolve({ overrides: { "pill:gadgets/summary": { attachTo: { order: 1 } } } });
      expect(ui.extensions.find((e) => e.id === "pill:gadgets/summary")).toMatchObject({ slot: "app/topbar.status", order: 1 });
      expect(ui.findings).toEqual([]);
    });

    it.each([
      ["a scalar", "off", "it must be true, false or an object"],
      ["a non-object config", { config: "x" }, "config must be an object"],
      ["a non-boolean enabled", { enabled: "no" }, "enabled must be a boolean"],
      ["an empty slot", { attachTo: { slot: "" } }, "attachTo.slot must be a non-empty string"],
      ["a non-numeric order", { attachTo: { order: "1" } }, "attachTo.order must be a finite number"],
      ["an unknown key", { hidden: true }, 'unknown key "hidden"'],
    ])("%s", (_label, value, problem) => {
      const ui = resolve({ overrides: { "pill:gadgets/summary": value } });
      // Ignored: the extension keeps its declared state.
      expect(ui.extensions.find((e) => e.id === "pill:gadgets/summary")).toMatchObject({ slot: "app/topbar.status", order: 5 });
      expect(ui.findings).toEqual([
        { code: "UI_INVALID_OVERRIDE", severity: "warning", message: `override "pill:gadgets/summary" is ignored: ${problem}`, id: "pill:gadgets/summary" },
      ]);
    });
  });

  describe("L5: nav hrefs and page paths are safe", () => {
    const nav = (href: string) => manifest("x", { nav: [{ id: "nav:x/n", href, group: "lab" }] });
    const page = (path: string) => manifest("x", { pages: [{ id: "page:x/p", path, title: "P", component: "P" }] });

    it.each(["javascript:alert(1)", "//evil.example/x", "data:text/html,x", "/\\evil", "lab", "ftp://x"])("rejects href %s", (href) => {
      expect(uiContributionProblem(nav(href))).toMatch(/href must be an http\(s\) URL or an absolute path/);
    });

    it.each(["https://grafana.lab", "http://nas:5000/", "/lab", "/docs/runbooks"])("accepts href %s", (href) => {
      expect(uiContributionProblem(nav(href))).toBeNull();
    });

    it.each([
      ["/api/health", "is under /api"],
      ["/api", "is under /api"],
      ["/metrics", "reserved root path"],
    ])("rejects page path %s", (path, problem) => {
      expect(uiContributionProblem(page(path))).toContain(problem);
    });
  });

  describe("L6: page and nav prefixes belong to page and nav declarations", () => {
    it("an extension may not use the page: or nav: prefix", () => {
      for (const id of ["page:x/squat", "nav:x/squat"] as const) {
        const squat = manifest("x", { extensions: [{ id, kind: "widget", attachTo: { slot: "x/s" }, component: "C" }] });
        expect(uiContributionProblem(squat)).toMatch(/only (page|nav) declarations may use/);
      }
    });

    it("a nav entry to an id that is not a declared page is a finding", () => {
      const squat = manifest("gadgets", {
        ...gadgets.contributes,
        extensions: [{ id: "page:gadgets/x" as never, kind: "widget", attachTo: { slot: "gadgets/cards" }, component: "C" }],
        nav: [{ id: "nav:gadgets/x", page: "page:gadgets/x", group: "lab" }],
      });
      const ui = resolve({ modules: [{ manifest: squat, enabled: true }] });
      expect(ui.nav.map((n) => n.id)).not.toContain("nav:gadgets/x");
      expect(finding(ui)).toContain("UI_UNKNOWN_EXTENSION nav:gadgets/x");
    });
  });
});

describe("review round 2 regressions", () => {
  const kernel = (): ResolveUiInput => ({
    modules: BUILTIN_MODULES.map((module) => ({ manifest: module.manifest, enabled: true, builtin: true })),
    kernelFeatures: KERNEL_FEATURES,
    capabilities: { actions: true },
  });

  describe("N1: no module replaces the kernel core", () => {
    // The reviewer's probe: a module with id "core" and no contributions. The host refuses the
    // id (module-host.test.ts); resolution keeps the kernel core even if one got through.
    it.each([true, false])("the shell slots, nav and pills survive a module named core (enabled: %s)", (enabled) => {
      const baseline = resolveUiManifest(kernel());
      const input = kernel();
      const ui = resolveUiManifest({
        ...input,
        modules: [...input.modules, { manifest: manifest("core", {}), enabled, ...(enabled ? {} : { reason: "refused" }) }],
      });
      expect(ui.slots).toEqual(baseline.slots);
      expect(ui.nav).toEqual(baseline.nav);
      expect(ui.extensions).toEqual(baseline.extensions);
      expect(ui.findings).toEqual([]);
      expect(ui.modules.filter((m) => m.id === "core").map((m) => m.origin)).toEqual(["module", "kernel"]);
    });

    it("a module named core cannot take a core slot either", () => {
      const input = kernel();
      const squatter = manifest("core", { slots: [{ id: "app/topbar.status", accepts: "widget" }] });
      const ui = resolveUiManifest({ ...input, modules: [...input.modules, { manifest: squatter, enabled: true }] });
      expect(ui.slots.find((slot) => slot.id === "app/topbar.status")).toMatchObject({ accepts: "pill" });
      expect(ui.findings.map((f) => f.code)).toEqual(["UI_DUPLICATE_ID"]);
    });
  });

  describe("N2: override parts that do not apply to their target are refused", () => {
    it("the reviewer's probe: attachTo/config on a page and config on a nav entry", () => {
      const baseline = resolveUiManifest(kernel());
      const ui = resolveUiManifest({
        ...kernel(),
        overrides: {
          "page:drift/overview": { attachTo: { slot: "nope" }, config: { a: 1 } },
          "nav:drift/overview": { config: { a: 1 } },
        },
      });
      expect(ui.findings).toEqual([
        { code: "UI_INVALID_OVERRIDE", severity: "warning", message: 'override "nav:drift/overview" is ignored: "config" does not apply to a nav entry', id: "nav:drift/overview" },
        { code: "UI_INVALID_OVERRIDE", severity: "warning", message: 'override "page:drift/overview" is ignored: "attachTo", "config" does not apply to a page', id: "page:drift/overview" },
      ]);
      // Ignored: nothing changed.
      expect(ui.pages).toEqual(baseline.pages);
      expect(ui.nav).toEqual(baseline.nav);
    });

    it("what does apply still works: enabled on a page, attachTo on a nav entry", () => {
      const ui = resolveUiManifest({
        ...kernel(),
        overrides: { "page:drift/overview": { enabled: false }, "nav:monitoring/overview": { attachTo: { order: 1 } } },
      });
      expect(ui.findings).toEqual([]);
      expect(ui.pages.map((p) => p.id)).not.toContain("page:drift/overview");
      expect(ui.nav.find((n) => n.id === "nav:monitoring/overview")?.order).toBe(1);
    });
  });
});

describe("shared UI rules (C3.1b review C2)", () => {
  it.each(["probe/", "probe/bad name", "probe//cards", "probe/Cards"])("rejects slot id %s, as the web registry does", (id) => {
    expect(uiContributionProblem(manifest("probe", { slots: [{ id, accepts: "widget" }] }))).toMatch(/must be namespaced to its module \("probe\/<name>"\)/);
  });

  it.each(["probe/cards", "probe/cards/nested", "probe/v1.side"])("accepts slot id %s", (id) => {
    expect(uiContributionProblem(manifest("probe", { slots: [{ id, accepts: "widget" }] }))).toBeNull();
  });

  it("the kernel's reserved root paths are the ones the shared rules (and the web) refuse", async () => {
    const { KERNEL_ROOT_PATHS } = await import("@deck/module-sdk");
    const { RESERVED_ROOT_PATHS } = await import("../src/server/reserved-paths.js");
    expect([...RESERVED_ROOT_PATHS].sort()).toEqual([...KERNEL_ROOT_PATHS].sort());
  });
});

describe("open entity sections", () => {
  const kernel = (): ResolveUiInput => ({
    modules: BUILTIN_MODULES.map((module) => ({ manifest: module.manifest, enabled: true, builtin: true })),
    kernelFeatures: KERNEL_FEATURES,
    capabilities: { actions: true },
  });
  const sections = (ui: ReturnType<typeof resolveUiManifest>, slot: string) =>
    ui.extensions.filter((e) => e.slot === slot).map(({ id, order, config }) => ({ id, order, config }));
  // A module the kernel has never heard of adds a host section, with no kernel change.
  const backups = manifest("backups", {
    extensions: [
      { id: "section:backups/host", kind: "entity-section", attachTo: { slot: "entity:host/sections", order: 15 }, component: "Backups", config: { title: "Backups" } },
    ],
  });

  it("the built-ins attach the findings and configs sections by id, findings first", () => {
    const ui = resolveUiManifest(kernel());
    for (const entity of ["host", "service"]) {
      expect(sections(ui, `entity:${entity}/sections`)).toEqual([
        { id: `section:drift/${entity}-findings`, order: 10, config: { section: "findings", title: "Findings" } },
        { id: `section:sources/${entity}-configs`, order: 20, config: { section: "configs", title: "Configs" } },
      ]);
    }
  });

  it("any module's section attaches to an entity page and sorts among the built-ins by order", () => {
    expect(uiContributionProblem(backups)).toBeNull();
    const input = kernel();
    const ui = resolveUiManifest({ ...input, modules: [...input.modules, { manifest: backups, enabled: true }] });
    expect(sections(ui, "entity:host/sections").map(({ id }) => id)).toEqual([
      "section:drift/host-findings",
      "section:backups/host",
      "section:sources/host-configs",
    ]);
    expect(ui.findings).toEqual([]);
  });

  it("validate requires a section title and a lowercase section name", () => {
    const section = (config: unknown) =>
      manifest("backups", {
        extensions: [{ id: "section:backups/host", kind: "entity-section", attachTo: { slot: "entity:host/sections" }, component: "B", ...(config === undefined ? {} : { config: config as never }) }],
      });
    expect(uiContributionProblem(section(undefined))).toMatch(/extension "section:backups\/host" config needs a title/);
    expect(uiContributionProblem(section({ section: "backups" }))).toMatch(/config needs a title/);
    expect(uiContributionProblem(section({ title: "Backups", section: "Backups!" }))).toMatch(/config section must be a lowercase name/);
    expect(uiContributionProblem(section({ title: "Backups", section: "findings" }))).toBeNull();
    // An extension's own section (`backups.host`) cannot be joined by naming it.
    expect(uiContributionProblem(section({ title: "Hijack", section: "backups.host" }))).toMatch(/dotted names are reserved for implicit sections/);
  });

  it("an override with an invalid section config still disables the section (fail-safe)", () => {
    const ui = resolveUiManifest({
      ...kernel(),
      overrides: { "section:drift/host-findings": { enabled: false, config: { section: "findings" } } },
    });
    expect(ui.extensions.map((e) => e.id)).not.toContain("section:drift/host-findings");
    expect(ui.extensions.map((e) => e.id)).toContain("section:drift/service-findings");
    expect(ui.findings).toEqual([
      {
        code: "UI_INVALID_OVERRIDE",
        severity: "warning",
        message: `override "section:drift/host-findings" config is ignored: an entity section's config needs a title`,
        id: "section:drift/host-findings",
      },
    ]);
  });

  it("an override with an invalid section config still re-orders the section, keeping its declared config", () => {
    const ui = resolveUiManifest({
      ...kernel(),
      overrides: { "section:drift/host-findings": { attachTo: { order: 30 }, config: { title: "X", section: "a.b" } } },
    });
    expect(ui.extensions.find((e) => e.id === "section:drift/host-findings")).toMatchObject({
      order: 30,
      config: { section: "findings", title: "Findings" },
    });
    expect(ui.findings.map((f) => f.code)).toEqual(["UI_INVALID_OVERRIDE"]);
  });

  it("a replacement config must still be a section: one without a title is dropped with a finding", () => {
    const retitled = resolveUiManifest({ ...kernel(), overrides: { "section:drift/host-findings": { config: { section: "findings", title: "Drift" } } } });
    expect(retitled.extensions.find((e) => e.id === "section:drift/host-findings")?.config).toEqual({ section: "findings", title: "Drift" });
    expect(retitled.findings).toEqual([]);

    const untitled = resolveUiManifest({ ...kernel(), overrides: { "section:drift/host-findings": { config: { section: "findings" } } } });
    expect(untitled.extensions.find((e) => e.id === "section:drift/host-findings")?.config).toEqual({ section: "findings", title: "Findings" });
    expect(untitled.findings).toEqual([
      {
        code: "UI_INVALID_OVERRIDE",
        severity: "warning",
        message: `override "section:drift/host-findings" config is ignored: an entity section's config needs a title`,
        id: "section:drift/host-findings",
      },
    ]);
  });
});

describe("capability-aware nav: disabled modules' pages and their switches", () => {
  const gadgetsPage = { id: "page:gadgets/overview", module: "gadgets", path: "/gadgets", title: "Gadgets", icon: "boxes" };

  it("lists a disabled module's pages as disabled pages, with the switches that enable it", () => {
    const ui = resolve({
      modules: [
        { manifest: gadgets, enabled: false, reason: "not enabled: GADGETS_ENABLED is not true", enabledBy: [{ env: "GADGETS_ENABLED" }] },
        { manifest: widgets, enabled: true },
      ],
    });
    expect(ui.pages).toEqual([]);
    expect(ui.nav).toEqual([]);
    expect(ui.disabledPages).toEqual([gadgetsPage]);
    expect(ui.modules.find((m) => m.id === "gadgets")).toEqual({
      id: "gadgets", version: "1.0.0", enabled: false, reason: "not enabled: GADGETS_ENABLED is not true", origin: "module", enabledBy: [{ env: "GADGETS_ENABLED" }],
    });
    expect(ui.findings).toEqual([]);
  });

  it("lists no disabled pages while every module is on, and never switches for an enabled module or an empty list", () => {
    const on = resolve({ modules: [{ manifest: gadgets, enabled: true, enabledBy: [{ config: "modules.gadgets" }] }] });
    expect(on.disabledPages).toEqual([]);
    expect(on.modules.find((m) => m.id === "gadgets")).not.toHaveProperty("enabledBy");
    const none = resolve({ modules: [{ manifest: gadgets, enabled: false, reason: "off", enabledBy: [] }] });
    expect(none.modules.find((m) => m.id === "gadgets")).not.toHaveProperty("enabledBy");
  });

  it("copies only each switch's name, whatever else its input object carries", () => {
    const enabledBy = [{ env: "GADGETS_ENABLED", value: "s3cret" }, { config: "modules.gadgets", value: "s3cret" }] as unknown as { env: string }[];
    const ui = resolve({ modules: [{ manifest: gadgets, enabled: false, reason: "off", enabledBy }] });
    expect(ui.modules.find((m) => m.id === "gadgets")?.enabledBy).toEqual([{ env: "GADGETS_ENABLED" }, { config: "modules.gadgets" }]);
    expect(JSON.stringify(ui)).not.toContain("s3cret");
  });

  it("leaves out a disabled page whose path an enabled page or a root path serves", () => {
    const rival = manifest("rival", {
      pages: [{ id: "page:rival/overview", path: "/gadgets", title: "Rival", component: "RivalPage" }],
    });
    const rooted = manifest("rooted", { routes: { rootPaths: ["/gizmos"] } });
    const gizmos = manifest("gizmos", {
      pages: [{ id: "page:gizmos/overview", path: "/gizmos", title: "Gizmos", component: "GizmosPage" }],
    });
    const ui = resolve({
      modules: [
        { manifest: gadgets, enabled: false, reason: "off" },
        { manifest: rival, enabled: true },
        { manifest: rooted, enabled: false, reason: "off" },
        { manifest: gizmos, enabled: false, reason: "off" },
      ],
    });
    expect(ids(ui.pages)).toEqual(["page:rival/overview"]);
    expect(ui.disabledPages).toEqual([]);
  });

  it("leaves out a disabled page whose path the web router could not compile, with a finding; the others stay", () => {
    const tools = manifest("tools", {
      pages: [
        { id: "page:tools/broken", path: "/tools/[", title: "Broken", component: "BrokenPage" },
        { id: "page:tools/api", path: "/api/tools", title: "Api", component: "ApiPage" },
        { id: "page:tools/overview", path: "/tools", title: "Tools", component: "ToolsPage" },
      ],
    });
    const ui = resolve({ modules: [{ manifest: tools, enabled: false, reason: "off" }] });
    expect(ui.disabledPages).toEqual([{ id: "page:tools/overview", module: "tools", path: "/tools", title: "Tools" }]);
    expect(ui.findings.map((f) => `${f.code} ${f.id}`)).toEqual(["UI_INVALID_PAGE page:tools/broken", "UI_INVALID_PAGE page:tools/api"]);
  });

  it("the host names a module's unmet switches (env var and config key), and only when they are why it is off", () => {
    const { host } = testHost(
      [
        testModule({ id: "envgated", enabledBy: { env: "ENVGATED_ENABLED" }, env: ["ENVGATED_ENABLED", "ENVGATED_TOKEN"] }),
        testModule({ id: "configgated", enabledBy: { config: true } }),
        testModule({ id: "both", enabledBy: { config: true, env: "BOTH_ENABLED" }, env: ["BOTH_ENABLED"] }),
        testModule({ id: "orphan", dependsOn: ["missing"] }),
      ],
      { env: { ENVGATED_ENABLED: "no", ENVGATED_TOKEN: "tok-9f2c1e-s3cret" } },
    );
    const byId = new Map(host.plan.map((entry) => [entry.id, entry]));
    expect(byId.get("envgated")).toMatchObject({ enabled: false, gates: [{ env: "ENVGATED_ENABLED" }] });
    expect(byId.get("configgated")).toMatchObject({ enabled: false, gates: [{ config: "modules.configgated" }] });
    // Both of its own switches are unmet: both are named (the reason gives the first).
    expect(byId.get("both")).toEqual({ id: "both", enabled: false, reason: "not enabled: no modules.both section", gates: [{ config: "modules.both" }, { env: "BOTH_ENABLED" }] });
    expect(byId.get("orphan")).toMatchObject({ enabled: false });
    expect(byId.get("orphan")).not.toHaveProperty("gates");
  });

  it("the host names a dependency's switches when that dependency is off only because of them", () => {
    const { host } = testHost(
      [
        testModule({ id: "base", enabledBy: { env: "BASE_ENABLED" }, env: ["BASE_ENABLED"] }),
        testModule({ id: "addon", dependsOn: ["base"] }),
        testModule({ id: "gated-addon", dependsOn: ["base"], enabledBy: { env: "ADDON_ENABLED" }, env: ["ADDON_ENABLED"] }),
        testModule({ id: "top", dependsOn: ["addon"] }),
        testModule({ id: "mixed", dependsOn: ["base", "missing"] }),
      ],
      {},
    );
    const byId = new Map(host.plan.map((entry) => [entry.id, entry]));
    expect(byId.get("addon")).toMatchObject({ enabled: false, gates: [{ env: "BASE_ENABLED" }] });
    expect(byId.get("addon")?.reason).toMatch(/depends on "base"/);
    // Its own switch, then its dependency's.
    expect(byId.get("gated-addon")).toMatchObject({ enabled: false, gates: [{ env: "ADDON_ENABLED" }, { env: "BASE_ENABLED" }] });
    // Transitively: top needs addon, which needs base's switch.
    expect(byId.get("top")).toMatchObject({ enabled: false, gates: [{ env: "BASE_ENABLED" }] });
    // A dependency that is missing outright: no setting would enable it.
    expect(byId.get("mixed")).not.toHaveProperty("gates");
  });

  it("names no switch for an own-gated module whose dependency was refused (no setting enables that)", () => {
    const { host } = testHost([
      // Refused outright: it requires a deckApi this deck does not provide.
      testModule({ id: "refused", deckApi: "^99.0" }),
      testModule({ id: "gated", dependsOn: ["refused"], enabledBy: { env: "GATED_ENABLED" }, env: ["GATED_ENABLED"] }),
    ]);
    const byId = new Map(host.plan.map((entry) => [entry.id, entry]));
    expect(byId.get("refused")).toMatchObject({ enabled: false });
    expect(byId.get("refused")).not.toHaveProperty("gates");
    // Its own reason stands, but GATED_ENABLED alone would not enable it.
    expect(byId.get("gated")).toEqual({ id: "gated", enabled: false, reason: "not enabled: GATED_ENABLED is not true" });
  });

  it("/api/ui names env vars and config keys, never a value set for them", async () => {
    const { buildUiManifest } = await import("../src/ui/manifest.js");
    const tools = testModule({
      id: "tools",
      enabledBy: { env: "TOOLS_ENABLED" },
      env: ["TOOLS_ENABLED", "TOOLS_TOKEN"],
      contributes: { pages: [{ id: "page:tools/overview", path: "/tools", title: "Tools", component: "ToolsPage" }] },
    });
    const { host } = testHost([tools], { env: { TOOLS_ENABLED: "nope-7d1a", TOOLS_TOKEN: "tok-9f2c1e-s3cret" } });
    const ui = buildUiManifest({ config: {}, providers: { listProviders: () => [] }, modules: host, capabilities: {} });
    expect(ui.modules.find((m) => m.id === "tools")).toMatchObject({ enabled: false, enabledBy: [{ env: "TOOLS_ENABLED" }] });
    expect(ui.disabledPages).toEqual([{ id: "page:tools/overview", module: "tools", path: "/tools", title: "Tools" }]);
    const body = JSON.stringify(ui);
    expect(body).not.toContain("nope-7d1a");
    expect(body).not.toContain("tok-9f2c1e-s3cret");
  });
});

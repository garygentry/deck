import { beforeEach, describe, expect, it, vi } from "vitest";

const Component = () => null;

describe("registration contract", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers and reads all four registration kinds", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "page:core/home", path: "/", label: "Home", component: Component });
    registry.registerCard({ id: "card:core/portal", slot: "core/home", component: Component });
    registry.registerEntityFragment({ id: "section:core/host", entity: "host", title: "Host", component: Component });
    const slot = registry.defineSummarySlot<{ label: string }>({ slotId: "core/health" });
    registry.registerSummaryFragment(slot, { id: "pill:core/summary", component: Component });

    expect(registry.getPages().map(({ id }) => id)).toEqual(["page:core/home"]);
    expect(registry.getCards("core/home").map(({ id }) => id)).toEqual(["card:core/portal"]);
    expect(registry.getEntityFragments("host").map(({ id }) => id)).toEqual(["section:core/host"]);
    expect(registry.getExtensions(slot.slotId).map(({ id }) => id)).toEqual(["pill:core/summary"]);
  });

  it("sorts new accessor arrays by order then id regardless of registration order", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "page:t/z", path: "/z", label: "Z", component: Component });
    registry.registerPage({ id: "page:t/late", path: "/late", label: "Late", component: Component, order: 200 });
    registry.registerPage({ id: "page:t/a", path: "/a", label: "A", component: Component });
    registry.registerPage({ id: "page:t/first", path: "/first", label: "First", component: Component, order: 0 });

    const firstRead = registry.getPages();
    expect(firstRead.map(({ id }) => id)).toEqual(["page:t/first", "page:t/a", "page:t/z", "page:t/late"]);
    expect(registry.getPages()).not.toBe(firstRead);
    expect(firstRead[0]?.order).toBe(0);
    expect(firstRead[1]).not.toHaveProperty("order");
  });

  it("sorts filtered card, entity, and summary accessors", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerCard({ id: "card:t/b", slot: "target", component: Component });
    registry.registerCard({ id: "card:t/ignored", slot: "other", component: Component, order: 0 });
    registry.registerCard({ id: "card:t/a", slot: "target", component: Component });
    registry.registerEntityFragment({ id: "section:t/b", entity: "host", title: "Details", section: "details", component: Component });
    registry.registerEntityFragment({ id: "section:t/a", entity: "host", title: "Details", section: "details", component: Component });
    const slot = registry.defineSummarySlot<Record<string, never>>({ slotId: "core/summary" });
    registry.registerSummaryFragment(slot, { id: "pill:t/b", component: Component });
    registry.registerSummaryFragment(slot, { id: "pill:t/a", component: Component });

    expect(registry.getCards("target").map(({ id }) => id)).toEqual(["card:t/a", "card:t/b"]);
    expect(registry.getEntityFragments("host", "details").map(({ id }) => id)).toEqual(["section:t/a", "section:t/b"]);
    expect(registry.getExtensions(slot.slotId).map(({ id }) => id)).toEqual(["pill:t/a", "pill:t/b"]);
  });

  it("preserves optional nav without changing validation behavior", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "page:t/visible", path: "/visible", label: "Visible", component: Component });
    registry.registerPage({
      id: "page:t/hidden",
      path: "/hidden/:name",
      label: "Hidden",
      component: Component,
      nav: false,
    });

    const pages = registry.getPages();
    const visible = pages.find(({ id }) => id === "page:t/visible")!;
    const hidden = pages.find(({ id }) => id === "page:t/hidden")!;
    expect(visible.nav).toBeUndefined();
    expect(hidden.nav).toBe(false);
    // nav is not required for registration validation to succeed.
    expect(pages.map(({ id }) => id)).toEqual(["page:t/hidden", "page:t/visible"]);
  });

  it("throws UNKNOWN_SLOT for an undeclared summary slot, pointing at summarySlot(id)", async () => {
    const registry = await import("../src/registry/registry.js");
    expect(() =>
      registry.registerSummaryFragment({ slotId: "missing" }, { id: "pill:t/fragment", component: Component }),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_SLOT", message: expect.stringContaining("summarySlot(id)") }));
  });

  it("throws MISSING_FIELD for malformed registrations", async () => {
    const registry = await import("../src/registry/registry.js");
    expect(() => registry.registerPage({ path: "/", label: "Home", component: Component } as any)).toThrowError(
      expect.objectContaining({ code: "MISSING_FIELD" }),
    );
  });

  it("throws INVALID_ID for an id that is not <kind>:<module>/<name>, or of the wrong kind", async () => {
    const registry = await import("../src/registry/registry.js");
    expect(() => registry.registerPage({ id: "home" as never, path: "/", label: "Home", component: Component })).toThrowError(
      expect.objectContaining({ code: "INVALID_ID" }),
    );
    expect(() => registry.registerPage({ id: "card:t/home", path: "/", label: "Home", component: Component })).toThrowError(
      expect.objectContaining({ code: "INVALID_ID", message: expect.stringContaining('must start with "page:"') }),
    );
    expect(() => registry.registerCard({ id: "pill:t/c", slot: "s", component: Component })).toThrowError(
      expect.objectContaining({ code: "INVALID_ID" }),
    );
    expect(() => registry.registerEntityFragment({ id: "card:t/s", entity: "host", title: "S", component: Component })).toThrowError(
      expect.objectContaining({ code: "INVALID_ID" }),
    );
    const slot = registry.defineSummarySlot({ slotId: "core/s" });
    expect(() => registry.registerSummaryFragment(slot, { id: "card:t/p", component: Component })).toThrowError(
      expect.objectContaining({ code: "INVALID_ID" }),
    );
  });

  it("throws for duplicate ids and slot ids", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "page:t/same", path: "/", label: "Home", component: Component });
    expect(() =>
      registry.registerPage({ id: "page:t/same", path: "/other", label: "Other", component: Component }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
    registry.defineSummarySlot({ slotId: "core/same" });
    expect(() => registry.defineSummarySlot({ slotId: "core/same" })).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_SLOT" }),
    );
  });
});

describe("extension model", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("re-expresses each blueprint as an extension with a stable id, kind, module and slot", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "page:t/list", path: "/list", label: "List", icon: "server", group: "Inventory", component: Component, order: 5 });
    registry.registerPage({ id: "page:t/detail", path: "/list/:id", label: "Detail", component: Component, nav: false });
    registry.registerCard({ id: "card:t/tile", slot: "t/summary", providerId: "docker", component: Component });
    registry.registerEntityFragment({ id: "section:t/findings", entity: "service", title: "Findings", section: "findings", component: Component });
    const slot = registry.summarySlot("app/topbar.status");
    registry.registerSummaryFragment(slot, { id: "pill:t/status", component: Component, order: 10 });

    const summary = registry
      .getAllExtensions()
      .map(({ id, kind, module, attachTo, enabled, config }) => ({ id, kind, module, slot: attachTo.slot, order: attachTo.order, enabled, config }));
    expect(summary).toEqual([
      { id: "card:t/tile", kind: "widget", module: "t", slot: "t/summary", order: 100, enabled: true, config: { providerId: "docker" } },
      // Only a listed page gets a nav entry; it names its page and shares its order.
      { id: "nav:t/list", kind: "nav", module: "t", slot: "app/nav", order: 5, enabled: true, config: { page: "page:t/list" } },
      { id: "page:t/detail", kind: "page", module: "t", slot: "app/routes", order: 100, enabled: true, config: { path: "/list/:id", label: "Detail", nav: false } },
      {
        id: "page:t/list",
        kind: "page",
        module: "t",
        slot: "app/routes",
        order: 5,
        enabled: true,
        config: { path: "/list", label: "List", icon: "server", group: "Inventory" },
      },
      { id: "pill:t/status", kind: "pill", module: "t", slot: "app/topbar.status", order: 10, enabled: true, config: {} },
      { id: "section:t/findings", kind: "entity-section", module: "t", slot: "entity:service/sections", order: 100, enabled: true, config: { section: "findings", title: "Findings" } },
    ]);
    expect(registry.getExtensions("app/nav").map(({ id }) => id)).toEqual(["nav:t/list"]);
    // Extensions are frozen: a host cannot reshape another module's contribution.
    expect(Object.isFrozen(registry.getExtensions("app/nav")[0])).toBe(true);
  });

  it("registers a generic extension; a disabled one is listed but never attached", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerExtension({ id: "widget:t/on", kind: "widget", attachTo: { slot: "t/cards", order: 2 }, component: Component });
    registry.registerExtension({ id: "widget:t/off", kind: "widget", attachTo: { slot: "t/cards", order: 1 }, enabled: false, component: Component });
    expect(registry.getExtensions("t/cards").map(({ id }) => id)).toEqual(["widget:t/on"]);
    expect(registry.getAllExtensions().map(({ id }) => id)).toEqual(["widget:t/off", "widget:t/on"]);
    expect(() => registry.registerExtension({ id: "widget:t/on", kind: "widget", component: () => null, attachTo: { slot: "t/cards" } })).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_ID" }),
    );
    expect(() => registry.registerExtension({ id: "widget:t/x", kind: "widget", component: () => null, attachTo: { slot: "" } })).toThrowError(
      expect.objectContaining({ code: "MISSING_FIELD" }),
    );
  });

  it("pages and nav entries come only from registerPage", async () => {
    const registry = await import("../src/registry/registry.js");
    for (const id of ["nav:t/taken", "page:t/taken"] as const) {
      expect(() => registry.registerExtension({ id, kind: "widget", attachTo: { slot: "t/s" } })).toThrowError(
        expect.objectContaining({ code: "INVALID_ID", message: expect.stringContaining("is for registerPage") }),
      );
    }
    expect(() => registry.registerExtension({ id: "widget:t/p", kind: "page", attachTo: { slot: "app/routes" } })).toThrowError(
      expect.objectContaining({ code: "MISSING_FIELD", message: expect.stringContaining("kind must be one of") }),
    );
    expect(registry.getAllExtensions()).toEqual([]);
  });

  it("an extension attaches only to a slot that accepts its kind, in either declaration order", async () => {
    const registry = await import("../src/registry/registry.js");
    // Declared first: the attach is refused.
    expect(() => registry.registerExtension({ id: "pill:t/x", kind: "pill", component: () => null, attachTo: { slot: "entity:host/sections" } })).toThrowError(
      expect.objectContaining({ code: "SLOT_KIND_MISMATCH" }),
    );
    expect(() => registry.registerCard({ id: "card:t/c", slot: "app/routes", component: Component })).toThrowError(
      expect.objectContaining({ code: "SLOT_KIND_MISMATCH" }),
    );
    // Attached first: declaring a slot that would not accept it is refused.
    registry.registerExtension({ id: "pill:t/early", kind: "pill", component: () => null, attachTo: { slot: "t/cards" } });
    expect(() => registry.defineSlot({ id: "t/cards", accepts: "widget", module: "t" })).toThrowError(
      expect.objectContaining({ code: "SLOT_KIND_MISMATCH", message: expect.stringContaining('"pill:t/early" (pill)') }),
    );
    expect(registry.defineSlot({ id: "t/pills", accepts: "pill", module: "t" }).accepts).toBe("pill");
  });

  it("a slot is namespaced to its module; app/ and entity: belong to core", async () => {
    const registry = await import("../src/registry/registry.js");
    for (const slot of [
      { id: "app/footer", accepts: "widget", module: "alerts" },
      { id: "entity:host/extra", accepts: "entity-section", module: "drift" },
      { id: "portal/summary", accepts: "widget", module: "alerts" },
      { id: "app/footer", accepts: "widget", module: "app" },
    ] as const) {
      expect(() => registry.defineSlot(slot), slot.id).toThrowError(expect.objectContaining({ code: "INVALID_SLOT" }));
    }
    expect(() => registry.defineSlot({ id: "t/x", accepts: "tile" as never, module: "t" })).toThrowError(
      expect.objectContaining({ code: "INVALID_SLOT" }),
    );
    // The core-hosted slots exist from the start; a second declaration is refused.
    expect(registry.getSlot("app/routes")).toEqual({ id: "app/routes", accepts: "page", module: "core" });
    expect(() => registry.defineSlot({ id: "app/nav", accepts: "nav", module: "core" })).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_SLOT" }),
    );
  });

  it("declares every core slot the server's UI manifest lists, from the registry alone", async () => {
    const registry = await import("../src/registry/registry.js");
    const { SHELL_SLOTS } = await import("@deck/contract/modules/core");
    // The top bar's slots included: no shell module has to load first.
    expect(SHELL_SLOTS.map(({ id }) => id)).toEqual(expect.arrayContaining(["app/topbar.status", "app/topbar.actions"]));
    for (const { id, accepts } of SHELL_SLOTS) expect(registry.getSlot(id), id).toEqual({ id, accepts, module: "core" });
    expect(() => registry.defineSummarySlot({ slotId: "app/topbar.status" })).toThrowError(expect.objectContaining({ code: "DUPLICATE_SLOT" }));
    // A typed handle exists only for a declared pill slot.
    expect(registry.summarySlot("app/topbar.status")).toEqual({ slotId: "app/topbar.status" });
    for (const slotId of ["app/topbar.actions", "app/topbar.statsu"]) {
      expect(() => registry.summarySlot(slotId), slotId).toThrowError(expect.objectContaining({ code: "UNKNOWN_SLOT" }));
    }
  });

  it("notifies subscribers and bumps the version on every registration", async () => {
    const registry = await import("../src/registry/registry.js");
    const listener = vi.fn();
    const unsubscribe = registry.subscribeRegistry(listener);
    const before = registry.getRegistryVersion();
    registry.registerPage({ id: "page:t/one", path: "/one", label: "One", component: Component });
    // A listed page is two extensions (page + nav).
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.getRegistryVersion()).toBe(before + 2);
    unsubscribe();
    registry.registerCard({ id: "card:t/two", slot: "s", component: Component });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("review round 1 regressions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("C1: a card view takes identity, slot and order from the extension, never from its config", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerCard({ id: "card:probe/incumbent", slot: "probe/cards", component: Component });
    registry.registerExtension({
      id: "widget:probe/new",
      kind: "widget",
      attachTo: { slot: "probe/cards" },
      config: { id: "card:probe/incumbent", slot: "elsewhere", order: 1, providerId: "docker", extra: true },
      component: Component,
    });
    const cards = registry.getCards("probe/cards");
    expect(cards.map(({ id }) => id)).toEqual(["card:probe/incumbent", "widget:probe/new"]);
    expect(cards[1]).toEqual({ id: "widget:probe/new", slot: "probe/cards", providerId: "docker", component: Component });
  });

  it("L1: every kind but nav needs a component", async () => {
    const registry = await import("../src/registry/registry.js");
    const slot = registry.defineSummarySlot({ slotId: "core/status" });
    expect(() => registry.registerExtension({ id: "pill:x/y", kind: "pill", attachTo: { slot: slot.slotId } })).toThrowError(
      expect.objectContaining({ code: "MISSING_FIELD", message: expect.stringContaining('"component" must be a component') }),
    );
    expect(registry.getExtensions(slot.slotId)).toEqual([]);
  });

  it.each(["probe/", "probe/bad name", "probe//cards", "probe/Cards", "other/cards"])("L2: rejects slot id %s like the server", async (id) => {
    const registry = await import("../src/registry/registry.js");
    expect(() => registry.defineSlot({ id, accepts: "widget", module: "probe" })).toThrowError(
      expect.objectContaining({ code: "INVALID_SLOT", message: expect.stringContaining('must be namespaced to its module ("probe/<name>")') }),
    );
  });

  it.each(["probe/cards", "probe/cards/nested", "probe/v1.side"])("L2: accepts slot id %s", async (id) => {
    const registry = await import("../src/registry/registry.js");
    expect(registry.defineSlot({ id, accepts: "widget", module: "probe" }).id).toBe(id);
  });

  it("L2: an order must be finite", async () => {
    const registry = await import("../src/registry/registry.js");
    for (const order of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => registry.registerCard({ id: "card:x/c", slot: "x/s", order, component: Component })).toThrowError(
        expect.objectContaining({ code: "INVALID_FIELD", message: expect.stringContaining("must be a finite number") }),
      );
      expect(() => registry.registerPage({ id: "page:x/p", path: "/p", label: "P", order, component: Component })).toThrowError(
        expect.objectContaining({ code: "INVALID_FIELD" }),
      );
    }
    expect(registry.getAllExtensions()).toEqual([]);
  });

  it.each([
    ["/api/health", "is under /api"],
    ["/api", "is under /api"],
    ["/metrics", "reserved root path"],
    ["relative", 'must start with "/"'],
  ])("L2: rejects page path %s, page and nav alike", async (path, problem) => {
    const registry = await import("../src/registry/registry.js");
    expect(() => registry.registerPage({ id: "page:x/p", path, label: "P", component: Component })).toThrowError(
      expect.objectContaining({ code: "INVALID_FIELD", message: expect.stringContaining(problem) }),
    );
    expect(registry.getAllExtensions()).toEqual([]);
  });

  it("L2: an attachment to a slot nobody declared is reported as an orphan", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerExtension({ id: "pill:x/typo", kind: "pill", attachTo: { slot: "app/topbar.statsu" }, component: Component });
    registry.registerCard({ id: "card:x/ok", slot: "x/cards", component: Component });
    registry.defineSlot({ id: "x/cards", accepts: "widget", module: "x" });
    expect(registry.getOrphanAttachments()).toEqual([{ id: "pill:x/typo", slot: "app/topbar.statsu" }]);
  });
});

describe("open entity sections", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("groups fragments by section, in the order of each section's first fragment", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerEntityFragment({ id: "section:b/late", entity: "host", title: "Late", order: 30, component: Component });
    registry.registerEntityFragment({ id: "section:a/find-2", entity: "host", title: "Ignored", section: "findings", order: 15, component: Component });
    registry.registerEntityFragment({ id: "section:a/find-1", entity: "host", title: "Findings", section: "findings", order: 10, component: Component });
    registry.registerEntityFragment({ id: "section:c/backups", entity: "host", title: "Backups", order: 12, component: Component });
    registry.registerEntityFragment({ id: "section:c/svc", entity: "service", title: "Service only", component: Component });

    const sections = registry.getEntitySections("host").map(({ section, title, fragments }) => ({ section, title, ids: fragments.map(({ id }) => id) }));
    expect(sections).toEqual([
      // The first fragment (by order) heads the section; a later one's title is not shown.
      { section: "findings", title: "Findings", ids: ["section:a/find-1", "section:a/find-2"] },
      // A fragment naming no section has one of its own, scoped to its module: `<module>.<name>`.
      { section: "c.backups", title: "Backups", ids: ["section:c/backups"] },
      { section: "b.late", title: "Late", ids: ["section:b/late"] },
    ]);
    expect(registry.getEntitySections("service").map(({ section }) => section)).toEqual(["c.svc"]);
    expect(registry.getEntityFragments("host", "c.backups").map(({ id }) => id)).toEqual(["section:c/backups"]);
  });

  it("never merges two modules' implicit sections that share an id name", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerEntityFragment({ id: "section:backups/host", entity: "host", title: "Backups", component: Component });
    registry.registerEntityFragment({ id: "section:audit/host", entity: "host", title: "Audit", component: Component });
    expect(registry.getEntitySections("host").map(({ section, title }) => `${section} ${title}`)).toEqual([
      "audit.host Audit",
      "backups.host Backups",
    ]);
  });

  it("lists sections on one page that share a title (a fragment sharing a section is not one)", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", title: "Findings", section: "findings", order: 10, component: Component });
    registry.registerEntityFragment({ id: "section:lint/host", entity: "host", title: "Findings", section: "findings", order: 30, component: Component });
    expect(registry.getDuplicateEntitySectionTitles()).toEqual([]);
    registry.registerEntityFragment({ id: "section:audit/host", entity: "host", title: "Findings", order: 20, component: Component });
    // The service page is separate: the same title there is no clash with the host page.
    registry.registerEntityFragment({ id: "section:audit/service", entity: "service", title: "Findings", component: Component });
    expect(registry.getDuplicateEntitySectionTitles()).toEqual([{ entity: "host", title: "Findings", sections: ["findings", "audit.host"] }]);
  });

  it("discovery warns in development about duplicate section titles, and the built-ins have none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await import("../src/shell/health-header/slot.js");
      const registry = await import("../src/registry/registry.js");
      registry.registerEntityFragment({ id: "section:audit/host", entity: "host", title: "Findings", order: 50, component: Component });
      await import("../src/registry/discover.js");
      expect(warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("share the title"))).toEqual([
        '[deck] host page sections "findings", "audit.host" share the title "Findings"; give each its own',
      ]);
    } finally {
      warn.mockRestore();
    }
    vi.resetModules();
    await import("../src/shell/health-header/slot.js");
    await import("../src/registry/discover.js");
    const registry = await import("../src/registry/registry.js");
    expect(registry.getDuplicateEntitySectionTitles()).toEqual([]);
  });

  it("cannot join or retitle another extension's own section by naming it", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerEntityFragment({ id: "section:backups/host", entity: "host", title: "Backups", component: Component });
    expect(() =>
      registry.registerEntityFragment({ id: "section:evil/host", entity: "host", title: "Hijacked", section: "backups.host", order: 0, component: Component }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FIELD", message: expect.stringContaining("dotted names are reserved") }));
    expect(registry.getEntitySections("host").map(({ section, title, fragments }) => `${section} ${title} ${fragments.length}`)).toEqual([
      "backups.host Backups 1",
    ]);
  });

  it("joins a shared section only when it is named explicitly", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", title: "Findings", section: "findings", order: 10, component: Component });
    // Named like the shared section, but implicit: a section of its own.
    registry.registerEntityFragment({ id: "section:audit/findings", entity: "host", title: "Audit", order: 20, component: Component });
    // Explicit: renders under drift's Findings heading.
    registry.registerEntityFragment({ id: "section:lint/host", entity: "host", title: "Lint", section: "findings", order: 30, component: Component });
    expect(registry.getEntitySections("host").map(({ section, title, fragments }) => ({ section, title, ids: fragments.map(({ id }) => id) }))).toEqual([
      { section: "findings", title: "Findings", ids: ["section:drift/host-findings", "section:lint/host"] },
      { section: "audit.findings", title: "Audit", ids: ["section:audit/findings"] },
    ]);
  });

  it.each([
    [undefined, "needs a title"],
    [{}, "needs a title"],
    [{ title: { text: "Findings" } }, "needs a title"],
    [{ title: "Findings", section: "Find ings" }, "lowercase name"],
  ])("refuses a generic entity-section registration with config %j before changing the registry", async (config, problem) => {
    const registry = await import("../src/registry/registry.js");
    const listener = vi.fn();
    registry.subscribeRegistry(listener);
    const before = registry.getRegistryVersion();
    expect(() =>
      registry.registerExtension({
        id: "section:x/generic",
        kind: "entity-section",
        attachTo: { slot: "entity:host/sections" },
        component: Component,
        ...(config === undefined ? {} : { config: config as Record<string, unknown> }),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FIELD", message: expect.stringContaining(problem) }));
    expect(registry.getAllExtensions()).toEqual([]);
    expect(registry.getRegistryVersion()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    [{ title: "" }, "needs a title"],
    [{ title: "   " }, "needs a title"],
    [{ title: "Findings", section: "Find ings" }, "lowercase name"],
  ])("rejects an unusable section %j, like the server's manifest check", async (fields, problem) => {
    const registry = await import("../src/registry/registry.js");
    const thrown = (() => {
      try {
        registry.registerEntityFragment({ id: "section:x/s", entity: "host", component: Component, ...fields });
      } catch (error) {
        return error as Error & { code: string };
      }
      return null;
    })();
    expect(thrown).toMatchObject({ code: "INVALID_FIELD", message: expect.stringContaining(problem) });
    // The error names the blueprint the module called, not the shared core.
    expect(thrown?.message).toMatch(/^registerEntityFragment\(section:x\/s\): /);
    expect(registry.getAllExtensions()).toEqual([]);
  });
});

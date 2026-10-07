import { beforeEach, describe, expect, it, vi } from "vitest";

const Component = () => null;

describe("registration contract", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers and reads all four registration kinds", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "home", path: "/", label: "Home", component: Component });
    registry.registerCard({ id: "portal", slot: "home", component: Component });
    registry.registerEntityFragment({ id: "host", entity: "host", component: Component });
    const slot = registry.defineSummarySlot<{ label: string }>({ slotId: "health" });
    registry.registerSummaryFragment(slot, { id: "summary", component: Component });

    expect(registry.getPages().map(({ id }) => id)).toEqual(["home"]);
    expect(registry.getCards("home").map(({ id }) => id)).toEqual(["portal"]);
    expect(registry.getEntityFragments("host").map(({ id }) => id)).toEqual(["host"]);
    expect(registry.getSummaryFragments(slot).map(({ id }) => id)).toEqual(["summary"]);
  });

  it("sorts new accessor arrays by order then id regardless of registration order", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "z", path: "/z", label: "Z", component: Component });
    registry.registerPage({ id: "late", path: "/late", label: "Late", component: Component, order: 200 });
    registry.registerPage({ id: "a", path: "/a", label: "A", component: Component });
    registry.registerPage({ id: "first", path: "/first", label: "First", component: Component, order: 0 });

    const firstRead = registry.getPages();
    expect(firstRead.map(({ id }) => id)).toEqual(["first", "a", "z", "late"]);
    expect(registry.getPages()).not.toBe(firstRead);
  });

  it("sorts filtered card, entity, and summary accessors", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerCard({ id: "b", slot: "target", component: Component });
    registry.registerCard({ id: "ignored", slot: "other", component: Component, order: 0 });
    registry.registerCard({ id: "a", slot: "target", component: Component });
    registry.registerEntityFragment({ id: "b", entity: "host", slot: "details", component: Component });
    registry.registerEntityFragment({ id: "a", entity: "host", slot: "details", component: Component });
    const slot = registry.defineSummarySlot<Record<string, never>>({ slotId: "summary" });
    registry.registerSummaryFragment(slot, { id: "b", component: Component });
    registry.registerSummaryFragment(slot, { id: "a", component: Component });

    expect(registry.getCards("target").map(({ id }) => id)).toEqual(["a", "b"]);
    expect(registry.getEntityFragments("host", "details").map(({ id }) => id)).toEqual(["a", "b"]);
    expect(registry.getSummaryFragments(slot).map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("preserves optional nav without changing validation behavior", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "visible", path: "/visible", label: "Visible", component: Component });
    registry.registerPage({
      id: "hidden",
      path: "/hidden/:name",
      label: "Hidden",
      component: Component,
      nav: false,
    });

    const pages = registry.getPages();
    const visible = pages.find(({ id }) => id === "visible")!;
    const hidden = pages.find(({ id }) => id === "hidden")!;
    expect(visible.nav).toBeUndefined();
    expect(hidden.nav).toBe(false);
    // nav is not required for registration validation to succeed.
    expect(pages.map(({ id }) => id)).toEqual(["hidden", "visible"]);
  });

  it("throws UNKNOWN_SLOT for an undeclared summary slot", async () => {
    const registry = await import("../src/registry/registry.js");
    expect(() =>
      registry.registerSummaryFragment({ slotId: "missing" }, { id: "fragment", component: Component }),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_SLOT" }));
  });

  it("throws MISSING_FIELD for malformed registrations", async () => {
    const registry = await import("../src/registry/registry.js");
    expect(() => registry.registerPage({ path: "/", label: "Home", component: Component } as any)).toThrowError(
      expect.objectContaining({ code: "MISSING_FIELD" }),
    );
  });

  it("throws for duplicate ids and slot ids", async () => {
    const registry = await import("../src/registry/registry.js");
    registry.registerPage({ id: "same", path: "/", label: "Home", component: Component });
    expect(() =>
      registry.registerPage({ id: "same", path: "/other", label: "Other", component: Component }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
    registry.defineSummarySlot({ slotId: "same" });
    expect(() => registry.defineSummarySlot({ slotId: "same" })).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_SLOT" }),
    );
  });
});

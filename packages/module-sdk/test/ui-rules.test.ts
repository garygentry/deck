import { describe, expect, it } from "vitest";

import {
  entitySectionName,
  entitySectionProblem,
  extensionIdProblem,
  isKernelSlot,
  isSafeHref,
  orderProblem,
  pagePathProblem,
  routablePathProblem,
  parseExtensionId,
  slotAcceptsProblem,
  slotIdProblem,
} from "../src/index.js";

describe("shared UI rules", () => {
  it("parses and checks extension ids", () => {
    expect(parseExtensionId("pill:llm-usage/summary")).toEqual({ kind: "pill", module: "llm-usage", name: "summary" });
    expect(parseExtensionId("summary")).toBeNull();
    expect(extensionIdProblem("pill:a/b", { module: "a" })).toBeNull();
    expect(extensionIdProblem("pill:a/b", { module: "c" })).toMatch(/must name its own module/);
    expect(extensionIdProblem("nav:a/b", { kind: "page" })).toMatch(/must start with "page:"/);
    expect(extensionIdProblem("page:a/b")).toMatch(/only page declarations may use/);
  });

  it("namespaces slots, reserving app/ and entity: for the kernel", () => {
    expect(slotIdProblem("a/b/c", "a")).toBeNull();
    expect(slotIdProblem("a/", "a")).toMatch(/namespaced/);
    expect(slotIdProblem("a//b", "a")).toMatch(/namespaced/);
    expect(slotIdProblem("app/nav", "a")).toMatch(/kernel-reserved/);
    expect(slotIdProblem("app/nav", "core", { kernel: true })).toBeNull();
    expect(slotAcceptsProblem("tile", "a/b")).toMatch(/accepts must be one of/);
    expect(isKernelSlot("app/topbar.status")).toBe(true);
    expect(isKernelSlot("entity:host/sections")).toBe(true);
    expect(isKernelSlot("portal/summary")).toBe(false);
    expect(isKernelSlot("apps/x")).toBe(false);
  });

  it("checks orders, page paths and hrefs", () => {
    expect(orderProblem(undefined, "o")).toBeNull();
    expect(orderProblem(Number.NaN, "o")).toMatch(/finite/);
    expect(pagePathProblem("/lab", "p")).toBeNull();
    expect(pagePathProblem("/api/x", "p")).toMatch(/under \/api/);
    expect(pagePathProblem("/metrics", "p")).toMatch(/reserved root path/);
    expect(pagePathProblem("/metrics", "p", [])).toBeNull();
    expect(pagePathProblem("/kernel.txt", "p", ["/kernel.txt"])).toMatch(/reserved root path/);
    // Only patterns the web router can compile: a stray bracket or group throws there.
    for (const ok of ["/", "/hosts/:name", "/tools/", "/files/:rest*", "/a//b", "/%20x", "/files/*", "/a/:b?", "/v1.2/x~y"]) {
      expect(pagePathProblem(ok, "p")).toBeNull();
    }
    for (const bad of ["/tools/[", "/x(y", "/a/:b.("]) {
      expect(pagePathProblem(bad, "p")).toMatch(/not a route pattern the web router can compile/);
    }
    expect(routablePathProblem("/tools/[", "p")).toMatch(/can compile/);
    expect(routablePathProblem("/tools/", "p")).toBeNull();
    expect(isSafeHref("https://x.lab")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("//evil")).toBe(false);
  });

  it("checks an entity section's title and section name", () => {
    expect(entitySectionProblem({ title: "Findings" }, "e")).toBeNull();
    expect(entitySectionProblem({ title: "Findings", section: "findings" }, "e")).toBeNull();
    expect(entitySectionProblem(undefined, "e")).toMatch(/needs a title/);
    expect(entitySectionProblem({ section: "findings" }, "e")).toMatch(/needs a title/);
    expect(entitySectionProblem({ title: "  " }, "e")).toMatch(/needs a title/);
    expect(entitySectionProblem({ title: "T", section: "Bad Name" }, "e")).toMatch(/lowercase name/);
    expect(entitySectionProblem({ title: "T", section: "" }, "e")).toMatch(/lowercase name/);
    expect(entitySectionProblem({ title: "T", section: 3 }, "e")).toMatch(/lowercase name/);
  });

  it("scopes an implicit entity section to its module; an explicit one is shared as named", () => {
    expect(entitySectionName("section:backups/host", { title: "B" })).toBe("backups.host");
    expect(entitySectionName("section:audit/host", { title: "A" })).toBe("audit.host");
    // An id named like a shared section does not join it implicitly.
    expect(entitySectionName("section:audit/findings", { title: "A" })).toBe("audit.findings");
    expect(entitySectionName("section:audit/findings", { title: "A", section: "findings" })).toBe("findings");
    expect(entitySectionName("bad", { title: "A" })).toBeNull();
  });

  it("reserves dotted section names for implicit sections, so an extension's own section cannot be joined", () => {
    // Explicitly naming backups' own section is refused…
    expect(entitySectionProblem({ title: "Hijack", section: "backups.host" }, "e")).toMatch(/dotted names are reserved/);
    // …while explicit-to-explicit sharing is fine.
    expect(entitySectionProblem({ title: "Lint", section: "findings" }, "e")).toBeNull();
    expect(entitySectionProblem({ title: "Lint", section: "owned-configs" }, "e")).toBeNull();
  });
});

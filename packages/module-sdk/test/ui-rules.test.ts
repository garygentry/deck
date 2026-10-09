import { describe, expect, it } from "vitest";

import {
  contributedIconsProblem,
  MAX_ICON_BYTES,
  MAX_MODULE_ICONS,
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
    expect(pagePathProblem("/modules", "p")).toMatch(/under \/modules/);
    expect(pagePathProblem("/modules/x", "p")).toMatch(/under \/modules/);
    expect(pagePathProblem("/modulesx", "p")).toBeNull();
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

  it("refuses a link a browser would take off this origin: spaces, controls and backslashes", () => {
    expect(isSafeHref("/hosts/nas-01?q=a%20b#x")).toBe(true);
    expect(isSafeHref("https://vendor.example/ups")).toBe(true);
    for (const href of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\r\n/evil.example", "/\\evil.example", "/x\\..\\..\\evil", "//evil.example", "/ /evil.example", "/hosts\u0000", "/hosts\u007f", "https://ok.example/\tx", " /hosts", "https:\\\\evil.example"]) {
      expect(isSafeHref(href), JSON.stringify(href)).toBe(false);
    }
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

describe("contributedIconsProblem", () => {
  const svg = '<svg viewBox="0 0 24 24"><path d="M1 1h22"/></svg>';

  it("accepts up to the bounds, named <module>/<kebab-name>", () => {
    expect(contributedIconsProblem("mod", undefined)).toBeNull();
    expect(contributedIconsProblem("mod", { "mod/wrench": svg, "mod/a-2": `  ${svg}` })).toBeNull();
    const many = Object.fromEntries(Array.from({ length: MAX_MODULE_ICONS }, (_, index) => [`mod/i${index}`, svg]));
    expect(contributedIconsProblem("mod", many)).toBeNull();
    expect(contributedIconsProblem("mod", { "mod/big": `<svg>${"x".repeat(MAX_ICON_BYTES - 11)}</svg>` })).toBeNull();
  });

  it("refuses more icons, larger icons, other names and non-SVG markup", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_MODULE_ICONS + 1 }, (_, index) => [`mod/i${index}`, svg]));
    expect(contributedIconsProblem("mod", many)).toMatch(/more than 64/);
    expect(contributedIconsProblem("mod", { "mod/big": `<svg>${"x".repeat(MAX_ICON_BYTES - 10)}</svg>` })).toMatch(/larger than 16384 bytes/);
    // Bytes, not characters.
    expect(contributedIconsProblem("mod", { "mod/big": `<svg>${"é".repeat(MAX_ICON_BYTES / 2)}</svg>` })).toMatch(/larger than/);
    for (const name of ["wrench", "other/wrench", "mod/Wrench", "mod/", "mod/a/b"]) {
      expect(contributedIconsProblem("mod", { [name]: svg }), name).toMatch(/must be named mod\/<kebab-name>/);
    }
    for (const markup of [42, "<div></div>", "<svgx>", "<?xml version='1.0'?><svg/>"]) {
      expect(contributedIconsProblem("mod", { "mod/x": markup }), String(markup)).toMatch(/must be SVG markup/);
    }
    expect(contributedIconsProblem("mod", ["x"])).toMatch(/must be an object/);
  });
});

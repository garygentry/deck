/**
 * The portal module's real config wiring (its manifest's schema, ownership, identity rows,
 * group-id namespace and service references), driven through `load()` as boot and
 * `deck validate` see it, and through the shared invalid fixtures. These are the checks the
 * kernel used to run on `modules.portal.groups` itself; every finding keeps its code,
 * pointer and message.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PORTAL_UI } from "@deck/contract/modules/portal";
import { afterEach, describe, expect, it } from "vitest";

import { composeDefault, FINDING_CATALOG, merge, resolveOwner, validate, type JsonObject } from "@deck/schema";
import { invalid as invalidFixtures } from "@deck/schema/fixtures";

import { load } from "../src/config/load.js";
import { builtinComposition } from "../src/modules/config.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { PORTAL_MANIFEST, portalModule } from "../src/portal/module.js";
import portalSchema from "../src/portal/schema.json" with { type: "json" };
import { KERNEL_FEATURES } from "../src/ui/kernel-features.js";
import { makeConfigDir } from "./util/tmp-config.js";

/** What deck validates with: the kernel composed with the built-in modules. */
const { composed } = builtinComposition({ sectionOf: () => undefined, env: {} });

const temporary: Array<() => void> = [];
afterEach(() => {
  while (temporary.length) temporary.pop()!();
});

const BASE = {
  schemaVersion: 2,
  estate: { name: "portal-config" },
  hosts: [{ name: "apps", kind: "vm", purpose: "Application host" }],
  services: [{ host: "apps", name: "portal", kind: "docker-compose", purpose: "Home dashboard" }],
};
const service = (host: string, name: string) => ({ type: "service", host, name });
const link = (href: string) => ({ type: "link", title: href, href });
const group = (id: string, items: unknown[] = []) => ({ id, title: id, items });
const subgroup = (id: string, items: unknown[] = []) => ({ type: "group", id, title: id, items });
const overlay = (groups: unknown[]) => ({ schemaVersion: 2, modules: { portal: { groups } } });

function estate(layers: Record<string, unknown>): string {
  const { dir, cleanup } = makeConfigDir(layers);
  temporary.push(cleanup);
  return dir;
}

/** Each probe: the layers, and the finding it must raise (code, pointer, message); every one fails validation. */
const BROKEN: ReadonlyArray<[label: string, layers: Record<string, unknown>, code: string, path: string, message: string]> = [
  [
    "a group id repeated at the top level",
    { "00-base.yaml": BASE, "10-overlay.yaml": overlay([group("same"), group("same")]) },
    "ID_DUPLICATE", "/modules/portal/groups/1",
    'Group or subgroup id "same" is used more than once across the groups tree.',
  ],
  [
    "a subgroup reusing a group id declared later in the tree",
    { "00-base.yaml": BASE, "10-overlay.yaml": overlay([group("a", [subgroup("x")]), group("x")]) },
    "ID_DUPLICATE", "/modules/portal/groups/1",
    'Group or subgroup id "x" is used more than once across the groups tree.',
  ],
  [
    "a subgroup reusing an earlier group's id",
    { "00-base.yaml": BASE, "10-overlay.yaml": overlay([group("x"), group("b", [subgroup("x")])]) },
    "ID_DUPLICATE", "/modules/portal/groups/1/items/0",
    'Group or subgroup id "x" is used more than once across the groups tree.',
  ],
  [
    "an unresolved service item",
    { "00-base.yaml": BASE, "10-overlay.yaml": overlay([group("g", [service("apps", "gone")])]) },
    "REF_SERVICE_UNRESOLVED", "/modules/portal/groups/0/items/0",
    "service reference at /modules/portal/groups/0/items/0 does not resolve",
  ],
  [
    "an unresolved service item inside a subgroup",
    { "00-base.yaml": BASE, "10-overlay.yaml": overlay([group("g", [subgroup("s", [link("https://x.test"), service("nowhere", "portal")])])]) },
    "REF_SERVICE_UNRESOLVED", "/modules/portal/groups/0/items/0/items/1",
    "service reference at /modules/portal/groups/0/items/0/items/1 does not resolve",
  ],
  [
    "an overlay service item dangling from the base",
    { "00-base.yaml": BASE, "10-overlay.yaml": overlay([group("g", [service("apps", "gone")])]) },
    "OVERLAY_DANGLING_REF", "/modules/portal/groups/0/items/0",
    "overlay reference at /modules/portal/groups/0/items/0 does not resolve against the base layer",
  ],
  [
    "the groups in the base layer",
    { "00-base.yaml": { ...BASE, modules: { portal: { groups: [group("g")] } } } },
    "LAYER_OVERLAY_KEY_IN_BASE", "/modules/portal/groups/0/id",
    "overlay-owned value is present in the base layer at /modules/portal/groups/0/id",
  ],
];

describe("modules.portal through the portal module", () => {
  it.each(BROKEN)("fails %s with exit 1, exactly as the kernel reported it", (_label, layers, code, path, message) => {
    for (const disabledSections of ["advisory", "strict"] as const) {
      const result = load({ arg: estate(layers), env: {}, disabledSections });
      expect(result.exitClass).toBe(1);
      expect(result.findings).toContainEqual(expect.objectContaining({
        code,
        path,
        message,
        severity: FINDING_CATALOG[code as keyof typeof FINDING_CATALOG].severity,
      }));
    }
  });

  it("rejects a nested subgroup against the module's schema (exit 2)", () => {
    const result = load({ arg: estate({ "00-base.yaml": BASE, "10-overlay.yaml": overlay([group("g", [subgroup("s", [subgroup("t")])])]) }), env: {} });
    expect(result.exitClass).toBe(2);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "SCHEMA_INVALID", path: "/modules/portal/groups/0/items/0/items/0" }));
  });

  it("accepts a group repeating a service and a link, as v1 did (portal-repeated-items)", () => {
    expect(load({ arg: "test/fixtures/portal-repeated-items", env: {} })).toMatchObject({ exitClass: 0, findings: [] });
  });

  it("accepts a subgroup repeating a service and a link too: the id namespace covers every items row (L3)", () => {
    const groups = [group("g", [subgroup("s", [service("apps", "portal"), service("apps", "portal"), link("https://a.test"), link("https://a.test")])])];
    expect(load({ arg: estate({ "00-base.yaml": BASE, "10-overlay.yaml": overlay(groups) }), env: {}, disabledSections: "strict" })).toMatchObject({ exitClass: 0, findings: [] });
  });

  it.each(["$&", "$'", "$`", "$$", "a$'b"])("names a repeated group id %j literally, as the kernel did (C2/L2)", (id) => {
    const result = load({ arg: estate({ "00-base.yaml": BASE, "10-overlay.yaml": overlay([group(id), group(id)]) }), env: {} });
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "ID_DUPLICATE",
      path: "/modules/portal/groups/1",
      message: `Group or subgroup id ${JSON.stringify(id)} is used more than once across the groups tree.`,
    }));
  });

  it("accepts resolved service items at both levels, links and subgroups", () => {
    const groups = [group("a", [service("apps", "portal"), link("https://a.test"), subgroup("s", [service("apps", "portal"), link("https://b.test")])]), group("b")];
    expect(load({ arg: estate({ "00-base.yaml": BASE, "10-overlay.yaml": overlay(groups) }), env: {} })).toMatchObject({ exitClass: 0, findings: [] });
  });

  /** Where each shared portal fixture's finding points, as the kernel rules reported it. */
  const FIXTURE_PATHS: Record<string, string> = {
    ID_DUPLICATE: "/modules/portal/groups/1",
    REF_SERVICE_UNRESOLVED: "/modules/portal/groups/0/items/0",
    LAYER_OVERLAY_KEY_IN_BASE: "/modules/portal/groups/0/id",
    OVERLAY_DANGLING_REF: "/modules/portal/groups/0/items/0",
  };

  it("keeps the shared invalid fixtures' portal findings, at their pointer and catalogued severity", () => {
    const portalFixtures = invalidFixtures.filter((fixture) =>
      [fixture.document, fixture.base].some((layer) => (layer?.modules as JsonObject | undefined)?.portal !== undefined));
    expect(portalFixtures.map(({ expect: code }) => code).sort()).toEqual(
      ["ID_DUPLICATE", "LAYER_OVERLAY_KEY_IN_BASE", "OVERLAY_DANGLING_REF", "REF_SERVICE_UNRESOLVED"],
    );
    for (const fixture of portalFixtures) {
      if (fixture.layer === "snapshot") throw new Error(`${fixture.name} is a snapshot fixture`);
      const result = validate(fixture.document, { layer: fixture.layer, composed, ...(fixture.base ? { base: fixture.base } : {}) });
      expect(result.classification, fixture.name).not.toBe(2);
      expect(result.findings, fixture.name).toContainEqual(expect.objectContaining({
        code: fixture.expect,
        path: FIXTURE_PATHS[fixture.expect],
        severity: composed.catalog[fixture.expect]!.severity,
      }));
    }
  });
});

describe("kernel files no longer name the portal", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
    });
  // Registering the built-ins names them, and the v1 → v2 migration maps the v1 `groups` key.
  const EXEMPT = new Set(["apps/server/src/modules/builtin.ts", "apps/server/src/config/migrate.ts"]);
  const kernelFiles = [
    "packages/schema/src",
    "apps/server/src/server",
    "apps/server/src/ui",
    "apps/server/src/modules",
    "apps/server/src/config",
    "apps/server/src/cli",
    "apps/server/src/log",
    "apps/server/src/contract",
  ]
    .flatMap((dir) => walk(join(repo, dir)))
    .map((path) => relative(repo, path))
    .filter((path) => !path.startsWith("packages/schema/src/fixtures/") && !EXEMPT.has(path));

  it("scans the kernel's schema, server and UI files", () => {
    expect(kernelFiles).toEqual(expect.arrayContaining([
      "packages/schema/src/validate/context.ts",
      "packages/schema/src/compose/builtin.ts",
      "apps/server/src/ui/kernel-features.ts",
    ]));
  });

  it.each(kernelFiles)("%s", (file) => {
    expect(readFileSync(join(repo, file), "utf8")).not.toMatch(/\bportal\b|GROUPS_POINTER|PortalModuleConfig/i);
  });
});

describe("the portal is a built-in module", () => {
  it("is built in, and the kernel composition alone no longer knows modules.portal", () => {
    expect(BUILTIN_MODULES).toContain(portalModule);
    expect(composeDefault().knownModuleIds).not.toContain("portal");
    const kernelOnly = validate({ schemaVersion: 2, estate: { name: "x" }, modules: { portal: { groups: [] } } });
    expect(kernelOnly.classification).toBe(1);
  });

  it("owns its UI entries: the kernel features no longer list them", () => {
    expect(KERNEL_FEATURES.map(({ manifest }) => manifest.id)).not.toContain("portal");
    expect(PORTAL_MANIFEST.contributes?.pages?.map(({ id }) => id)).toEqual(["page:portal/overview"]);
    expect(PORTAL_MANIFEST.contributes?.nav?.map(({ id }) => id)).toEqual(["nav:portal/overview"]);
    expect(PORTAL_MANIFEST.contributes?.slots?.map(({ id }) => id)).toEqual(["portal/summary"]);
    expect(PORTAL_MANIFEST.contributes?.extensions?.map(({ id }) => id)).toEqual(["pill:portal/endpoints"]);
  });

  it("takes its identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes } = PORTAL_MANIFEST;
    expect({ id, version, deckApi, contributes }).toEqual(PORTAL_UI);
    expect(contributes).toBe(PORTAL_UI.contributes);
  });
});

/** The checks the schema library ran on the portal section while the kernel carried it. */
describe("modules.portal: checks that moved from the schema library", () => {
  const host = (name: string, extra: Record<string, unknown> = {}) => ({ name, kind: "vm", purpose: "test host", ...extra });
  const svc = (hostName: string, name: string, extra: Record<string, unknown> = {}) => ({ host: hostName, name, kind: "systemd", purpose: "test service", ...extra });
  const codes = (result: ReturnType<typeof validate>) => result.findings.map((item) => item.code);
  const estateBase: JsonObject = {
    schemaVersion: 2,
    estate: { name: "atlas" },
    hosts: [host("alpha")],
    services: [svc("alpha", "api")],
  };

  it("reports a group id repeated across the tree once, and as ID_DUPLICATE", () => {
    const repeated = validate({ schemaVersion: 2, estate: { name: "e" }, modules: { portal: { groups: [group("g"), group("g")] } } }, { composed });
    expect(repeated.findings.filter(({ code }) => code === "ID_DUPLICATE")).toHaveLength(1);
    const nested = validate({
      schemaVersion: 2,
      estate: { name: "test" },
      modules: { portal: { groups: [group("same"), group("two", [subgroup("same")])] } },
    }, { composed });
    expect(codes(nested)).toContain("ID_DUPLICATE");
  });

  it("accepts repeated service and link items in one group (N1)", () => {
    const document = {
      schemaVersion: 2,
      estate: { name: "e" },
      hosts: [host("h")],
      services: [svc("h", "s")],
      modules: { portal: { groups: [group("g", [service("h", "s"), service("h", "s"), link("https://a.invalid"), link("https://a.invalid")])] } },
    };
    expect(validate(document, { composed })).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
  });

  it("checks service items while treating hidden entities as valid targets", () => {
    const valid = {
      schemaVersion: 2,
      estate: { name: "test" },
      hosts: [host("alpha", { hidden: true })],
      services: [svc("alpha", "api", { hidden: true })],
      modules: { portal: { groups: [{ id: "main", title: "main", items: [{ type: "service", host: "alpha", name: "api" }] }] } },
    };
    expect(validate(valid, { composed }).classification).toBe(0);
    const invalid = structuredClone(valid);
    invalid.modules.portal.groups[0]!.items[0]!.name = "missing";
    expect(validate(invalid, { composed })).toMatchObject({ classification: 1, findings: [{ code: "REF_SERVICE_UNRESOLVED", path: "/modules/portal/groups/0/items/0" }] });
  });

  it("holds even an empty groups list to the overlay layer", () => {
    expect(codes(validate({ ...estateBase, modules: { portal: { groups: [] } } }, { layer: "base", composed }))).toContain("LAYER_OVERLAY_KEY_IN_BASE");
    expect(resolveOwner("modules.portal.groups[].items[].title", composed.ownership)).toBe("overlay");
  });

  it("resolves overlay items to base-only services without re-declaring them", () => {
    const overlay: JsonObject = {
      schemaVersion: 2,
      modules: { portal: { groups: [{
        id: "main",
        title: "Main",
        items: [
          { type: "service", host: "alpha", name: "api", title: "API" },
          { type: "group", id: "nested", title: "Nested", items: [{ type: "service", host: "alpha", name: "api" }] },
        ],
      }] } },
    };
    const perLayer = validate(overlay, { layer: "overlay", base: estateBase, composed });
    expect(codes(perLayer)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^REF_/)]));
    expect(perLayer.classification).toBe(0);
    // Without a base, an overlay falls back to per-layer checking, so a base-only item is flagged.
    const standalone = validate(overlay, { layer: "overlay", composed });
    expect(standalone.classification).toBe(1);
    expect(codes(standalone)).toContain("REF_SERVICE_UNRESOLVED");
    const merged = validate(merge(estateBase, overlay, composed), { layer: "merged", composed });
    expect(merged.classification).toBe(0);
    for (const code of ["REF_HOST_UNRESOLVED", "REF_SERVICE_UNRESOLVED"]) expect(codes(merged)).not.toContain(code);
  });

  it("still fails an item whose service no layer declares", () => {
    const overlay: JsonObject = {
      schemaVersion: 2,
      modules: { portal: { groups: [{ id: "main", title: "Main", items: [{ type: "service", host: "ghost", name: "api" }] }] } },
    };
    const perLayer = validate(overlay, { layer: "overlay", base: estateBase, composed });
    expect(perLayer.classification).toBe(1);
    expect(perLayer.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OVERLAY_DANGLING_REF", path: "/modules/portal/groups/0/items/0" }),
    ]));
    const merged = validate(merge(estateBase, overlay, composed), { layer: "merged", composed });
    expect(merged.classification).toBe(1);
    expect(merged.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REF_SERVICE_UNRESOLVED", path: "/modules/portal/groups/0/items/0" }),
    ]));
  });

  it("pairs groups across layers by id when merging", () => {
    const base: JsonObject = { ...estateBase, modules: { portal: { groups: [{ id: "main", title: "Base", items: [{ type: "service", host: "alpha", name: "api" }] }] } } };
    const overlay: JsonObject = { schemaVersion: 2, modules: { portal: { groups: [{ id: "main", title: "Overlay", items: [{ type: "service", host: "alpha", name: "api", title: "API" }] }] } } };
    const result = merge(base, overlay, composed);
    const groups = ((result.modules as JsonObject).portal as JsonObject).groups as JsonObject[];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: "main", title: "Overlay", items: [{ type: "service", host: "alpha", name: "api", title: "API" }] });
  });

  it("ships a closed, fully described 2020-12 section schema that compiles strictly", () => {
    const schema = portalSchema as unknown as JsonObject;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
    const undescribed: string[] = [];
    const open: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((entry, index) => visit(entry, `${path}/${index}`));
      if (node === null || typeof node !== "object") return;
      const object = node as JsonObject;
      if (object.type === "object" && object.additionalProperties !== false) open.push(path);
      if (object.properties !== null && typeof object.properties === "object" && !Array.isArray(object.properties)) {
        for (const [name, property] of Object.entries(object.properties)) {
          if (property === null || typeof property !== "object" || !("description" in property)) undescribed.push(`${path}/properties/${name}`);
        }
      }
      for (const [key, child] of Object.entries(object)) visit(child, `${path}/${key}`);
    };
    visit(schema, "#");
    expect(undescribed).toEqual([]);
    expect(open).toEqual([]);
    // The composition compiles with Ajv in strict mode and accepts an empty layout.
    expect(composed.checkConfig({ schemaVersion: 2, estate: { name: "example-estate" }, modules: { portal: { groups: [] } } })).toBe(true);
  });
});

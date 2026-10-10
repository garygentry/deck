import { DECK_API_VERSION } from "@deck/module-sdk";
import { describe, expect, it, vi } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { inModuleRequest } from "../src/modules/context.js";
import { ModuleInitError, ModuleManifestError, startModules } from "../src/modules/host.js";
import { planningRouteTable, RESERVED_ROOT_PATHS } from "../src/server/app.js";
import { BUILTIN_MANIFESTS, testHost, testModule } from "./util/modules.js";

const ids = (plan: readonly { id: string; enabled: boolean }[]) => plan.filter((p) => p.enabled).map((p) => p.id);

describe("module host planning", () => {
  it("orders by dependsOn, breaking ties by id", () => {
    const { host } = testHost([
      testModule({ id: "zeta" }),
      testModule({ id: "portal", dependsOn: ["inventory", "docker"] }),
      testModule({ id: "inventory", dependsOn: ["docker"] }),
      testModule({ id: "docker" }),
      testModule({ id: "alpha" }),
    ]);
    expect(ids(host.plan)).toEqual(["alpha", "docker", "inventory", "portal", "zeta"]);
    expect(host.findings).toEqual([]);
  });

  it("disables a module whose dependency is missing, and its dependants, with findings", () => {
    const { host, lines } = testHost([
      testModule({ id: "drift", dependsOn: ["snapshot"] }),
      testModule({ id: "report", dependsOn: ["drift"] }),
      testModule({ id: "base" }),
    ]);
    expect(ids(host.plan)).toEqual(["base"]);
    expect(host.findings).toEqual([
      expect.objectContaining({ code: "MODULE_DEPENDENCY_MISSING", severity: "warning", path: "/modules/drift", message: expect.stringContaining('"snapshot"') }),
      expect.objectContaining({ code: "MODULE_DEPENDENCY_MISSING", path: "/modules/report", message: expect.stringContaining('"drift"') }),
    ]);
    expect(host.plan.find((p) => p.id === "report")).toMatchObject({ enabled: false, reason: expect.stringContaining("drift") });
    expect(lines).toContainEqual(expect.objectContaining({ event: "module.disabled", module: "drift", code: "MODULE_DEPENDENCY_MISSING", level: 40 }));
  });

  it("treats a dependency that is not enabled as missing", () => {
    const { host } = testHost([
      testModule({ id: "actions", enabledBy: { env: "DECK_ACTIONS_ENABLED" } }),
      testModule({ id: "audit-view", dependsOn: ["actions"] }),
    ]);
    expect(ids(host.plan)).toEqual([]);
    expect(host.findings.map((f) => [f.code, f.path])).toEqual([["MODULE_DEPENDENCY_MISSING", "/modules/audit-view"]]);
  });

  it("disables modules in or downstream of a dependency cycle", () => {
    const { host } = testHost([
      testModule({ id: "a", dependsOn: ["b"] }),
      testModule({ id: "b", dependsOn: ["a"] }),
      testModule({ id: "c", dependsOn: ["a"] }),
      testModule({ id: "d" }),
    ]);
    expect(ids(host.plan)).toEqual(["d"]);
    expect(host.findings.map((f) => [f.code, f.path])).toEqual([
      ["MODULE_DEPENDENCY_CYCLE", "/modules/a"],
      ["MODULE_DEPENDENCY_CYCLE", "/modules/b"],
      ["MODULE_DEPENDENCY_CYCLE", "/modules/c"],
    ]);
  });

  it("disables a module whose deckApi range this kernel does not satisfy", () => {
    const { host } = testHost([
      testModule({ id: "future", deckApi: "^9" }),
      testModule({ id: "garbled", deckApi: ">=0" }),
      testModule({ id: "current", deckApi: `^${DECK_API_VERSION}` }),
    ]);
    expect(ids(host.plan)).toEqual(["current"]);
    expect(host.findings).toEqual([
      expect.objectContaining({ code: "MODULE_API_INCOMPATIBLE", path: "/modules/future", message: expect.stringContaining(DECK_API_VERSION) }),
      expect.objectContaining({ code: "MODULE_API_INCOMPATIBLE", path: "/modules/garbled" }),
    ]);
  });

  it("evaluates enabledBy: config section presence and env flags, both required when both given", () => {
    const modules = [
      testModule({ id: "by-config", enabledBy: { config: true } }),
      testModule({ id: "by-env", enabledBy: { env: "DECK_X_ENABLED" } }),
      testModule({ id: "by-both", enabledBy: { config: true, env: "DECK_X_ENABLED" } }),
      testModule({ id: "always" }),
    ];
    const off = testHost(modules);
    expect(ids(off.host.plan)).toEqual(["always"]);
    expect(off.host.findings).toEqual([]); // simply not enabled is not a finding
    expect(off.lines).toContainEqual(expect.objectContaining({ event: "module.disabled", module: "by-config", level: 30 }));

    const sections: Record<string, unknown> = { "by-config": {}, "by-both": { a: 1 } };
    for (const flag of ["true", "TRUE", "1"]) {
      const on = testHost(modules, { sectionOf: (id) => sections[id], env: { DECK_X_ENABLED: flag } });
      expect(ids(on.host.plan)).toEqual(["always", "by-both", "by-config", "by-env"]);
    }
    const envOnly = testHost(modules, { env: { DECK_X_ENABLED: "yes" } });
    expect(ids(envOnly.host.plan)).toEqual(["always"]);
  });

  it.each<[string, Parameters<typeof testModule>[0], string]>([
    ["a bad id", { id: "Bad_Id" }, "id must be lowercase kebab-case"],
    ["the reserved id core", { id: "core" }, 'id "core" is reserved for the kernel'],
    ["the reserved id ui", { id: "ui" }, 'id "ui" is reserved for the kernel'],
    ["a non-JSON value", { id: "x", env: [undefined as unknown as string] }, "manifest/env/0"],
    ["a non-string version", { id: "x", version: 1 as unknown as string }, "version must be a string"],
    ["a malformed dependsOn", { id: "x", dependsOn: "core" as unknown as string[] }, "dependsOn must be a list"],
    ["a malformed env name", { id: "x", env: ["lower_case"] }, 'env name "lower_case"'],
    ["a non-pointer envFromConfig", { id: "x", envFromConfig: ["claude/token" as "/x"] }, "must be a JSON Pointer"],
    ["a malformed enabledBy.env", { id: "x", enabledBy: { env: "deck actions" } }, 'enabledBy.env "deck actions"'],
    ["a legacy health key shadowing a kernel field", { id: "x", health: { legacyKey: "status" } }, "does not shadow a kernel field"],
    ["a legacy alias outside /api", { id: "x", contributes: { routes: { legacyAliases: ["/usage"] } } }, "must be under /api/"],
    ["the /api/m alias", { id: "x", contributes: { routes: { legacyAliases: ["/api/m"] } } }, "outside /api/m"],
    ["an alias under /api/m/", { id: "x", contributes: { routes: { legacyAliases: ["/api/m/y"] } } }, "outside /api/m"],
    ["an alias with router syntax", { id: "x", contributes: { routes: { legacyAliases: ["/api/:any"] } } }, "literal path"],
    ["an alias with a trailing slash", { id: "x", contributes: { routes: { legacyAliases: ["/api/u/"] } } }, "literal path"],
    ["an alias with a dot segment", { id: "x", contributes: { routes: { legacyAliases: ["/api/../config"] } } }, "literal path"],
    ["overlapping own aliases", { id: "x", contributes: { routes: { legacyAliases: ["/api/a", "/api/a/b"] } } }, "overlap"],
    ["a root path under /api", { id: "x", contributes: { routes: { rootPaths: ["/api/metrics"] } } }, "outside /api"],
    ["a wildcard root path (C2)", { id: "x", contributes: { routes: { rootPaths: ["/:prefix/*"] } } }, "literal path"],
    ["the bare root path", { id: "x", contributes: { routes: { rootPaths: ["/"] } } }, "literal path"],
    ["a non-list of pages", { id: "x", contributes: { pages: {} as never } }, "contributes.pages must be a list"],
    ["a page id naming another module", { id: "x", contributes: { pages: [{ id: "page:y/p", path: "/p", title: "P", component: "P" }] } }, 'must name its own module ("x")'],
    ["a page id of the wrong kind", { id: "x", contributes: { pages: [{ id: "nav:x/p", path: "/p", title: "P", component: "P" }] } }, 'must start with "page:"'],
    ["a relative page path", { id: "x", contributes: { pages: [{ id: "page:x/p", path: "p", title: "P", component: "P" }] } }, 'path must start with "/"'],
    ["a page without a component", { id: "x", contributes: { pages: [{ id: "page:x/p", path: "/p", title: "P", component: "" }] } }, "needs a component"],
    ["a page claiming the kernel's ConfigPage component", { id: "x", contributes: { pages: [{ id: "page:x/p", path: "/p", title: "P", component: "ConfigPage" }] } }, "component \"ConfigPage\" is the kernel's"],
    ["a nav entry with page and href", { id: "x", contributes: { nav: [{ id: "nav:x/n", page: "page:x/p", href: "/p", group: "g" }] } }, "exactly one of page or href"],
    ["a nav entry without a group", { id: "x", contributes: { nav: [{ id: "nav:x/n", href: "/p", group: "" }] } }, "needs a group"],
    ["a nav entry with a malformed group", { id: "x", contributes: { nav: [{ id: "nav:x/n", href: "/p", group: "My Lab" }] } }, "group must be a nav group id"],
    ["a non-finite nav order", { id: "x", contributes: { nav: [{ id: "nav:x/n", href: "/p", group: "g", order: "1" as never }] } }, "order must be a finite number"],
    ["an unknown slot type", { id: "x", contributes: { slots: [{ id: "x/s", accepts: "tile" as never }] } }, "accepts must be one of"],
    ["an extension without attachTo.slot", { id: "x", contributes: { extensions: [{ id: "pill:x/e", kind: "pill", attachTo: {} as never }] } }, "needs attachTo.slot"],
    ["a malformed extension id", { id: "x", contributes: { extensions: [{ id: "x/e" as never, kind: "pill", attachTo: { slot: "s" } }] } }, "<kind>:<module>/<name>"],
    ["an extension with non-object config", { id: "x", contributes: { extensions: [{ id: "pill:x/e", kind: "pill", attachTo: { slot: "s" }, config: [] as never }] } }, "config must be an object"],
  ])("disables a module with %s, with a MODULE_MANIFEST_INVALID finding (L4)", async (_label, manifest, message) => {
    const init = vi.fn();
    const { host, lines } = testHost([testModule(manifest, init), testModule({ id: "fine" })]);
    expect(ids(host.plan)).toEqual(["fine"]);
    expect(host.findings).toEqual([
      expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", severity: "warning", message: expect.stringContaining(message) }),
    ]);
    expect(lines).toContainEqual(expect.objectContaining({ event: "module.disabled", code: "MODULE_MANIFEST_INVALID" }));
    await host.start();
    expect(init).not.toHaveBeenCalled();
  });

  it("disables a manifest with a getter without calling it, and plans from a stable snapshot (C8)", async () => {
    let reads = 0;
    const manifest = { id: "sneaky", version: "1.0.0", deckApi: "^0.1", get env() { reads += 1; return []; } };
    const { host } = testHost([{ manifest, init: () => {} } as never]);
    expect(reads).toBe(0);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/sneaky", message: expect.stringContaining("accessor") })]);

    const mutable = { id: "later", version: "1.0.0", deckApi: "^0.1", contributes: { routes: { rootPaths: ["/a.txt"] } } };
    const stable = testHost([{ manifest: mutable, init: () => {} }]);
    mutable.contributes.routes.rootPaths.push("/b.txt");
    expect(stable.host.rootPaths()).toEqual(["/a.txt"]);
  });

  it("reports two modules with malformed ids as two invalid modules, not a duplicate (N3)", () => {
    const noId = (): never => ({ manifest: { version: "1", deckApi: "^0.1" }, init: () => {} }) as never;
    const { host } = testHost([noId(), noId(), testModule({ id: "fine" })]);
    expect(ids(host.plan)).toEqual(["fine"]);
    expect(host.findings.map((f) => [f.code, f.path])).toEqual([
      ["MODULE_MANIFEST_INVALID", "/modules/undefined"],
      ["MODULE_MANIFEST_INVALID", "/modules/undefined"],
    ]);
  });

  it.each<[string, Parameters<typeof testModule>[0], string]>([
    ["an alias under a parameterised kernel route", { id: "x", contributes: { routes: { legacyAliases: ["/api/providers/x"] } } }, "collides with kernel route GET /api/providers/:id"],
    ["an alias equal to a kernel route", { id: "x", contributes: { routes: { legacyAliases: ["/api/config"] } } }, "collides with kernel route GET /api/config"],
    ["a root path the kernel reserves", { id: "x", contributes: { routes: { rootPaths: ["/kernel.txt"] } } }, 'root path "/kernel.txt" is reserved by the kernel'],
  ])("disables a single module whose %s at plan time, before init (N3)", async (_label, manifest, message) => {
    const init = vi.fn();
    const { host } = testHost([testModule(manifest, init), testModule({ id: "fine" })], {
      kernelRoutes: [{ method: "GET", path: "/api/config" }, { method: "GET", path: "/api/providers/:id" }],
      reservedRootPaths: ["/kernel.txt"],
    });
    expect(ids(host.plan)).toEqual(["fine"]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/x", message: expect.stringContaining(message) })]);
    await host.start();
    expect(init).not.toHaveBeenCalled();
  });

  it("treats a dependency on an invalid module as missing", () => {
    const { host } = testHost([testModule({ id: "Bad" }), testModule({ id: "dependant", dependsOn: ["Bad"] })]);
    expect(host.findings.map((f) => f.code)).toEqual(["MODULE_MANIFEST_INVALID", "MODULE_DEPENDENCY_MISSING"]);
  });

  it.each<[string, Parameters<typeof testModule>[0][], string]>([
    ["a duplicate id", [{ id: "x" }, { id: "x" }], "duplicate module id"],
    ["a shared legacy health key", [{ id: "x", health: { legacyKey: "k" } }, { id: "y", health: { legacyKey: "k" } }], "already declared"],
    ["a shared legacy alias", [{ id: "x", contributes: { routes: { legacyAliases: ["/api/u"] } } }, { id: "y", contributes: { routes: { legacyAliases: ["/api/u"] } } }], "overlaps"],
    ["nested aliases across modules (C1)", [{ id: "x", contributes: { routes: { legacyAliases: ["/api/shared"] } } }, { id: "y", contributes: { routes: { legacyAliases: ["/api/shared/child"] } } }], 'overlaps "/api/shared"'],
    ["a shared root path", [{ id: "x", contributes: { routes: { rootPaths: ["/m"] } } }, { id: "y", contributes: { routes: { rootPaths: ["/m"] } } }], "already declared"],
  ])("fails boot on %s between modules, enabled or not", (_label, manifests, message) => {
    const modules = manifests.map((m) => testModule({ ...m, enabledBy: { config: true } }));
    expect(() => testHost(modules)).toThrow(ModuleManifestError);
    expect(() => testHost(modules)).toThrow(message);
  });

  it("does not report a cycle among modules that are not enabled (L13)", () => {
    const { host, lines } = testHost([
      testModule({ id: "a", dependsOn: ["b"], enabledBy: { config: true } }),
      testModule({ id: "b", dependsOn: ["a"], enabledBy: { config: true } }),
    ]);
    expect(host.findings).toEqual([]);
    expect(host.plan).toEqual([
      { id: "a", enabled: false, reason: "not enabled: no modules.a section", gates: [{ config: "modules.a" }] },
      { id: "b", enabled: false, reason: "not enabled: no modules.b section", gates: [{ config: "modules.b" }] },
    ]);
    expect(lines.filter((l) => l.code === "MODULE_DEPENDENCY_CYCLE")).toEqual([]);
  });

  it("the test util's built-in manifest list matches BUILTIN_MODULES", () => {
    expect(new Set(BUILTIN_MODULES.map(({ manifest }) => manifest))).toEqual(BUILTIN_MANIFESTS);
  });

  it("ships the built-in modules, and they plan cleanly against the kernel routes", () => {
    expect(BUILTIN_MODULES.map(({ manifest }) => manifest.id)).toEqual(["actions", "alertmanager", "docker", "drift", "file-tree", "gatus", "http-health", "http-json", "inventory", "link", "llm-usage", "markdown-tree", "metrics", "monitoring", "portal", "prometheus", "remote", "snapshot", "sources"]);
    const { host } = testHost([...BUILTIN_MODULES], { kernelRoutes: planningRouteTable(), reservedRootPaths: RESERVED_ROOT_PATHS });
    expect(host.findings).toEqual([]);
    expect(host.plan).toEqual([
      // drift and inventory depend on snapshot, so they follow it.
      ...["alertmanager", "docker", "file-tree", "gatus", "http-health", "http-json", "link", "llm-usage", "markdown-tree", "monitoring", "portal", "prometheus", "remote", "snapshot", "drift", "inventory", "sources"].map((id) => ({ id, enabled: true })),
      { id: "actions", enabled: false, reason: "not enabled: DECK_ACTIONS_ENABLED is not true", gates: [{ env: "DECK_ACTIONS_ENABLED" }] },
      { id: "metrics", enabled: false, reason: "not enabled: DECK_METRICS_ENABLED is not true", gates: [{ env: "DECK_METRICS_ENABLED" }] },
    ]);
    const on = testHost([...BUILTIN_MODULES], { env: { DECK_ACTIONS_ENABLED: "1", DECK_METRICS_ENABLED: "1" }, kernelRoutes: planningRouteTable(), reservedRootPaths: RESERVED_ROOT_PATHS });
    expect(on.host.findings).toEqual([]);
    // metrics uses the snapshot module's snapshot/content service, so it follows snapshot too.
    expect(on.host.plan).toEqual(["actions", "alertmanager", "docker", "file-tree", "gatus", "http-health", "http-json", "link", "llm-usage", "markdown-tree", "monitoring", "portal", "prometheus", "remote", "snapshot", "drift", "inventory", "metrics", "sources"].map((id) => ({ id, enabled: true })));
  });
});

describe("module host: owned env names", () => {
  const refused = (host: { findings: readonly { code: string; path: string; message: string }[] }) =>
    host.findings.map(({ code, path, message }) => ({ code, path, message }));

  it("refuses a manifest that declares a kernel setting in env", () => {
    const { host } = testHost([testModule({ id: "x", env: ["DECK_DATA_DIR"] })]);
    expect(refused(host)).toEqual([{ code: "MODULE_MANIFEST_INVALID", path: "/modules/x", message: 'Module "x" has an invalid manifest: env name "DECK_DATA_DIR" is a deployment setting the kernel reads.' }]);
  });

  it("refuses env that is not a list", () => {
    const { host } = testHost([testModule({ id: "x", env: "MY_NAME" as unknown as string[] })]);
    expect(refused(host)).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining("env must be a list of names") })]);
  });

  it("gives a name to one module: built-ins first, then by id; a later claimant is disabled", async () => {
    const init = vi.fn();
    const builtin = testModule({ id: "zz-builtin", env: ["SHARED_FILE"] }, init);
    const { host } = testHost([
      testModule({ id: "aa", env: ["SHARED_FILE", "AA_ONLY"] }, init),
      builtin,
      testModule({ id: "bb", env: ["BB_ONLY", "OTHER"] }, init),
      testModule({ id: "cc", env: ["OTHER"] }, init),
    ], { builtins: new Set([builtin]) });
    expect(refused(host)).toEqual([
      { code: "MODULE_MANIFEST_INVALID", path: "/modules/aa", message: 'Module "aa" has an invalid manifest: env name "SHARED_FILE" is owned by module "zz-builtin".' },
      { code: "MODULE_MANIFEST_INVALID", path: "/modules/cc", message: 'Module "cc" has an invalid manifest: env name "OTHER" is owned by module "bb".' },
    ]);
    await host.start();
    expect(host.plan.filter((entry) => entry.enabled).map((entry) => entry.id)).toEqual(["bb", "zz-builtin"]);
  });

  it("a module refused for its API range owns nothing: a compatible module keeps the name (review N1)", async () => {
    const { host } = testHost([
      testModule({ id: "aa-old", deckApi: "^9.0", env: ["HTTPS_PROXY"] }),
      testModule({ id: "bb-new", env: ["HTTPS_PROXY"] }),
    ], { env: { HTTPS_PROXY: "http://proxy" } });
    expect(host.findings.map(({ code, path }) => ({ code, path }))).toEqual([{ code: "MODULE_API_INCOMPATIBLE", path: "/modules/aa-old" }]);
    expect(host.plan).toContainEqual({ id: "bb-new", enabled: true });
  });

  it("a module refused for a missing dependency or a cycle owns nothing either (review N1)", () => {
    const { host } = testHost([
      testModule({ id: "aa-orphan", dependsOn: ["missing"], env: ["ONE"] }),
      testModule({ id: "ab-cycle", dependsOn: ["ac-cycle"], env: ["TWO"] }),
      testModule({ id: "ac-cycle", dependsOn: ["ab-cycle"] }),
      testModule({ id: "zz", env: ["ONE", "TWO"] }),
    ]);
    expect(host.plan).toContainEqual({ id: "zz", enabled: true });
    expect(host.findings.map((finding) => finding.code).sort()).toEqual(["MODULE_DEPENDENCY_CYCLE", "MODULE_DEPENDENCY_CYCLE", "MODULE_DEPENDENCY_MISSING"]);
  });

  it("a module that loses a name takes its dependants with it", () => {
    const { host } = testHost([
      testModule({ id: "aa", env: ["NAME"] }),
      testModule({ id: "bb", env: ["NAME"] }),
      testModule({ id: "cc", dependsOn: ["bb"] }),
    ]);
    expect(host.findings.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "MODULE_MANIFEST_INVALID", path: "/modules/bb" },
      { code: "MODULE_DEPENDENCY_MISSING", path: "/modules/cc" },
    ]);
  });

  it("lets two modules share a non-secret name through sharedEnv, and both read it (review N1)", async () => {
    const read: Record<string, string | undefined> = {};
    const { host } = testHost([
      testModule({ id: "cc", sharedEnv: ["TZ"] }, (ctx) => void (read.cc = ctx.env.get("TZ"))),
      testModule({ id: "dd", sharedEnv: ["TZ"] }, (ctx) => void (read.dd = ctx.env.get("TZ"))),
    ], { env: { TZ: "Etc/UTC" } });
    expect(host.findings).toEqual([]);
    await host.start();
    expect(read).toEqual({ cc: "Etc/UTC", dd: "Etc/UTC" });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a kernel name in sharedEnv", { sharedEnv: ["DECK_DATA_DIR"] }, 'sharedEnv name "DECK_DATA_DIR" is a deployment setting the kernel reads'],
    ["a name in both env and sharedEnv", { env: ["TZ"], sharedEnv: ["TZ"] }, 'env name "TZ" is also listed in sharedEnv'],
    ["sharedEnv that is not a list", { sharedEnv: "TZ" }, "sharedEnv must be a list of names"],
  ])("refuses %s", (_label, manifest, message) => {
    const { host } = testHost([testModule({ id: "x", ...manifest })]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining(message) })]);
  });

  it("refuses a sharedEnv name another module owns exclusively, whichever sorts first (review N1)", async () => {
    const init = vi.fn();
    const { host } = testHost([
      testModule({ id: "aa-sharer", sharedEnv: ["SECRET_FILE"] }, init),
      testModule({ id: "zz-owner", env: ["SECRET_FILE"] }),
    ]);
    expect(host.findings.map(({ code, path, message }) => ({ code, path, message }))).toEqual([
      { code: "MODULE_MANIFEST_INVALID", path: "/modules/aa-sharer", message: 'Module "aa-sharer" has an invalid manifest: shared env name "SECRET_FILE" is owned by module "zz-owner".' },
    ]);
    await host.start();
    expect(init).not.toHaveBeenCalled();
  });

  it("settles claims in at most one round per module on an adversarial set", () => {
    // Crossing shared/exclusive names (each module shares what the other owns), a chain of
    // dependants on a loser, and a large crowd all claiming one name.
    const crowd = Array.from({ length: 40 }, (_, i) => testModule({ id: `crowd-${String(i).padStart(2, "0")}`, env: ["CROWD"], dependsOn: i === 0 ? [] : [`crowd-${String(i - 1).padStart(2, "0")}`] }));
    const started = Date.now();
    const { host } = testHost([
      testModule({ id: "aa-x", env: ["Y_NAME"], sharedEnv: ["X_NAME"] }),
      testModule({ id: "bb-y", env: ["X_NAME"], sharedEnv: ["Y_NAME"] }),
      testModule({ id: "cc-win", env: ["Z_NAME"] }),
      testModule({ id: "dd-lose", env: ["Z_NAME"] }),
      testModule({ id: "ee-dep", dependsOn: ["dd-lose"] }),
      testModule({ id: "ff-dep", dependsOn: ["ee-dep"] }),
      ...crowd,
    ]);
    expect(Date.now() - started).toBeLessThan(2_000);
    const enabled = host.plan.filter((entry) => entry.enabled).map((entry) => entry.id);
    // Each of the crossing pair shares a name the other owns: both are refused.
    expect(enabled).toEqual(["cc-win", "crowd-00"]);
    const reasons = Object.fromEntries(host.findings.map((finding) => [finding.path.slice("/modules/".length), finding.code]));
    expect(reasons).toMatchObject({ "aa-x": "MODULE_MANIFEST_INVALID", "bb-y": "MODULE_MANIFEST_INVALID", "dd-lose": "MODULE_MANIFEST_INVALID", "ee-dep": "MODULE_DEPENDENCY_MISSING", "ff-dep": "MODULE_DEPENDENCY_MISSING", "crowd-39": "MODULE_MANIFEST_INVALID" });
  });

  it("keeps the names of a module that is switched off: it still owns them", () => {
    const { host } = testHost([
      testModule({ id: "off", enabledBy: { env: "OFF_ON" }, env: ["OFF_FILE"] }),
      testModule({ id: "other", env: ["OFF_FILE"] }),
    ]);
    expect(refused(host)).toEqual([expect.objectContaining({ path: "/modules/other", message: expect.stringContaining('"OFF_FILE" is owned by module "off"') })]);
  });
});

describe("module host: manifest shape (review L8)", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["config.references as a string", { config: { schema: { type: "object" }, references: "target" } }, "config.references must be a list"],
    ["a dataDir.legacyPath with a slash", { dataDir: { legacyPath: "a/b" } }, 'dataDir.legacyPath "a/b" must be one directory name other than "modules"'],
    ["the dataDir.legacyPath modules", { dataDir: { legacyPath: "modules" } }, 'dataDir.legacyPath "modules"'],
  ])("refuses %s", (_label, manifest, message) => {
    const { host } = testHost([testModule({ id: "x", ...manifest })]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining(message) })]);
  });

  it("fails boot when two built-in modules declare the same dataDir.legacyPath", () => {
    const a = testModule({ id: "a", dataDir: { legacyPath: "store" } });
    const b = testModule({ id: "b", dataDir: { legacyPath: "store" } });
    expect(() => testHost([a, b], { builtins: new Set([a, b]) })).toThrow(ModuleManifestError);
  });

  it("refuses dataDir.legacyPath on a module that is not built in, without failing boot (review N2)", async () => {
    const init = vi.fn();
    const builtin = testModule({ id: "actions-like", dataDir: { legacyPath: "actions" } });
    const thief = testModule({ id: "thief", dataDir: { legacyPath: "actions" } }, init);
    const { host } = testHost([builtin, thief], { builtins: new Set([builtin]) });
    expect(host.findings.map(({ code, path, message }) => ({ code, path, message }))).toEqual([
      { code: "MODULE_MANIFEST_INVALID", path: "/modules/thief", message: 'Module "thief" has an invalid manifest: dataDir.legacyPath is reserved for built-in modules.' },
    ]);
    await host.start();
    expect(init).not.toHaveBeenCalled();
    expect(host.plan).toContainEqual({ id: "actions-like", enabled: true });
  });
});

describe("module host lifecycle", () => {
  it("runs init in dependency order with each module's own config", async () => {
    const calls: [string, unknown][] = [];
    const record = (ctx: { id: string; config: unknown }) => void calls.push([ctx.id, ctx.config]);
    const { host, lines } = testHost(
      [testModule({ id: "b", dependsOn: ["a"] }, record), testModule({ id: "a" }, async (ctx) => {
        await Promise.resolve();
        record(ctx);
      })],
      { sectionOf: (id) => (id === "a" ? { x: 1 } : undefined) },
    );
    await host.start();
    expect(calls).toEqual([["a", { x: 1 }], ["b", undefined]]);
    expect(lines.filter((l) => l.event === "module.init").map((l) => l.module)).toEqual(["a", "b"]);
  });

  it("classifies an init throw, stopping the failed module and earlier ones in reverse order", async () => {
    const stops: string[] = [];
    const { host } = testHost([
      testModule({ id: "a" }, (ctx) => ctx.onStop(() => void stops.push("a"))),
      testModule({ id: "b", dependsOn: ["a"] }, (ctx) => ctx.onStop(() => void stops.push("b"))),
      testModule({ id: "c", dependsOn: ["b"] }, (ctx) => {
        ctx.onStop(() => void stops.push("c"));
        throw new Error("no credentials");
      }),
      testModule({ id: "d", dependsOn: ["c"] }, () => void stops.push("d-init")),
    ]);
    const failure = await host.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModuleInitError);
    expect(failure).toMatchObject({ moduleId: "c", code: "MODULE_INIT_FAILED", message: 'module "c" failed to initialise: no credentials' });
    expect(stops).toEqual(["c", "b", "a"]);
    // Nothing is left to stop.
    await host.stop();
    expect(stops).toEqual(["c", "b", "a"]);
  });

  it("startModules reports an init failure on stderr and exits 2, like a bad config", async () => {
    const { host } = testHost([testModule({ id: "x" }, () => {
      throw new Error("bad");
    })]);
    const exit = vi.fn((code: 2): never => {
      throw new Error(`exit:${code}`);
    });
    const stderr = vi.fn();
    await expect(startModules(host, exit, stderr)).rejects.toThrow("exit:2");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderr).toHaveBeenCalledWith('module "x" failed to initialise: bad\n');
  });

  it("startModules resolves quietly when every init succeeds", async () => {
    const { host } = testHost([testModule({ id: "x" })]);
    const exit = vi.fn((): never => {
      throw new Error("unexpected");
    });
    await expect(startModules(host, exit)).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("drains in-flight task runs before any onStop hook runs (L3)", async () => {
    const events: string[] = [];
    let release!: () => void;
    const { host } = testHost([testModule({ id: "store" }, (ctx) => {
      const task = ctx.scheduler.schedule({
        name: "write",
        run: () => new Promise<void>((resolve) => (release = resolve)).then(() => void events.push("write done")),
        cadence: () => null,
      });
      ctx.onStop(() => void events.push("store closed"));
      void Promise.resolve().then(() => task.runNow());
    })]);
    await host.start();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = host.stop();
    await Promise.resolve();
    expect(events).toEqual([]);
    release();
    await stopping;
    expect(events).toEqual(["write done", "store closed"]);
  });

  it("refuses scheduling, provider registration and root routes after init in a request (L9)", async () => {
    let ctxRef!: Parameters<Parameters<typeof testModule>[1] & object>[0];
    const { host } = testHost([testModule({ id: "late", contributes: { routes: { rootPaths: ["/late.txt"] } } }, (ctx) => {
      ctxRef = ctx;
    })]);
    await host.start();
    const inRequest = (fn: () => unknown) => () => inModuleRequest(fn);
    expect(inRequest(() => ctxRef.scheduler.schedule({ name: "x", run: async () => {}, cadence: () => 1 }))).toThrow("only available during init");
    expect(inRequest(() => ctxRef.providers.register({ id: "p", kind: "k", health: async () => ({ ok: true }), fetch: async () => 1 }))).toThrow("only available during init");
    expect(inRequest(() => ctxRef.rootRoute("/late.txt", () => new Response("x")))).toThrow("only available during init");
  });

  it("bounds the drain: a run that never settles cannot hang shutdown (N1)", async () => {
    const order: string[] = [];
    const { host, lines } = testHost([testModule({ id: "stuck" }, (ctx) => {
      const task = ctx.scheduler.schedule({ name: "hang", run: () => new Promise<void>(() => {}), cadence: () => null });
      ctx.onStop(() => void order.push("hook ran"));
      void Promise.resolve().then(() => task.runNow());
    })], { drainTimeoutMs: 20 });
    await host.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await host.stop();
    expect(order).toEqual(["hook ran"]);
    expect(lines).toContainEqual(expect.objectContaining({ module: "stuck", event: "stuck.stop-timeout", drainTimeoutMs: 20, level: 40 }));
  });

  it("bounds each stop hook: a hook that never settles is abandoned and the rest still run (review C2)", async () => {
    const order: string[] = [];
    const { host, lines } = testHost([
      testModule({ id: "first" }, (ctx) => {
        ctx.onStop(() => void order.push("first hook"));
      }),
      testModule({ id: "hung", dependsOn: ["first"] }, (ctx) => {
        ctx.onStop(() => void order.push("earlier hook"));
        ctx.onStop(() => new Promise<void>(() => {}));
      }),
    ], { hookTimeoutMs: 20 });
    await host.start();
    const started = Date.now();
    await host.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(order).toEqual(["earlier hook", "first hook"]);
    expect(lines).toContainEqual(expect.objectContaining({ module: "hung", event: "hung.stop-hook-timeout", hookTimeoutMs: 20, level: 40 }));
    expect(lines).toContainEqual(expect.objectContaining({ event: "module.stop", module: "first" }));
  });

  it("starts early stop hooks at once, beside the ordered stop, each within its own bound", async () => {
    const order: string[] = [];
    let releaseLate!: () => void;
    const { host, lines } = testHost([
      testModule({ id: "early" }, (ctx) => {
        ctx.onStop(() => void order.push("early ordinary hook"));
        ctx.onStop(async () => {
          order.push("early hook started");
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push("early hook done");
        }, { early: true });
        ctx.onStop(() => new Promise<void>(() => {}), { early: true, timeoutMs: 30 });
      }),
      // Stops first (reverse init order); its hook waits until the early hook is done.
      testModule({ id: "late", dependsOn: ["early"] }, (ctx) => {
        ctx.onStop(() => new Promise<void>((resolve) => {
          order.push("late hook started");
          releaseLate = resolve;
        }));
      }),
    ], { hookTimeoutMs: 500 });
    await host.start();
    const stopping = host.stop();
    await vi.waitFor(() => expect(order).toContain("early hook done"));
    releaseLate();
    await stopping;
    expect(order).toEqual(["early hook started", "late hook started", "early hook done", "early ordinary hook"]);
    expect(lines).toContainEqual(expect.objectContaining({ module: "early", event: "early.stop-hook-timeout", hookTimeoutMs: 30 }));
    // A module is reported stopped only once its early hooks have settled too.
    const stops = lines.filter((line) => line.event === "module.stop").map((line) => line.module);
    expect(stops).toEqual(["late", "early"]);
  });

  it("clamps every hook bound to what is left of the stage, so a hook is abandoned (and logged) before the stage gives up (review L6)", async () => {
    const { host, lines } = testHost([
      testModule({ id: "slow" }, (ctx) => ctx.onStop(() => new Promise<void>(() => {}), { early: true, timeoutMs: 5_000 })),
    ], { stageTimeoutMs: 200 });
    await host.start();
    const started = Date.now();
    await host.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    const timeout = lines.find((line) => line.event === "slow.stop-hook-timeout");
    expect(timeout).toBeDefined();
    expect(timeout!.hookTimeoutMs as number).toBeLessThanOrEqual(200);
  });

  it("runs early stop hooks when an init failure stops the modules already started", async () => {
    const early = vi.fn();
    const { host } = testHost([
      testModule({ id: "a" }, (ctx) => ctx.onStop(early, { early: true })),
      testModule({ id: "b", dependsOn: ["a"] }, () => {
        throw new Error("boom");
      }),
    ]);
    await expect(host.start()).rejects.toBeInstanceOf(ModuleInitError);
    expect(early).toHaveBeenCalledOnce();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses an onStop timeoutMs of %s", async (timeoutMs) => {
    const { host } = testHost([testModule({ id: "x" }, (ctx) => ctx.onStop(() => {}, { timeoutMs }))]);
    await expect(host.start()).rejects.toThrow('module "x": onStop timeoutMs must be a positive number of ms');
  });

  it("still exits 2 when init throws with a never-settling run pending (N1)", async () => {
    const { host } = testHost([testModule({ id: "x" }, (ctx) => {
      const task = ctx.scheduler.schedule({ name: "hang", run: () => new Promise<void>(() => {}), cadence: () => null });
      void task.runNow();
      throw new Error("bad config");
    })], { drainTimeoutMs: 20 });
    const exit = vi.fn((code: 2): never => {
      throw new Error(`exit:${code}`);
    });
    const stderr = vi.fn();
    await expect(startModules(host, exit, stderr)).rejects.toThrow("exit:2");
    expect(stderr).toHaveBeenCalledWith('module "x" failed to initialise: bad config\n');
  });

  it("logs and refuses a late registration outside a request instead of throwing (N2)", async () => {
    let ctxRef!: Parameters<Parameters<typeof testModule>[1] & object>[0];
    const { host, lines } = testHost([testModule({ id: "late" }, (ctx) => {
      ctxRef = ctx;
    })]);
    await host.start();
    // e.g. from a timer or a detached promise: a throw here would be uncaught.
    const handle = await new Promise<ReturnType<typeof ctxRef.scheduler.schedule>>((resolve) =>
      setTimeout(() => resolve(ctxRef.scheduler.schedule({ name: "x", run: async () => {}, cadence: () => 1 })), 0));
    await expect(handle.runNow()).resolves.toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(ctxRef.providers.register({ id: "p", kind: "k", health: async () => ({ ok: true }), fetch: async () => 1 })).toBeDefined();
    expect(lines.filter((l) => l.event === "late.late-registration").map((l) => l.service)).toEqual([
      "ctx.scheduler.schedule",
      "ctx.providers.register",
    ]);
  });

  it("does not run init for disabled modules", async () => {
    const init = vi.fn();
    const { host } = testHost([testModule({ id: "x", enabledBy: { config: true } }, init)]);
    await host.start();
    expect(init).not.toHaveBeenCalled();
  });
});

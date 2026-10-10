import { defineServerModule, type ServerModule } from "@deck/module-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { load } from "../src/config/load.js";
import type { DeckConfig } from "../src/contract/index.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { kindRuntimes, planModules } from "../src/modules/host.js";
import { registerAllProviders } from "../src/providers/index.js";
import { stopScheduler } from "../src/providers/registry.js";
import { makeConfigDir } from "./util/tmp-config.js";

afterEach(() => stopScheduler());

type Env = Record<string, string | undefined>;

const SNAPSHOT_ENV: Env = { DECK_SNAPSHOT_SOURCE: "/nonexistent/snapshot.json" };

const estate = (extra: Record<string, unknown>) => ({ schemaVersion: 2, estate: { name: "reserved" }, ...extra });
const httpJson = (id: string) => ({ id, kind: "http-json", title: id, url: "http://ups.lan/status" });
const remote = (id: string) => ({ id, kind: "remote", title: id, url: "http://sidecar.lan:9000" });
const upstream = (kind: string) => ({ id: `${kind}-main`, kind, title: kind, baseUrl: `http://${kind}.lan` });

/**
 * A module with its own `feeder` kind, switched on by FEEDER_ON, whose instances handler
 * registers each instance under its own id.
 */
const feeder: ServerModule<any> = defineServerModule(
  { id: "feeder", version: "1.0.0", deckApi: "^0.1", enabledBy: { env: "FEEDER_ON" }, providerKinds: [{ kind: "feeder", instanceSchema: { type: "object" }, statusCapable: false }] },
  () => {},
  {
    kinds: {
      feeder: {
        instances: (instances) => instances.map((instance) => ({
          provider: { id: String(instance.id), kind: "feeder", fetch: async () => ({}), health: async () => ({ ok: true }) },
        })),
      },
    },
  },
);

/** What `deck validate` reports as PROVIDER_ID_RESERVED for `document` under `env`. */
function reserved(document: Record<string, unknown>, env: Env, modules?: readonly ServerModule<any>[]): { severity: string; path: string }[] {
  const dir = makeConfigDir({ "00-base.yaml": document });
  try {
    return load({ arg: dir.dir, env, disabledSections: "strict", ...(modules === undefined ? {} : { modules }) })
      .findings.filter((finding) => finding.code === "PROVIDER_ID_RESERVED")
      .map(({ severity, path }) => ({ severity, path }));
  } finally {
    dir.cleanup();
  }
}

/** Whether boot's provider registration fails on `document` under `env` with PROVIDER_DUPLICATE_ID. */
function bootFails(document: Record<string, unknown>, env: Env, modules: readonly ServerModule<any>[] = BUILTIN_MODULES): boolean {
  const { plan, usable, envOwners, builtinIds } = planModules({ modules, sectionOf: () => undefined, env, builtins: new Set(BUILTIN_MODULES) });
  const runtimes = kindRuntimes(plan.filter((entry) => entry.enabled).map((entry) => usable.get(entry.id)!), env, undefined, undefined, envOwners, undefined, builtinIds);
  try {
    registerAllProviders(document as unknown as DeckConfig, runtimes);
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === "PROVIDER_DUPLICATE_ID") return true;
    throw error;
  } finally {
    stopScheduler();
  }
}

describe("PROVIDER_ID_RESERVED: validation reserves every fixed provider id that registers", () => {
  const cases: Array<[string, Record<string, unknown>, Env, string[]]> = [
    ["an http-json id `snapshot` while DECK_SNAPSHOT_SOURCE is set", estate({ integrations: [httpJson("snapshot")] }), SNAPSHOT_ENV, ["/integrations/0/id"]],
    ["a remote id `snapshot` while DECK_SNAPSHOT_SOURCE is set", estate({ integrations: [remote("snapshot")] }), SNAPSHOT_ENV, ["/integrations/0/id"]],
    ["an http-json id `snapshot` with DECK_SNAPSHOT_SOURCE unset", estate({ integrations: [httpJson("snapshot")] }), {}, []],
    // A fixed-id kind's instance registers under its kind's fixed id, so its own id is free.
    ["a gatus integration with id `snapshot` while DECK_SNAPSHOT_SOURCE is set", estate({ integrations: [{ ...upstream("gatus"), id: "snapshot" }] }), SNAPSHOT_ENV, []],
    ["a remote id `docker` beside a docker integration", estate({ integrations: [upstream("docker"), remote("docker")] }), {}, ["/integrations/1/id"]],
    ["an http-json id `prometheus` beside a prometheus integration", estate({ integrations: [upstream("prometheus"), httpJson("prometheus")] }), {}, ["/integrations/1/id"]],
    ["a gatus integration with id `docker` beside a docker integration", estate({ integrations: [upstream("docker"), { ...upstream("gatus"), id: "docker" }] }), {}, []],
    ["an http-json id `docker` with no docker integration", estate({ integrations: [httpJson("docker")] }), {}, []],
    ["a docker integration whose own id is `docker`", estate({ integrations: [{ ...upstream("docker"), id: "docker" }] }), {}, []],
    [
      "a binding whose id is `gatus` beside a gatus integration",
      estate({ integrations: [upstream("gatus")], hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { "http-health": { id: "gatus", url: "http://alpha" } } }] }),
      {},
      ["/hosts/0/bindings/http-health/id"],
    ],
  ];

  it.each(cases)("%s", (_label, document, env, paths) => {
    expect(reserved(document, env)).toEqual(paths.map((path) => ({ severity: "error", path })));
  });

  // Validation and boot agree: a document validate passes on this count registers, and one it
  // refuses would fail boot with PROVIDER_DUPLICATE_ID.
  it.each(cases)("boot agrees: %s", (_label, document, env, paths) => {
    expect(bootFails(document, env)).toBe(paths.length > 0);
  });

  // Only what can register is reserved: an id nothing registers is left to its own findings.
  const nothingRegisters: Array<[string, Record<string, unknown>]> = [
    [
      "a binding of a kind that takes no bindings (prometheus), with id `gatus`",
      estate({ integrations: [upstream("gatus")], hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { prometheus: { id: "gatus" } } }] }),
    ],
    ["an integration of an unknown kind with id `gatus`", estate({ integrations: [upstream("gatus"), { id: "gatus", kind: "mystery-kind", title: "Odd", baseUrl: "http://odd.lan" }] })],
    ["an integration of a kind whose module is off, with id `gatus`", estate({ integrations: [upstream("gatus"), { id: "gatus", kind: "feeder", title: "Feed" }] })],
  ];

  it.each(nothingRegisters)("%s: not reserved, and boot agrees", (_label, document) => {
    expect(reserved(document, {}, [...BUILTIN_MODULES, feeder])).toEqual([]);
    expect(bootFails(document, {}, [...BUILTIN_MODULES, feeder])).toBe(false);
  });

  it("a binding of a kind without a fixed id that takes no bindings (http-json), with id `gatus`: only its advisory finding", () => {
    const document = estate({ integrations: [upstream("gatus")], hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { "http-json": { id: "gatus", url: "http://alpha.lan/status" } } }] });
    const dir = makeConfigDir({ "00-base.yaml": document });
    try {
      const codes = load({ arg: dir.dir, env: {} }).findings.map(({ code, path }) => ({ code, path }));
      expect(codes).toContainEqual({ code: "PROVIDER_BINDING_UNSUPPORTED", path: expect.stringContaining("/hosts/0/bindings/http-json") });
      expect(codes.map(({ code }) => code)).not.toContain("PROVIDER_ID_RESERVED");
    } finally {
      dir.cleanup();
    }
    expect(bootFails(document, {})).toBe(false);
  });

  it("an integration of that kind once its module is on: reserved, and boot agrees", () => {
    const document = nothingRegisters[2]![1];
    expect(reserved(document, { FEEDER_ON: "true" }, [...BUILTIN_MODULES, feeder])).toEqual([{ severity: "error", path: "/integrations/1/id" }]);
    expect(bootFails(document, { FEEDER_ON: "true" }, [...BUILTIN_MODULES, feeder])).toBe(true);
  });

  it("does not reserve `snapshot` for an empty DECK_SNAPSHOT_SOURCE (which fails boot on its own)", () => {
    expect(reserved(estate({ integrations: [httpJson("snapshot")] }), { DECK_SNAPSHOT_SOURCE: "" })).toEqual([]);
  });

  it("is an error that fails `deck validate`", () => {
    const dir = makeConfigDir({ "00-base.yaml": estate({ integrations: [remote("snapshot")] }) });
    try {
      expect(load({ arg: dir.dir, env: SNAPSHOT_ENV }).exitClass).toBe(1);
    } finally {
      dir.cleanup();
    }
  });
});

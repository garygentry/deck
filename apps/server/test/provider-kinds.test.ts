import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defineServerModule,
  type JsonObject,
  type ModuleManifest,
  type ProviderKindHandler,
  type ProviderSpec,
  type ServerModule,
} from "@deck/module-sdk";
import { FIXTURE_DATA_SOURCES } from "@deck/schema/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { load } from "../src/config/load.js";
import { builtinComposition, composeModules } from "../src/modules/config.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { kindRuntimes, planModules, type UsableModule } from "../src/modules/host.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listProviders, read, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { testHost } from "./util/modules.js";
import { makeConfigDir } from "./util/tmp-config.js";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

function feedProvider(id: string, kind = "feed", data: unknown = { id }): ProviderSpec {
  return { id, kind, health: async () => ({ ok: true }), fetch: async () => data };
}

function kindModule(
  manifest: Partial<ModuleManifest> & { id: string },
  kinds: Record<string, ProviderKindHandler>,
): ServerModule {
  return defineServerModule({ version: "1.0.0", deckApi: "^0.1", ...manifest }, () => {}, { kinds });
}

/** The kinds owned by built-in data-source modules. */
const DATA_SOURCE_KINDS = ["link", "http-health", "docker", "gatus", "prometheus", "alertmanager", "markdown-tree", "file-tree", "snapshot"];

const estate = (extra: Partial<DeckConfig> = {}): DeckConfig =>
  ({ schemaVersion: 2, estate: { name: "kinds" }, ...extra }) as DeckConfig;

describe("module kind handlers: host checks", () => {
  const cases: Array<[string, ServerModule, string]> = [
    [
      "a bindable kind without a binding handler",
      kindModule({ id: "no-binding", providerKinds: [{ kind: "feed", bindable: true }] }, { feed: { instances: () => [] } }),
      'provider kind "feed" is bindable, but the module has no binding handler for it',
    ],
    [
      "a handler for a kind the manifest does not declare",
      kindModule({ id: "stray", providerKinds: [{ kind: "feed" }] }, { feed: {}, other: { binding: () => [] } }),
      'kinds has a handler for "other", which the manifest does not declare',
    ],
    [
      "a static kind with an instances handler",
      kindModule({ id: "static-instances", providerKinds: [{ kind: "pin", static: true }] }, { pin: { instances: () => [] } }),
      'provider kind "pin" is static, so it cannot handle instances',
    ],
    [
      "a kind declared twice",
      kindModule({ id: "twice", providerKinds: [{ kind: "feed" }, { kind: "feed" }] }, {}),
      'provider kind "feed" is declared twice',
    ],
  ];

  it.each(cases)("disables a module with %s (MODULE_MANIFEST_INVALID)", (_name, module, reason) => {
    const { host } = testHost([module]);
    expect(host.plan).toEqual([{ id: module.manifest.id, enabled: false, reason: expect.stringContaining(reason) }]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining(reason) })]);
    expect(host.kindHandlers().size).toBe(0);
  });

  it("a refused module's kinds are unknown to config validation, so its bindings are reported", () => {
    const module = kindModule({ id: "no-binding", providerKinds: [{ kind: "feed", bindable: true }] }, {});
    const { composed } = composeModules([module], { sectionOf: () => undefined, env: {} });
    expect(composed.knownKinds.has("feed")).toBe(false);
    const healthy = kindModule({ id: "feeds", providerKinds: [{ kind: "feed", bindable: true }] }, { feed: { binding: () => [] } });
    expect(composeModules([healthy], { sectionOf: () => undefined, env: {} }).composed.bindableKinds.has("feed")).toBe(true);
  });

  it("accepts a module whose bindable kinds all have binding handlers", () => {
    const module = kindModule(
      { id: "feeds", providerKinds: [{ kind: "feed", bindable: true }, { kind: "pin", static: true }] },
      { feed: { binding: () => [] }, pin: { binding: () => [] } },
    );
    const { host } = testHost([module]);
    expect(host.plan).toEqual([{ id: "feeds", enabled: true }]);
    expect([...host.kindHandlers().keys()]).toEqual(["feed", "pin"]);
    expect(host.kindHandlers().get("pin")).toMatchObject({ static: true, moduleId: "feeds", instanceList: "integrations" });
  });
});

describe("module kind handlers: env scope", () => {
  const module = kindModule(
    { id: "feeds", env: ["FEED_DECLARED"], providerKinds: [{ kind: "feed" }] },
    { feed: { instances: () => [] } },
  );
  const usable = (): UsableModule[] => [...planModules({ modules: [module], sectionOf: () => undefined, env: {} }).usable.values()];
  const env = {
    FEED_DECLARED: "declared",
    FEED_TOKEN: "token",
    SECOND_TOKEN: "second",
    OTHER_TOKEN: "other",
    UNDECLARED: "nope",
    DECK_CONFIG_DIR: "/config",
  };

  it("env reads only declared names; envFor unlocks just the credential of one issued instance", () => {
    const feed = kindRuntimes(usable(), env).get("feed")!;
    const { env: declared, envFor } = feed.context;
    expect(declared.get("FEED_DECLARED")).toBe("declared");
    expect(declared.get("FEED_TOKEN")).toBeUndefined();

    const [first, second, otherKind, kernel, malformed] = feed.issueInstances([
      { id: "a", kind: "feed", credentialEnv: "FEED_TOKEN" },
      { id: "b", kind: "feed", credentialEnv: "SECOND_TOKEN" },
      { id: "c", kind: "prometheus", credentialEnv: "OTHER_TOKEN" },
      { id: "d", kind: "feed", credentialEnv: "DECK_CONFIG_DIR" },
      { id: "e", kind: "feed", credentialEnv: "not-a-name" },
    ]);
    // Issued instances are frozen copies.
    expect(Object.isFrozen(first)).toBe(true);
    expect(envFor(first!).get("FEED_TOKEN")).toBe("token");
    expect(envFor(first!).get("FEED_DECLARED")).toBe("declared");
    // Another instance's credential is not readable through this instance's reader.
    expect(envFor(first!).get("SECOND_TOKEN")).toBeUndefined();
    expect(envFor(second!).get("FEED_TOKEN")).toBeUndefined();
    expect(envFor(second!).get("SECOND_TOKEN")).toBe("second");
    // Another kind's instance, a kernel setting and a malformed name unlock nothing.
    expect(envFor(otherKind!).get("OTHER_TOKEN")).toBeUndefined();
    expect(envFor(kernel!).get("DECK_CONFIG_DIR")).toBeUndefined();
    expect(envFor(malformed!).get("not-a-name")).toBeUndefined();
    expect(declared.get("UNDECLARED")).toBeUndefined();
  });

  it("a fabricated instance unlocks nothing: only kernel-issued objects carry a credential", () => {
    const feed = kindRuntimes(usable(), env).get("feed")!;
    const { envFor } = feed.context;
    // The probe from review: a handler invents an instance naming a secret it was never given.
    expect(envFor({ kind: "feed", credentialEnv: "FEED_TOKEN" }).get("FEED_TOKEN")).toBeUndefined();
    // A copy of an issued instance is not the issued object either.
    const [issued] = feed.issueInstances([{ id: "a", kind: "feed", credentialEnv: "FEED_TOKEN" }]);
    expect(envFor({ ...issued! }).get("FEED_TOKEN")).toBeUndefined();
    expect(envFor(issued!).get("FEED_TOKEN")).toBe("token");
    // Issued copies cannot be edited to name another credential.
    expect(() => {
      (issued as { credentialEnv: string }).credentialEnv = "SECOND_TOKEN";
    }).toThrow(TypeError);
  });

  it("a binding handler gets the declared-only reader", () => {
    const seen: Array<{ binding: string | undefined; ctx: string | undefined; frozen: boolean }> = [];
    const module = kindModule({ id: "feeds", env: ["FEED_DECLARED"], providerKinds: [{ kind: "feed", bindable: true }] }, {
      feed: {
        binding: (binding, context) => {
          seen.push({ binding: binding.env.get("FEED_TOKEN") ?? binding.env.get("FEED_DECLARED"), ctx: context.envFor(binding.value).get("FEED_TOKEN"), frozen: Object.isFrozen(binding.value) });
          return [];
        },
      },
    });
    const { host } = testHost([module], { env });
    const config = estate({ hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { feed: { credentialEnv: "FEED_TOKEN" } } }] } as Partial<DeckConfig>);
    registerAllProviders(config, host.kindHandlers());
    expect(seen).toEqual([{ binding: "declared", ctx: undefined, frozen: true }]);
  });

  it("an instance credentialEnv cannot reopen a name another module owns; sharedEnv is readable", () => {
    const owner = kindModule({ id: "owner", env: ["OWNER_TOKEN"], providerKinds: [{ kind: "owned" }] }, {});
    const feeds = kindModule({ id: "feeds", sharedEnv: ["SHARED_TOKEN"], providerKinds: [{ kind: "feed" }] }, { feed: { instances: () => [] } });
    const hostEnv = { OWNER_TOKEN: "owner-secret", SHARED_TOKEN: "shared", FEED_TOKEN: "feed" };
    const planning = planModules({ modules: [owner, feeds], sectionOf: () => undefined, env: hostEnv });
    expect(planning.plan.every((entry) => entry.enabled)).toBe(true);
    const runtimes = kindRuntimes([...planning.usable.values()], hostEnv, undefined, undefined, planning.envOwners);
    const feed = runtimes.get("feed")!;
    const { env: declared, envFor } = feed.context;
    const [foreign, own] = feed.issueInstances([
      { id: "a", kind: "feed", credentialEnv: "OWNER_TOKEN" },
      { id: "b", kind: "feed", credentialEnv: "FEED_TOKEN" },
    ]);
    expect(envFor(foreign!).get("OWNER_TOKEN")).toBeUndefined();
    expect(envFor(own!).get("FEED_TOKEN")).toBe("feed");
    expect(declared.get("SHARED_TOKEN")).toBe("shared");
    expect(declared.get("OWNER_TOKEN")).toBeUndefined();
  });

  it("a data-source module declaring a kernel setting is refused, and its kinds read as disabled", () => {
    const greedy = kindModule({ id: "greedy", env: ["DECK_DATA_DIR"], providerKinds: [{ kind: "feed" }] }, { feed: { instances: () => [] } });
    const { host } = testHost([greedy]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/greedy", message: expect.stringContaining("DECK_DATA_DIR") })]);
    expect(host.kindHandlers().size).toBe(0);
    const { composed } = composeModules([greedy], { sectionOf: () => undefined, env: {} });
    expect(composed.knownKinds.has("feed")).toBe(false);
    expect(composed.disabledKinds.get("feed")).toBe("greedy");
  });

  it("the docker provider reads only the credential of the instance it consumes", async () => {
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetchStub);
    try {
      const hostEnv = { FIRST_TOKEN: "Bearer first", SECOND_TOKEN: "Bearer second" };
      const { plan: entries, usable: modules } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: hostEnv });
      const docker = kindRuntimes(entries.filter((e) => e.enabled).map((e) => modules.get(e.id)!), hostEnv).get("docker")!;
      const offers = docker.handler.instances!(docker.issueInstances([
        { id: "one", kind: "docker", title: "One", baseUrl: "http://one", credentialEnv: "FIRST_TOKEN" },
        { id: "two", kind: "docker", title: "Two", baseUrl: "http://two", credentialEnv: "SECOND_TOKEN" },
      ]), { ...docker.context, estate: {} });
      expect(offers).toHaveLength(1);
      const config = (offers[0]!.provider as unknown as { cfg: { env: { get(name: string): string | undefined } } }).cfg;
      expect(config.env.get("FIRST_TOKEN")).toBe("Bearer first");
      expect(config.env.get("SECOND_TOKEN")).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a built-in provider cannot read an undeclared or kernel variable through its credentialEnv", async () => {
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetchStub);
    try {
      const config = estate({
        integrations: [{ id: "docker", kind: "docker", title: "Docker", baseUrl: "http://proxy", credentialEnv: "DECK_DATA_DIR" }],
      } as Partial<DeckConfig>);
      const gatus = estate({
        integrations: [{ id: "gatus", kind: "gatus", title: "Gatus", baseUrl: "http://gatus", credentialEnv: "GATUS_TOKEN" }],
      } as Partial<DeckConfig>);
      const hostEnv = { DECK_DATA_DIR: "kernel-secret", GATUS_TOKEN: "Bearer gatus", DOCKER_TOKEN: "Bearer docker" };
      const plan = (_doc: DeckConfig) => {
        const { plan: entries, usable: modules } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: hostEnv });
        return kindRuntimes(entries.filter((e) => e.enabled).map((e) => modules.get(e.id)!), hostEnv);
      };
      registerAllProviders(config, plan(config));
      startScheduler();
      await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
      // The kernel setting is not a credential the docker module may read.
      expect(fetchStub.mock.calls[0]![1]?.headers).toEqual({});
      stopScheduler();

      registerAllProviders(gatus, plan(gatus));
      startScheduler();
      await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
      expect(fetchStub.mock.calls[1]![1]?.headers).toEqual({ Authorization: "Bearer gatus" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("registerAllProviders: a loop over module-declared kind handlers", () => {
  it("routes bindings and instances to the owning module and honours the static flag", async () => {
    vi.useFakeTimers();
    const seen: { bindings: Array<{ id: string; owner: string; value: JsonObject }>; instances: JsonObject[][] } = { bindings: [], instances: [] };
    const fetchPinned = vi.fn(async () => ({ pinned: true }));
    const module = kindModule(
      { id: "feeds", providerKinds: [{ kind: "feed", bindable: true }, { kind: "pin", static: true, bindable: true }] },
      {
        feed: {
          binding: (binding) => {
            seen.bindings.push(binding);
            return [{ provider: feedProvider(binding.id), timing: { pollIntervalMs: 60_000 } }];
          },
          instances: (instances) => {
            seen.instances.push([...instances]);
            return instances.map((instance) => ({ provider: feedProvider(`feed-${String(instance.id)}`) }));
          },
        },
        pin: { binding: ({ id }) => [{ provider: { ...feedProvider(id, "pin"), fetch: fetchPinned } }] },
      },
    );
    const { host } = testHost([module]);
    const config = estate({
      hosts: [
        { name: "alpha", kind: "vm", purpose: "p", bindings: { feed: { channel: "a" }, pin: { id: "pinned" }, unhandled: { x: 1 } } },
      ],
      services: [{ host: "alpha", name: "svc", kind: "systemd", purpose: "p", bindings: { feed: { id: "custom-id" }, pin: "not-an-object" } }],
      integrations: [
        { id: "one", kind: "feed", title: "One", baseUrl: "http://one" },
        { id: "other", kind: "prometheus", title: "Prom", baseUrl: "http://prom" },
        { id: "two", kind: "feed", title: "Two", baseUrl: "http://two" },
      ],
    } as Partial<DeckConfig>);

    registerAllProviders(config, host.kindHandlers());

    expect(seen.bindings).toEqual([
      { id: "feed:host:alpha", owner: "host:alpha", value: { channel: "a" }, env: expect.objectContaining({ get: expect.any(Function) }) },
      { id: "custom-id", owner: "service:alpha:svc", value: { id: "custom-id" }, env: expect.objectContaining({ get: expect.any(Function) }) },
    ]);
    // Every instance of the kind, in document order, in one call.
    expect(seen.instances).toEqual([[expect.objectContaining({ id: "one" }), expect.objectContaining({ id: "two" })]]);
    // The prometheus integration is not this module's, and its module is not in this host.
    expect(listProviders().map(({ id }) => id)).toEqual(["custom-id", "feed-one", "feed-two", "feed:host:alpha", "pinned"]);
    // A static provider is fetched once at registration and never polled.
    await vi.advanceTimersByTimeAsync(0);
    expect(read("pinned")).toMatchObject({ kind: "pin", freshness: { state: "static" }, data: { pinned: true } });
    expect(fetchPinned).toHaveBeenCalledTimes(1);

    // Providers the kernel registered for a module stop with it.
    await host.start();
    await host.stop();
    startScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read("feed:host:alpha")?.freshness.state).toBe("pending");
  });
});

describe("kernel paths name no data-source kind", () => {
  it.each(["providers/index.ts", "providers/registry.ts", "server/boot.ts", "server/app.ts"])("%s", (file) => {
    const source = readFileSync(join(srcDir, file), "utf8");
    for (const kind of DATA_SOURCE_KINDS) {
      expect(source, `${file} names "${kind}"`).not.toMatch(new RegExp(`["'\`]${kind}["'\`]`));
      expect(source, `${file} imports the ${kind} module`).not.toContain(`/${kind}/`);
    }
  });
});

describe("the data-source modules", () => {
  const manifests = BUILTIN_MODULES.map((module) => module.manifest);
  const kinds = manifests.flatMap((manifest) => (manifest.providerKinds ?? []).map((decl) => ({ module: manifest.id, ...decl })));

  it("are one module per kind, each named for its kind", () => {
    for (const kind of DATA_SOURCE_KINDS) {
      expect(kinds.filter((decl) => decl.kind === kind)).toEqual([expect.objectContaining({ module: kind })]);
    }
    // prometheus, alertmanager and snapshot accept no bindings: a binding of them is reported.
    expect(kinds.filter((decl) => decl.bindable === true).map((decl) => decl.kind).sort()).toEqual(["docker", "gatus", "http-health", "link"]);
    expect(kinds.find((decl) => decl.kind === "link")).toMatchObject({ static: true });
    // A source is owned (`sources[].owner`), never bound: its kinds are not bindable.
    for (const kind of ["markdown-tree", "file-tree"]) {
      expect(kinds.filter((decl) => decl.kind === kind)).toEqual([
        expect.objectContaining({ module: kind, bindable: false, statusCapable: false, instanceList: "sources" }),
      ]);
    }
  });

  it("match the schema library's fixture stand-in, instance schemas included", () => {
    const pick = ({ kind, bindable, instanceList, instanceSchema }: { kind: string; bindable?: boolean; instanceList?: string; instanceSchema?: unknown }) =>
      ({ kind, bindable, ...(instanceList ? { instanceList } : {}), ...(instanceSchema ? { instanceSchema } : {}) });
    const byKind = (a: { kind: string }, b: { kind: string }) => a.kind.localeCompare(b.kind);
    const standIn = FIXTURE_DATA_SOURCES.providerKinds!.map(pick).sort(byKind);
    const declared = kinds.filter((decl) => standIn.some((entry) => entry.kind === decl.kind)).map(pick).sort(byKind);
    expect(declared).toEqual(standIn);
    expect(declared.map(({ kind }) => kind)).toEqual(["alertmanager", "docker", "file-tree", "gatus", "http-health", "link", "markdown-tree", "prometheus", "snapshot"]);
    expect(standIn.filter((entry) => "instanceSchema" in entry).map(({ kind }) => kind)).toEqual(["alertmanager", "docker", "file-tree", "gatus", "markdown-tree", "prometheus"]);
  });

  it("declare their kinds to config composition, with their integration instance schemas", () => {
    const { composed } = builtinComposition({ sectionOf: () => undefined, env: {} });
    for (const kind of DATA_SOURCE_KINDS) {
      expect(composed.knownKinds.has(kind)).toBe(true);
      expect(composed.bindableKinds.has(kind)).toBe(!["prometheus", "alertmanager", "markdown-tree", "file-tree", "snapshot"].includes(kind));
    }
    const defs = composed.schema.$defs as Record<string, unknown>;
    expect(defs.kind__docker).toBeDefined();
    expect(defs.kind__gatus).toBeDefined();
    expect(defs.kind__prometheus).toBeDefined();
    expect(defs.kind__alertmanager).toBeDefined();
  });
});

describe("a binding of a kind that is not bindable (formerly ignored silently)", () => {
  it("is reported as PROVIDER_BINDING_UNSUPPORTED, and registers nothing", () => {
    const feeds = kindModule({ id: "feeds", providerKinds: [{ kind: "feed" }] }, { feed: { instances: () => [] } });
    const estateDir = makeConfigDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "s6" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p" }] },
      "10-overlay.yaml": { schemaVersion: 2, hosts: [{ name: "alpha", bindings: { feed: { channel: "a" }, link: { href: "https://a.invalid/" } } }] },
    });
    try {
      const result = load({ arg: estateDir.dir, modules: [...BUILTIN_MODULES, feeds], env: {} });
      // Info only: the binding is ignored as before, the finding makes it visible, and the
      // config still loads (an estate shaped like this keeps booting).
      expect(result.exitClass).toBe(0);
      // Reported for the overlay layer and the merged document, as PROVIDER_KIND_UNKNOWN is.
      const unsupported = expect.objectContaining({ code: "PROVIDER_BINDING_UNSUPPORTED", severity: "info", path: "/hosts/0/bindings/feed" });
      expect(result.findings).toEqual([unsupported, unsupported]);
      const config = result.config!;
      expect(config).not.toBeNull();
      // Registration skips the binding: the module has no binding handler for it.
      const { host } = testHost([...BUILTIN_MODULES, feeds]);
      registerAllProviders(config, host.kindHandlers());
      expect(listProviders()).toEqual([{ id: "link:host:alpha", kind: "link" }]);
    } finally {
      estateDir.cleanup();
    }
  });
});

describe("fixedId: a built-in-only privilege, on instances offers only", () => {
  // An estate http-health binding takes the id "fixed"; the feed module offers the same id.
  const clashing = () => estate({
    hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { "http-health": { id: "fixed", url: "http://alpha" }, feed: { channel: "a" } } }],
    integrations: [{ id: "one", kind: "feed", title: "One", baseUrl: "http://one" }],
  } as Partial<DeckConfig>);
  const feeds = (offers: Partial<ProviderKindHandler>) =>
    kindModule({ id: "feeds", providerKinds: [{ kind: "feed", bindable: true }] }, { feed: { binding: () => [], ...offers } });
  const fixedInstance = feeds({ instances: () => [{ provider: feedProvider("fixed"), fixedId: true }] });
  const fixedBinding = feeds({ binding: () => [{ provider: feedProvider("fixed"), fixedId: true }] });

  it("a built-in's instances offer reserves its id: an estate clash fails boot", () => {
    const { host } = testHost([...BUILTIN_MODULES, fixedInstance], { builtins: new Set([...BUILTIN_MODULES, fixedInstance]) });
    expect(() => registerAllProviders(clashing(), host.kindHandlers())).toThrow(expect.objectContaining({ code: "PROVIDER_DUPLICATE_ID" }));
  });

  it("a non-built-in module's fixedId is module-chosen: on a clash the module fails and boot continues", () => {
    const { host } = testHost([...BUILTIN_MODULES, fixedInstance]);
    expect(() => registerAllProviders(clashing(), host.kindHandlers())).not.toThrow();
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_KIND_HANDLER_FAILED", path: "/modules/feeds" })]);
    expect(listProviders()).toEqual([{ id: "fixed", kind: "http-health" }]);
  });

  it("is ignored on a binding offer, even a built-in's", () => {
    const { host } = testHost([...BUILTIN_MODULES, fixedBinding], { builtins: new Set([...BUILTIN_MODULES, fixedBinding]) });
    expect(() => registerAllProviders(clashing(), host.kindHandlers())).not.toThrow();
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_KIND_HANDLER_FAILED", path: "/modules/feeds" })]);
    expect(listProviders()).toEqual([{ id: "fixed", kind: "http-health" }]);
  });
});

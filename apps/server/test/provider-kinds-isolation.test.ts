/**
 * A data-source module that is off, refused or failing is isolated: it is disabled with a
 * finding and deck keeps booting, never failing as a whole because of one module.
 */
import { defineServerModule, type ModuleManifest, type ProviderKindHandler, type ProviderSpec, type ServerModule } from "@deck/module-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { createModuleHost, kindRuntimes, ModuleManifestError, planModules } from "../src/modules/host.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listProviders, stopScheduler } from "../src/providers/registry.js";
import { captureLogger, testHost } from "./util/modules.js";
import { makeConfigDir } from "./util/tmp-config.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  stopScheduler();
  while (cleanups.length) cleanups.pop()!();
});

function feedProvider(id: string, kind = "feed"): ProviderSpec {
  return { id, kind, health: async () => ({ ok: true }), fetch: async () => ({ id }) };
}

function kindModule(manifest: Partial<ModuleManifest> & { id: string }, kinds: Record<string, ProviderKindHandler>): ServerModule {
  return defineServerModule({ version: "1.0.0", deckApi: "^0.1", ...manifest }, () => {}, { kinds });
}

function estateDir(overlay: Record<string, unknown>, base: Record<string, unknown> = {}): string {
  const made = makeConfigDir({
    "00-base.yaml": { schemaVersion: 2, estate: { name: "isolation" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p" }], ...base },
    "10-overlay.yaml": { schemaVersion: 2, ...overlay },
  });
  cleanups.push(made.cleanup);
  return made.dir;
}

/** The loaded config and module problems of a load that must have succeeded. */
function loaded(result: ReturnType<typeof load>) {
  if (result.exitClass !== 0) throw new Error(`load failed: ${JSON.stringify(result.findings)}`);
  return result;
}

const withoutDocker = BUILTIN_MODULES.filter((module) => module.manifest.id !== "docker");

describe("a module-local kind defect disables the module through config loading (C2)", () => {
  it("a kind declared twice in one module is MODULE_MANIFEST_INVALID, not a boot-failing conflict", () => {
    const twice = kindModule({ id: "twice", providerKinds: [{ kind: "feed" }, { kind: "feed" }] }, {});
    const result = load({ arg: estateDir({ hosts: [{ name: "alpha", bindings: { feed: {} } }] }), modules: [...BUILTIN_MODULES, twice], env: {} });
    expect(result.exitClass).toBe(0);
    expect(loaded(result).moduleProblems.get("twice")).toContain('provider kind "feed" is declared twice');
    // Its kind is reported as provided by an off module, at info, and the config still loads.
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "PROVIDER_KIND_DISABLED", severity: "info", path: "/hosts/0/bindings/feed" }));
    const { host } = testHost([...BUILTIN_MODULES, twice], { manifestProblems: loaded(result).moduleProblems });
    expect(host.findings).toContainEqual(expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/twice" }));
  });
});

describe("kinds of a refused or off data-source module (L3)", () => {
  // A docker module that cannot be used: bindable, but with no binding handler.
  const brokenDocker = kindModule({ id: "docker", providerKinds: [{ kind: "docker", bindable: true }] }, {});
  const overlay = {
    hosts: [{ name: "alpha", bindings: { docker: { endpoint: "alpha" }, link: { href: "https://alpha.invalid/" } } }],
    integrations: [{ id: "docker", kind: "docker", title: "Docker", baseUrl: "http://proxy" }],
  };

  it("boot-style loading reports PROVIDER_KIND_DISABLED at info and keeps the config", () => {
    const result = load({ arg: estateDir(overlay), modules: [...withoutDocker, brokenDocker], env: {} });
    expect(result.exitClass).toBe(0);
    expect(result.config).not.toBeNull();
    const disabled = result.findings.filter((finding) => finding.code === "PROVIDER_KIND_DISABLED");
    expect(disabled.map(({ path, severity }) => ({ path, severity }))).toEqual(
      expect.arrayContaining([
        { path: "/hosts/0/bindings/docker", severity: "info" },
        { path: "/integrations/0/kind", severity: "info" },
      ]),
    );
    expect(disabled[0]!.message).toContain('module "docker"');
    expect(result.findings.some((finding) => finding.code === "PROVIDER_KIND_UNKNOWN")).toBe(false);

    // The rest of the estate still registers; nothing is registered for the off kind.
    const { host } = testHost([...withoutDocker, brokenDocker], { manifestProblems: loaded(result).moduleProblems });
    registerAllProviders(result.config!, host.kindHandlers());
    expect(listProviders()).toEqual([{ id: "link:host:alpha", kind: "link" }]);
  });

  it("strict loading (what deck validate uses) reports it as a warning", () => {
    const result = load({ arg: estateDir(overlay), modules: [...withoutDocker, brokenDocker], env: {}, disabledSections: "strict" });
    expect(result.exitClass).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "PROVIDER_KIND_DISABLED", severity: "warning" }));
  });
});

describe("kind handlers are isolated and attributed (L4)", () => {
  const healthy = kindModule({ id: "steady", providerKinds: [{ kind: "steady", bindable: true }] }, {
    steady: { binding: ({ id }) => [{ provider: feedProvider(id, "steady") }] },
  });
  const config = {
    schemaVersion: 2,
    estate: { name: "l4" },
    hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { steady: {}, feed: {} } }],
    integrations: [{ id: "one", kind: "feed", title: "One", baseUrl: "http://one" }],
  } as unknown as DeckConfig;

  it.each<[string, ProviderKindHandler["binding"]]>([
    ["throws", () => { throw new Error("kaboom"); }],
    ["returns a non-list", () => ({ not: "a list" }) as never],
    ["returns an offer without a provider", () => [{ provider: { id: "x" } }] as never],
  ])("a binding handler that %s disables its module and skips all its offers", (_name, binding) => {
    const flaky = kindModule({ id: "flaky", providerKinds: [{ kind: "feed", bindable: true }] }, {
      feed: { binding, instances: (instances) => instances.map((i) => ({ provider: feedProvider(`feed-${String(i.id)}`) })) },
    });
    const { host, lines } = testHost([healthy, flaky]);
    registerAllProviders(config, host.kindHandlers());

    // Neither the failing binding nor the module's (successful) instances register.
    expect(listProviders()).toEqual([{ id: "steady:host:alpha", kind: "steady" }]);
    expect(host.plan).toEqual([
      { id: "steady", enabled: true },
      { id: "flaky", enabled: false, reason: expect.stringContaining('kind "feed": binding handler') },
    ]);
    expect(host.findings).toEqual([
      expect.objectContaining({ code: "MODULE_KIND_HANDLER_FAILED", severity: "warning", path: "/modules/flaky", message: expect.stringContaining('Module "flaky" was disabled: kind "feed"') }),
    ]);
    expect(lines).toContainEqual(expect.objectContaining({ event: "module.disabled", module: "flaky", code: "MODULE_KIND_HANDLER_FAILED" }));
    expect(host.health().modules.flaky).toMatchObject({ state: "disabled" });
  });

  it("an instances handler failure is attributed too, and the module's init never runs", async () => {
    let initRan = false;
    const flaky = defineServerModule(
      { id: "flaky", version: "1.0.0", deckApi: "^0.1", providerKinds: [{ kind: "feed" }] },
      () => { initRan = true; },
      { kinds: { feed: { instances: () => { throw new Error("no instances today"); } } } },
    );
    const { host } = testHost([flaky]);
    registerAllProviders(config, host.kindHandlers());
    expect(host.findings[0]!.message).toBe('Module "flaky" was disabled: kind "feed": instances handler threw: no instances today.');
    // The live plan drives later reads: the failed module's kinds are gone.
    expect(host.kindHandlers().has("feed")).toBe(false);
    await host.start();
    expect(initRan).toBe(false);
  });

  it("outside a module host a failing handler throws an attributed error", () => {
    const flaky = kindModule({ id: "flaky", providerKinds: [{ kind: "feed" }] }, { feed: { instances: () => null as never } });
    const planning = planModules({ modules: [flaky], sectionOf: () => undefined, env: {} });
    const runtimes = kindRuntimes([...planning.usable.values()], {});
    expect(() => registerAllProviders(config, runtimes)).toThrow('module "flaky" kind "feed": instances handler returned null, not a list of offers');
  });
});

describe("offers are checked for kind and id (N2)", () => {
  const base = {
    schemaVersion: 2,
    estate: { name: "n2" },
    hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { squat: {}, link: { href: "https://alpha.invalid/" } } }],
    integrations: [{ id: "prometheus", kind: "prometheus", title: "Prometheus", baseUrl: "http://prom" }],
  } as unknown as DeckConfig;

  function probe(binding: ProviderKindHandler["binding"]) {
    const squat = kindModule({ id: "squat", providerKinds: [{ kind: "squat", bindable: true }] }, { squat: { binding } });
    const { host } = testHost([...BUILTIN_MODULES, squat]);
    // Never a raw boot exit: the offering module is disabled and the rest registers.
    expect(() => registerAllProviders(base, host.kindHandlers())).not.toThrow();
    return host;
  }

  it("squat probe: an id the kernel already registered disables the offering module", () => {
    const host = probe(() => [{ provider: feedProvider("prometheus", "squat") }]);
    expect(host.findings).toEqual([expect.objectContaining({
      code: "MODULE_KIND_HANDLER_FAILED",
      path: "/modules/squat",
      message: 'Module "squat" was disabled: kind "squat": binding handler offered provider id "prometheus", which another provider already has.',
    })]);
    expect(listProviders()).toEqual([{ id: "link:host:alpha", kind: "link" }, { id: "prometheus", kind: "prometheus" }]);
  });

  it("spoof probe: an offer of another kind disables the offering module", () => {
    const host = probe(({ id }) => [{ provider: feedProvider(id, "prometheus") }]);
    expect(host.findings).toEqual([expect.objectContaining({
      code: "MODULE_KIND_HANDLER_FAILED",
      message: expect.stringContaining('kind "squat": binding handler offered a provider of kind "prometheus" at index 0; a handler may offer only its own kind'),
    })]);
    expect(listProviders().map(({ id }) => id)).toEqual(["link:host:alpha", "prometheus"]);
  });

  it("a module-chosen id that takes an estate id, or another module's, fails that module", () => {
    // The link binding's estate id is `link:host:alpha`.
    const host = probe(() => [{ provider: feedProvider("link:host:alpha", "squat") }]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_KIND_HANDLER_FAILED", message: expect.stringContaining('provider id "link:host:alpha"') })]);
    expect(listProviders().map(({ id }) => id)).toEqual(["link:host:alpha", "prometheus"]);
    stopScheduler();

    const twins = (id: string) => kindModule({ id, providerKinds: [{ kind: id, bindable: true }] }, { [id]: { binding: () => [{ provider: feedProvider("shared-id", id) }] } });
    const config = { ...base, hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { "twin-a": {}, "twin-b": {} } }], integrations: [] } as unknown as DeckConfig;
    const { host: twinHost } = testHost([twins("twin-a"), twins("twin-b")]);
    registerAllProviders(config, twinHost.kindHandlers());
    expect(twinHost.findings).toEqual([expect.objectContaining({ code: "MODULE_KIND_HANDLER_FAILED", path: "/modules/twin-b" })]);
    expect(listProviders()).toEqual([{ id: "shared-id", kind: "twin-a" }]);
  });

  it("two estate ids that clash still fail registration, as before modules", () => {
    const config = {
      ...base,
      hosts: [
        { name: "alpha", kind: "vm", purpose: "p", bindings: { link: { id: "same", href: "https://a.invalid/" } } },
        { name: "beta", kind: "vm", purpose: "p", bindings: { link: { id: "same", href: "https://b.invalid/" } } },
      ],
      integrations: [],
    } as unknown as DeckConfig;
    const { host } = testHost([...BUILTIN_MODULES]);
    expect(() => registerAllProviders(config, host.kindHandlers())).toThrow("Provider id already registered: same");
    expect(host.findings).toEqual([]);
  });
});

describe("a kind declared by two modules fails the host itself (L5)", () => {
  it("throws MODULE_MANIFEST_CONFLICT from createModuleHost, not only through config loading", () => {
    const one = kindModule({ id: "feed-one", providerKinds: [{ kind: "feed" }] }, {});
    const two = kindModule({ id: "feed-two", providerKinds: [{ kind: "feed" }] }, {});
    const { logger } = captureLogger();
    expect(() => createModuleHost({ modules: [one, two], sectionOf: () => undefined, env: {}, logger }))
      .toThrow(new ModuleManifestError("feed-two", 'provider kind "feed" is already declared by "feed-one"'));
  });
});

describe("kind handlers are read once (L6)", () => {
  it("validates and runs the same snapshot, even if the module's kinds change later", () => {
    let reads = 0;
    const handlers: Record<string, ProviderKindHandler> = { feed: { binding: ({ id }) => [{ provider: feedProvider(id) }] } };
    const module = {
      manifest: { id: "fickle", version: "1.0.0", deckApi: "^0.1", providerKinds: [{ kind: "feed", bindable: true }] },
      init: () => {},
      get kinds() {
        reads += 1;
        return handlers;
      },
    } as ServerModule;
    const { host } = testHost([module]);
    expect(reads).toBe(1);
    // A later mutation does not reach the validated snapshot.
    handlers.feed = {};
    const config = { schemaVersion: 2, estate: { name: "l6" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { feed: {} } }] } as unknown as DeckConfig;
    registerAllProviders(config, host.kindHandlers());
    expect(listProviders()).toEqual([{ id: "feed:host:alpha", kind: "feed" }]);
    expect(host.plan).toEqual([{ id: "fickle", enabled: true }]);
  });

  it("a kinds getter that throws is the module's own defect", () => {
    const module = {
      manifest: { id: "broken", version: "1.0.0", deckApi: "^0.1", providerKinds: [{ kind: "feed" }] },
      init: () => {},
      get kinds(): never {
        throw new Error("no");
      },
    } as ServerModule;
    const { host } = testHost([module]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining("kinds could not be read: no") })]);
  });
});

describe("data-source module health (L7)", () => {
  it("is not configured until the estate asks the module for a provider", async () => {
    const config = {
      schemaVersion: 2,
      estate: { name: "l7" },
      hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { link: { href: "https://alpha.invalid/" } } }],
    } as unknown as DeckConfig;
    const { host } = testHost([...BUILTIN_MODULES]);
    registerAllProviders(config, host.kindHandlers());
    await host.start();
    const { modules } = host.health();
    expect(modules.link).toEqual({ state: "ok" });
    expect(modules.docker).toEqual({ state: "ok", detail: "not configured" });
    expect(modules.gatus).toEqual({ state: "ok", detail: "not configured" });
    expect(modules["http-health"]).toEqual({ state: "ok", detail: "not configured" });
    await host.stop();
  });
});

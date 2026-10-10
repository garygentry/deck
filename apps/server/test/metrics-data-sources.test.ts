import type { JsonObject } from "@deck/module-sdk";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { kindRuntimes, planModules, type KindRuntime } from "../src/modules/host.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listProviders, stopScheduler } from "../src/providers/registry.js";
import { captureLogger } from "./util/modules.js";
import { makeConfigDir } from "./util/tmp-config.js";

/** The prometheus and alertmanager data-source modules: their kind handlers, end to end. */

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function runtimes(env: Record<string, string> = {}, logger?: Logger): ReadonlyMap<string, KindRuntime> {
  const { plan, usable, envOwners, builtinIds } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env, builtins: new Set(BUILTIN_MODULES) });
  return kindRuntimes(plan.filter((entry) => entry.enabled).map((entry) => usable.get(entry.id)!), env, undefined, undefined, envOwners, logger, builtinIds);
}

function offer(kind: string, instances: JsonObject[], env: Record<string, string> = {}, logger?: Logger) {
  const runtime = runtimes(env, logger).get(kind)!;
  return runtime.handler.instances!(runtime.issueInstances(instances), { ...runtime.context, estate: {} });
}

type ProviderCfg = { cfg: { summaries?: unknown; env: { get(name: string): string | undefined } } };

const estate = (extra: Partial<DeckConfig>): DeckConfig =>
  ({ schemaVersion: 2, estate: { name: "metrics" }, ...extra }) as DeckConfig;

describe("the prometheus module", () => {
  it("owns its kind: one provider `prometheus` from the first instance, under a fixed id", () => {
    const offers = offer("prometheus", [
      { id: "main", kind: "prometheus", title: "Main", baseUrl: "http://one" },
      { id: "second", kind: "prometheus", title: "Second", baseUrl: "http://two" },
    ]);
    expect(offers.map(({ provider, fixedId }) => [provider.id, provider.kind, fixedId])).toEqual([["prometheus", "prometheus", true]]);
    expect(offer("prometheus", [])).toEqual([]);
  });

  it("parses the instance's summary card, logging a dropped entry on the module's own logger", () => {
    const { logger, lines } = captureLogger();
    const [only] = offer("prometheus", [{
      id: "main", kind: "prometheus", title: "Main", baseUrl: "http://one",
      card: { summaries: [
        { id: "load", label: "Load", query: "avg(load1)", unit: "%", warning: 70, direction: "above" },
        { id: "bad", label: "Bad", query: "q", critical: 1 },
      ] },
    }], {}, logger);
    expect((only!.provider as unknown as ProviderCfg).cfg.summaries).toEqual([
      { id: "load", label: "Load", query: "avg(load1)", unit: "%", warning: 70, direction: "above" },
    ]);
    // The injected sink got the drop, scoped to the module (not the kernel's global logger).
    expect(lines).toEqual([expect.objectContaining({
      level: 40, module: "prometheus", event: "prometheus.summary.dropped", index: 1, id: "bad", reason: "direction_required",
    })]);
  });

  it("an absent or malformed card yields no summaries and never fails the handler", () => {
    for (const card of [undefined, { summaries: "nope" }, { summaries: [null] }]) {
      const [only] = offer("prometheus", [{ id: "p", kind: "prometheus", title: "P", baseUrl: "http://p", ...(card ? { card } : {}) } as JsonObject], {}, captureLogger().logger);
      expect((only!.provider as unknown as ProviderCfg).cfg.summaries).toEqual([]);
    }
  });
});

describe.each(["prometheus", "alertmanager"])("the %s module's credentials", (kind) => {
  it("reads only the credential of the instance it consumes", () => {
    const env = { FIRST_TOKEN: "Bearer first", SECOND_TOKEN: "Bearer second", DECK_DATA_DIR: "kernel" };
    const [only] = offer(kind, [
      { id: "one", kind, title: "One", baseUrl: "http://one", credentialEnv: "FIRST_TOKEN" },
      { id: "two", kind, title: "Two", baseUrl: "http://two", credentialEnv: "SECOND_TOKEN" },
    ], env);
    const reader = (only!.provider as unknown as ProviderCfg).cfg.env;
    expect(reader.get("FIRST_TOKEN")).toBe("Bearer first");
    expect(reader.get("SECOND_TOKEN")).toBeUndefined();
    expect(reader.get("DECK_DATA_DIR")).toBeUndefined();
  });

  it("cannot read a kernel setting through credentialEnv", async () => {
    const fetchStub = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input).includes("/api/v1/query")
        ? Response.json({ status: "success", data: { resultType: "scalar", result: [0, "1"] } })
        : Response.json([]));
    vi.stubGlobal("fetch", fetchStub);
    const [only] = offer(kind, [{
      id: kind, kind, title: kind, baseUrl: "http://upstream", credentialEnv: "DECK_DATA_DIR",
      ...(kind === "prometheus" ? { card: { summaries: [{ id: "up", label: "Up", query: "up" }] } } : {}),
    }], { DECK_DATA_DIR: "kernel-secret" });
    // Fetch the offered provider directly: no scheduler, no waiting.
    await only!.provider.fetch();
    expect(fetchStub).toHaveBeenCalled();
    for (const [, init] of fetchStub.mock.calls) expect(init?.headers).toEqual({});
  });
});

describe.each(["prometheus", "alertmanager"])("a %s binding (the kind is not bindable)", (kind) => {
  it("is reported as PROVIDER_BINDING_UNSUPPORTED on hosts and services, and registers nothing", () => {
    const estateDir = makeConfigDir({
      "00-base.yaml": {
        schemaVersion: 2,
        estate: { name: "bindings" },
        hosts: [{ name: "alpha", kind: "vm", purpose: "p" }],
        services: [{ host: "alpha", name: "svc", kind: "systemd", purpose: "p" }],
      },
      "10-overlay.yaml": {
        schemaVersion: 2,
        integrations: [{ id: kind, kind, title: kind, baseUrl: "http://upstream" }],
        hosts: [{ name: "alpha", bindings: { [kind]: { job: "a" } } }],
        services: [{ host: "alpha", name: "svc", bindings: { [kind]: { route: "b" } } }],
      },
    });
    try {
      const result = load({ arg: estateDir.dir, modules: [...BUILTIN_MODULES], env: {} });
      // Info only: the bindings are ignored and the estate still loads.
      expect(result.exitClass).toBe(0);
      const unsupported = (path: string) => expect.objectContaining({ code: "PROVIDER_BINDING_UNSUPPORTED", severity: "info", path });
      // Reported for the overlay layer and the merged document.
      expect(result.findings).toEqual([
        unsupported("/hosts/0/bindings/" + kind),
        unsupported("/services/0/bindings/" + kind),
        unsupported("/hosts/0/bindings/" + kind),
        unsupported("/services/0/bindings/" + kind),
      ]);
      registerAllProviders(result.config!, runtimes());
      // Only the integration's provider: no binding registered one.
      expect(listProviders()).toEqual([{ id: kind, kind }]);
    } finally {
      estateDir.cleanup();
    }
  });
});

describe.each(["prometheus", "alertmanager"])("the fixed `%s` provider id", (kind) => {
  it("stays boot-fatal when an estate provider takes it (PROVIDER_DUPLICATE_ID, as in v1)", () => {
    const config = estate({
      hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { "http-health": { id: kind, url: "http://alpha" } } }],
      integrations: [{ id: kind, kind, title: kind, baseUrl: "http://upstream" }],
    } as Partial<DeckConfig>);
    expect(() => registerAllProviders(config, runtimes())).toThrow(expect.objectContaining({ code: "PROVIDER_DUPLICATE_ID" }));
  });
});

describe("registerAllProviders with the built-in modules", () => {
  it("registers prometheus and alertmanager through their modules, one per kind", () => {
    const config = load({ arg: "test/fixtures/alerts-estate" });
    if (config.exitClass !== 0) throw new Error("alerts-estate did not load");
    registerAllProviders(config.config);
    expect(listProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "prometheus", kind: "prometheus" }),
      expect.objectContaining({ id: "alertmanager", kind: "alertmanager" }),
    ]));
    expect(listProviders().filter(({ kind }) => kind === "prometheus")).toHaveLength(1);
  });

  it("registers neither without their modules' handlers", () => {
    const config = load({ arg: "test/fixtures/alerts-estate" });
    if (config.exitClass !== 0) throw new Error("alerts-estate did not load");
    registerAllProviders(config.config, new Map());
    const kinds = listProviders().map(({ kind }) => kind);
    expect(kinds).not.toContain("prometheus");
    expect(kinds).not.toContain("alertmanager");
  });
});

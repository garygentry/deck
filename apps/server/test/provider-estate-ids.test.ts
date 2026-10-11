import { estateBindings } from "@deck/schema";
import { afterEach, describe, expect, it } from "vitest";

import { load } from "../src/config/load.js";
import type { DeckConfig } from "../src/contract/index.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { kindRuntimes, planModules, type KindRuntime } from "../src/modules/host.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listProviders, stopScheduler } from "../src/providers/registry.js";
import { makeConfigDir } from "./util/tmp-config.js";

afterEach(() => stopScheduler());

function runtimes(): ReadonlyMap<string, KindRuntime> {
  const { plan, usable, envOwners, builtinIds } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: {}, builtins: new Set(BUILTIN_MODULES) });
  return kindRuntimes(plan.filter((entry) => entry.enabled).map((entry) => usable.get(entry.id)!), {}, undefined, undefined, envOwners, undefined, builtinIds);
}

const estate = (extra: Partial<DeckConfig>): DeckConfig =>
  ({ schemaVersion: 2, estate: { name: "ids" }, ...extra }) as DeckConfig;

describe("binding provider ids: boot and validation share one derivation", () => {
  it("registers each provider-offering binding under the id estateBindings gives it", () => {
    const config = estate({
      hosts: [
        { name: "alpha", kind: "vm", purpose: "p", bindings: { "http-health": { url: "http://alpha" } } },
        { name: "beta", kind: "vm", purpose: "p", bindings: { "http-health": { id: "beta-probe", url: "http://beta" }, link: { href: "http://beta" } } },
      ],
      services: [{ host: "alpha", name: "api", kind: "systemd", purpose: "p", bindings: { "http-health": { url: "http://alpha/api" } } }],
    } as Partial<DeckConfig>);
    registerAllProviders(config, runtimes());
    const registered = listProviders().map(({ id }) => id).sort();
    const derived = estateBindings(config).map(({ id }) => id).sort();
    expect(registered).toEqual(derived);
    expect(registered).toEqual(["beta-probe", "http-health:host:alpha", "http-health:service:alpha:api", "link:host:beta"]);
  });
});

describe.each(["docker", "gatus"])("the fixed `%s` provider id", (kind) => {
  const integration = { id: `${kind}-upstream`, kind, title: kind, baseUrl: "http://upstream" };

  it("is registered under the kind's name, whatever the instance's id", () => {
    registerAllProviders(estate({ integrations: [integration] } as Partial<DeckConfig>), runtimes());
    expect(listProviders()).toEqual([{ id: kind, kind }]);
  });

  it("is reserved like an estate id: a binding that takes it fails boot (PROVIDER_DUPLICATE_ID)", () => {
    const config = estate({
      hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { "http-health": { id: kind, url: "http://alpha" } } }],
      integrations: [integration],
    } as Partial<DeckConfig>);
    expect(() => registerAllProviders(config, runtimes())).toThrow(expect.objectContaining({ code: "PROVIDER_DUPLICATE_ID" }));
  });
});

describe("a provider id shared across collections, in config loading", () => {
  const shared = (result: ReturnType<typeof load>) =>
    result.findings.filter((finding) => finding.code === "PROVIDER_ID_SHARED" || finding.code === "ID_DUPLICATE").map(({ code, severity, path }) => ({ code, severity, path }));

  it("is judged on the merged document: a binding inheriting its id from an earlier layer is no clash", () => {
    // Layer 2 gives alpha's binding an id; layer 3 changes only its url, so alone it would derive
    // `http-health:host:alpha`, which beta's binding uses explicitly. Merged, alpha keeps
    // `alpha-probe` and nothing is shared.
    const dir = makeConfigDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "layers" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p" }, { name: "beta", kind: "vm", purpose: "p" }] },
      "10-overlay.yaml": { schemaVersion: 2, hosts: [{ name: "alpha", bindings: { "http-health": { id: "alpha-probe", url: "https://a.invalid/" } } }] },
      "20-overlay.yaml": {
        schemaVersion: 2,
        hosts: [
          { name: "alpha", bindings: { "http-health": { url: "https://a2.invalid/" } } },
          { name: "beta", bindings: { "http-health": { id: "http-health:host:alpha", url: "https://b.invalid/" } } },
        ],
      },
    });
    try {
      const result = load({ arg: dir.dir, env: {}, disabledSections: "strict" });
      expect(shared(result)).toEqual([]);
      expect(result.exitClass).toBe(0);
    } finally {
      dir.cleanup();
    }
  });

  const clashing = () =>
    makeConfigDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "shared" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p" }] },
      "10-overlay.yaml": {
        schemaVersion: 2,
        hosts: [{ name: "alpha", bindings: { docker: { id: "containers" } } }],
        integrations: [{ id: "containers", kind: "docker", title: "Docker", baseUrl: "http://docker.invalid" }],
      },
    });

  it("is reported once, as a warning, by deck validate", () => {
    const dir = clashing();
    try {
      const result = load({ arg: dir.dir, env: {}, disabledSections: "strict" });
      expect(shared(result)).toEqual([{ code: "PROVIDER_ID_SHARED", severity: "warning", path: "/hosts/0/bindings/docker" }]);
      expect(result.exitClass).toBe(1);
    } finally {
      dir.cleanup();
    }
  });

  it("is info when loading for boot, so an estate that registers no clash still starts", () => {
    const dir = clashing();
    try {
      const result = load({ arg: dir.dir, env: {}, boot: true });
      expect(shared(result)).toEqual([{ code: "PROVIDER_ID_SHARED", severity: "info", path: "/hosts/0/bindings/docker" }]);
      expect(result.exitClass).toBe(0);
      // A docker binding registers nothing, and the instance registers as `docker`: no clash.
      registerAllProviders(result.config!, runtimes());
      expect(listProviders()).toEqual([{ id: "docker", kind: "docker" }]);
    } finally {
      dir.cleanup();
    }
  });
});

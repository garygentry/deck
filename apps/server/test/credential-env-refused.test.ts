import type { JsonObject } from "@deck/module-sdk";
import { describe, expect, it } from "vitest";

import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { kindRuntimes, planModules, type KindRuntime } from "../src/modules/host.js";
import { captureLogger, testModule } from "./util/modules.js";
import { makeConfigDir } from "./util/tmp-config.js";

const ENV = {
  DECK_DATA_DIR: "kernel-value",
  DECK_SNAPSHOT_SOURCE: "snapshot-value",
  GATUS_TOKEN: "Bearer gatus",
};

function runtimes(logger: ReturnType<typeof captureLogger>["logger"]): ReadonlyMap<string, KindRuntime> {
  const { plan, usable, envOwners, builtinIds } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: ENV, builtins: new Set(BUILTIN_MODULES) });
  return kindRuntimes(plan.filter((entry) => entry.enabled).map((entry) => usable.get(entry.id)!), ENV, undefined, undefined, envOwners, logger, builtinIds);
}

const instance = (kind: string, id: string, credentialEnv: string): JsonObject =>
  ({ id, kind, title: id, baseUrl: "http://upstream", credentialEnv });

describe("a refused credentialEnv at boot", () => {
  it.each([
    ["a kernel setting", "DECK_DATA_DIR", "a deployment setting the kernel reads"],
    ["another module's setting", "DECK_SNAPSHOT_SOURCE", 'module "snapshot"\'s setting'],
  ])("logs a warn naming %s, never its value, and unlocks nothing", (_label, name, reason) => {
    const { logger, lines } = captureLogger();
    const gatus = runtimes(logger).get("gatus")!;
    const [issued] = gatus.issueInstances([instance("gatus", "status", name)]);
    expect(gatus.context.envFor(issued).get(name)).toBeUndefined();
    const warns = lines.filter((line) => line.event === "provider.credential-env-refused");
    expect(warns).toEqual([
      expect.objectContaining({ level: 40, module: "gatus", kind: "gatus", instance: "status", env: name, reason, msg: `module may not read credentialEnv ${name}: it is ${reason}` }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(ENV[name as keyof typeof ENV]);
  });

  it("logs nothing for a name the module may read, and unlocks it", () => {
    const { logger, lines } = captureLogger();
    const gatus = runtimes(logger).get("gatus")!;
    const [issued] = gatus.issueInstances([instance("gatus", "status", "GATUS_TOKEN")]);
    expect(gatus.context.envFor(issued).get("GATUS_TOKEN")).toBe("Bearer gatus");
    expect(lines.filter((line) => line.event === "provider.credential-env-refused")).toEqual([]);
  });
});

describe("a refused credentialEnv in config validation", () => {
  // Integrations and sources are overlay-owned.
  const overlay = {
    schemaVersion: 2,
    integrations: [
      instance("docker", "containers", "DECK_DATA_DIR"),
      instance("gatus", "status", "GATUS_TOKEN"),
      instance("prometheus", "prom", "DECK_SNAPSHOT_SOURCE"),
    ],
    sources: [{ id: "runbooks", kind: "markdown-tree", title: "Runbooks", location: { repo: "https://example.test/r.git" }, credentialEnv: "DECK_PORT" }],
  };
  const base = {
    schemaVersion: 2,
    estate: { name: "credentials" },
  };
  const layers = { "00-base.yaml": base, "10-overlay.yaml": overlay };

  const refused = (result: ReturnType<typeof load>) =>
    result.findings.filter((finding) => finding.code === "MODULE_CREDENTIAL_ENV_REFUSED").map(({ path, severity, message }) => ({ path, severity, message }));

  it("reports each refused name, for every kind and instance list, at warning under deck validate", () => {
    const dir = makeConfigDir(layers);
    try {
      const result = load({ arg: dir.dir, env: {}, disabledSections: "strict" });
      // The refusals alone fail validation.
      expect(new Set(result.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.code))).toEqual(new Set(["MODULE_CREDENTIAL_ENV_REFUSED"]));
      expect(result.exitClass).toBe(1);
      expect(refused(result)).toEqual([
        {
          path: "/integrations/0/credentialEnv",
          severity: "warning",
          message: 'integrations "containers" (kind "docker"): module "docker" may not read credentialEnv DECK_DATA_DIR: it is a deployment setting the kernel reads.',
        },
        {
          path: "/integrations/2/credentialEnv",
          severity: "warning",
          message: 'integrations "prom" (kind "prometheus"): module "prometheus" may not read credentialEnv DECK_SNAPSHOT_SOURCE: it is module "snapshot"\'s setting.',
        },
        {
          path: "/sources/0/credentialEnv",
          severity: "warning",
          message: 'sources "runbooks" (kind "markdown-tree"): module "markdown-tree" may not read credentialEnv DECK_PORT: it is a deployment setting the kernel reads.',
        },
      ]);
    } finally {
      dir.cleanup();
    }
  });

  it("keeps warning under deck validate --advisory-disabled: the flag is about switched-off modules", () => {
    const dir = makeConfigDir(layers);
    try {
      const result = load({ arg: dir.dir, env: {}, disabledSections: "advisory" });
      expect(result.exitClass).toBe(1);
      expect(refused(result).map(({ severity }) => severity)).toEqual(["warning", "warning", "warning"]);
    } finally {
      dir.cleanup();
    }
  });

  it("reports the same findings as info when loading for boot, so boot continues", () => {
    const dir = makeConfigDir(layers);
    try {
      const result = load({ arg: dir.dir, env: {}, boot: true });
      expect(result.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
      expect(result.exitClass).toBe(0);
      expect(refused(result).map(({ path, severity }) => [path, severity])).toEqual([
        ["/integrations/0/credentialEnv", "info"],
        ["/integrations/2/credentialEnv", "info"],
        ["/sources/0/credentialEnv", "info"],
      ]);
    } finally {
      dir.cleanup();
    }
  });
});

describe("a refused credentialEnv for a module that is switched off", () => {
  // A third-party data source that runs only when FEED_ENABLED is true.
  const feeds = testModule({ id: "feeds", enabledBy: { env: "FEED_ENABLED" }, providerKinds: [{ kind: "feed" }] });
  const layers = {
    "00-base.yaml": { schemaVersion: 2, estate: { name: "off" } },
    "10-overlay.yaml": { schemaVersion: 2, integrations: [instance("feed", "news", "DECK_PORT")] },
  };
  const refused = (result: ReturnType<typeof load>) =>
    result.findings.filter((finding) => finding.code === "MODULE_CREDENTIAL_ENV_REFUSED").map(({ severity, message }) => ({ severity, message }));

  it("is checked by strict deck validate, as what would fail when it is enabled", () => {
    const dir = makeConfigDir(layers);
    try {
      expect(refused(load({ arg: dir.dir, env: {}, modules: [...BUILTIN_MODULES, feeds], disabledSections: "strict" }))).toEqual([
        {
          severity: "warning",
          message: 'would fail when "feeds" is enabled: integrations "news" (kind "feed"): module "feeds" may not read credentialEnv DECK_PORT: it is a deployment setting the kernel reads.',
        },
      ]);
    } finally {
      dir.cleanup();
    }
  });

  it("is not checked when loading for boot, or with --advisory-disabled", () => {
    const dir = makeConfigDir(layers);
    try {
      expect(refused(load({ arg: dir.dir, env: {}, modules: [...BUILTIN_MODULES, feeds], boot: true }))).toEqual([]);
      expect(refused(load({ arg: dir.dir, env: {}, modules: [...BUILTIN_MODULES, feeds], disabledSections: "advisory" }))).toEqual([]);
    } finally {
      dir.cleanup();
    }
  });
});

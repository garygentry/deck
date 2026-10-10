/**
 * The `snapshot` data source is a module: it owns DECK_SNAPSHOT_SOURCE, the kernel names no
 * snapshot, and a malformed source still fails boot through the built-in-only
 * BootFatalError. Also covers the two SDK additions it needed: `ProviderKindContext.estate`
 * and `BootFatalError`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BootFatalError, defineServerModule, type ProviderKindContext, type ProviderSpec, type ServerModule } from "@deck/module-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { KERNEL_ENV_NAMES } from "../src/modules/context.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listProviders, stopScheduler } from "../src/providers/registry.js";
import { SNAPSHOT_MANIFEST, snapshotModule } from "../../../modules/snapshot/server/module.js";
import { testHost } from "./util/modules.js";

afterEach(() => stopScheduler());

const config = {
  schemaVersion: 2,
  estate: { name: "snapshot-module" },
  hosts: [{ name: "alpha", kind: "vm", purpose: "p" }],
} as unknown as DeckConfig;

function feedProvider(id: string): ProviderSpec {
  return { id, kind: "feed", health: async () => ({ ok: true }), fetch: async () => ({ id }) };
}

/** A module whose `feed` instances handler throws a BootFatalError. */
function fatalModule(): ServerModule {
  return defineServerModule(
    { id: "fatal", version: "1.0.0", deckApi: "^0.1", providerKinds: [{ kind: "feed" }] },
    () => {},
    { kinds: { feed: { instances: () => { throw new BootFatalError("feed source is malformed"); } } } },
  );
}

describe("the snapshot module owns its kind and variable", () => {
  it("is a built-in that owns DECK_SNAPSHOT_SOURCE, which is no longer a kernel setting", () => {
    expect(BUILTIN_MODULES).toContain(snapshotModule);
    expect(SNAPSHOT_MANIFEST.env).toEqual(["DECK_SNAPSHOT_SOURCE"]);
    expect(KERNEL_ENV_NAMES.has("DECK_SNAPSHOT_SOURCE")).toBe(false);
    expect(SNAPSHOT_MANIFEST.providerKinds).toEqual([{ kind: "snapshot", fixedId: "snapshot", fixedIdEnv: "DECK_SNAPSHOT_SOURCE", statusCapable: false }]);
  });

  it("leaves no snapshot name in the kernel files it used to touch", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files = [
      "apps/server/src/server/boot.ts",
      "apps/server/src/server/app.ts",
      "apps/server/src/providers/index.ts",
      "packages/schema/src/compose/builtin.ts",
    ];
    for (const file of files) {
      expect(readFileSync(`${root}${file}`, "utf8"), file).not.toMatch(/snapshot/i);
    }
    // The kernel env list keeps only the entrypoint's DECK_SNAPSHOT_OUT.
    const context = readFileSync(`${root}apps/server/src/modules/context.ts`, "utf8");
    expect(context.match(/DECK_SNAPSHOT_[A-Z_]+/g)).toEqual(["DECK_SNAPSHOT_OUT"]);
  });

  it("registers the singleton only when the variable is set, with the estate it validates against", () => {
    const { host: off } = testHost([snapshotModule]);
    registerAllProviders(config, off.kindHandlers());
    expect(listProviders()).toEqual([]);
    stopScheduler();

    const { host: on } = testHost([snapshotModule], { env: { DECK_SNAPSHOT_SOURCE: "/srv/snapshot.json" } });
    registerAllProviders(config, on.kindHandlers());
    expect(listProviders()).toEqual([{ id: "snapshot", kind: "snapshot" }]);
  });
});

describe("BootFatalError is a built-in-only privilege", () => {
  it("a built-in's BootFatalError fails registration (boot then exits 2)", () => {
    const fatal = fatalModule();
    const { host } = testHost([fatal], { builtins: new Set([fatal]) });
    expect(() => registerAllProviders(config, host.kindHandlers())).toThrow(BootFatalError);
    expect(listProviders()).toEqual([]);
  });

  it("any other module's BootFatalError only disables that module", () => {
    const steady = defineServerModule(
      { id: "steady", version: "1.0.0", deckApi: "^0.1", providerKinds: [{ kind: "steady" }] },
      () => {},
      { kinds: { steady: { instances: () => [{ provider: { ...feedProvider("steady"), kind: "steady" } }] } } },
    );
    const { host } = testHost([fatalModule(), steady]);
    expect(() => registerAllProviders(config, host.kindHandlers())).not.toThrow();
    expect(listProviders()).toEqual([{ id: "steady", kind: "steady" }]);
    expect(host.plan).toContainEqual({ id: "fatal", enabled: false, reason: 'Module "fatal" was disabled: kind "feed": instances handler threw.' });
  });
});

describe("ProviderKindContext.estate", () => {
  it("is a deep-frozen copy of the validated estate, the same for every handler", () => {
    const seen: ProviderKindContext[] = [];
    const probe = (id: string, kind: string) =>
      defineServerModule(
        { id, version: "1.0.0", deckApi: "^0.1", providerKinds: [{ kind }] },
        () => {},
        { kinds: { [kind]: { instances: (_instances: unknown, context: ProviderKindContext) => (seen.push(context), []) } } },
      );
    const { host } = testHost([probe("one", "one"), probe("two", "two")]);
    registerAllProviders(config, host.kindHandlers());

    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    expect(first!.estate).toEqual(config);
    expect(first!.estate).not.toBe(config);
    expect(second!.estate).toBe(first!.estate);
    expect(Object.isFrozen(first!.estate)).toBe(true);
    expect(Object.isFrozen((first!.estate.hosts as unknown[])[0])).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

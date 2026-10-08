/**
 * The drift module's manifest: its identity and UI contributions are the copy the web half
 * registers against.
 */

import { DRIFT_UI } from "@deck/contract/modules/drift";
import type { ModuleManifest, WebModuleManifest } from "@deck/module-sdk";
import { describe, expect, it } from "vitest";

import { DRIFT_MANIFEST } from "../src/drift/module.js";

/** Every manifest field the web half does not read; listing them all is checked by the type. */
const SERVER_ONLY: Record<Exclude<keyof ModuleManifest, keyof WebModuleManifest>, true> = {
  dependsOn: true,
  enabledBy: true,
  env: true,
  sharedEnv: true,
  envFromConfig: true,
  config: true,
  providerKinds: true,
  services: true,
  health: true,
  dataDir: true,
};

describe("drift module", () => {
  it("takes its identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes } = DRIFT_MANIFEST;
    expect({ id, version, deckApi, contributes }).toEqual(DRIFT_UI);
    expect(contributes).toBe(DRIFT_UI.contributes);
  });

  it("keeps its server-only fields out of the shared copy", () => {
    expect(DRIFT_MANIFEST.dependsOn).toEqual(["snapshot"]);
    for (const key of Object.keys(SERVER_ONLY)) expect(DRIFT_UI, key).not.toHaveProperty(key);
  });
});

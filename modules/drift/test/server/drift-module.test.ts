/**
 * The drift module's manifest: its identity and UI contributions are the copy the web half
 * registers against.
 */

import { DRIFT_UI } from "../../contract.js";
import { describe, expect, it } from "vitest";

import { DRIFT_MANIFEST } from "../../server/module.js";
import { serverOnlyFields } from "../../../../apps/server/test/util/shared-ui.js";

describe("drift module", () => {
  it("takes its identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes } = DRIFT_MANIFEST;
    expect({ id, version, deckApi, contributes }).toEqual(DRIFT_UI);
    expect(contributes).toBe(DRIFT_UI.contributes);
  });

  it("keeps its server-only fields out of the shared copy", () => {
    expect(DRIFT_MANIFEST.dependsOn).toEqual(["snapshot", "inventory"]);
    expect(serverOnlyFields(DRIFT_UI)).toEqual([]);
  });
});

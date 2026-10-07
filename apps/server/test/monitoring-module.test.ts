import { MONITORING_UI } from "@deck/contract/modules/monitoring";
import { describe, expect, it } from "vitest";

import { MONITORING_MANIFEST } from "../src/monitoring/module.js";

describe("monitoring module", () => {
  it("takes its identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes } = MONITORING_MANIFEST;
    expect({ id, version, deckApi, contributes }).toEqual(MONITORING_UI);
    expect(contributes).toBe(MONITORING_UI.contributes);
    // It renders what the alerting and metrics data sources provide: no config, no server code.
    expect(Object.keys(MONITORING_MANIFEST).sort()).toEqual(["contributes", "deckApi", "id", "version"]);
  });
});

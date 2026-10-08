import { MONITORING_UI } from "@deck/contract/modules/monitoring";
import { describe, expect, it } from "vitest";

import { METRICS_MANIFEST } from "../src/metrics/module.js";
import { MONITORING_MANIFEST } from "../src/monitoring/module.js";
import { serverOnlyFields } from "./util/shared-ui.js";

describe("monitoring module", () => {
  it("takes its identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes } = MONITORING_MANIFEST;
    expect({ id, version, deckApi, contributes }).toEqual(MONITORING_UI);
    expect(contributes).toBe(MONITORING_UI.contributes);
    // It renders what the alerting and metrics data sources provide: no config, no server code.
    expect(serverOnlyFields(MONITORING_MANIFEST)).toEqual([]);
  });

  it("is the only module the alerts-and-health web half serves: metrics contributes no UI", () => {
    // Only its root path; no pages, nav, slots, extensions or widget types for a web half to register.
    expect(Object.keys(METRICS_MANIFEST.contributes ?? {})).toEqual(["routes"]);
  });
});

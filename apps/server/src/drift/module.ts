import { DRIFT_UI } from "@deck/contract/modules/drift";
import { defineServerModule, type ModuleManifest } from "@deck/module-sdk";

/**
 * The drift module: the drift and coverage page, its topbar summary pill and the findings
 * sections on the host and service detail pages. It reads the snapshot provider and derives
 * its projection where it renders, so it has no config section and no server code.
 */
export const DRIFT_MANIFEST: ModuleManifest = {
  // Identity and UI contributions are shared with the web half.
  ...DRIFT_UI,
  // Drift is derived from the snapshot provider: without the snapshot module there is nothing to show.
  dependsOn: ["snapshot"],
};

export const driftModule = defineServerModule(DRIFT_MANIFEST, () => {});

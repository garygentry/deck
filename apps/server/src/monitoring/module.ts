import { MONITORING_UI } from "@deck/contract/modules/monitoring";
import { defineServerModule, type ModuleManifest } from "@deck/module-sdk";

/**
 * The monitoring module: the monitoring page and the alerts and metrics topbar pills. It
 * renders what the alerting and metrics data sources provide, so it has no config section
 * and no server code.
 */
export const MONITORING_MANIFEST: ModuleManifest = {
  // Identity and UI contributions are shared with the web half.
  ...MONITORING_UI,
};

export const monitoringModule = defineServerModule(MONITORING_MANIFEST, () => {});

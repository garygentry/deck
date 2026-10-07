import { defineServerModule, type ModuleManifest } from "@deck/module-sdk";

/**
 * The monitoring module: the monitoring page and the alerts and metrics topbar pills. It
 * renders what the alerting and metrics data sources provide, so it has no config section
 * and no server code.
 */
export const MONITORING_MANIFEST: ModuleManifest = {
  id: "monitoring",
  version: "0.1.0",
  deckApi: "^0.1",
  contributes: {
    pages: [{ id: "page:monitoring/overview", path: "/monitoring", title: "Monitoring", icon: "activity", component: "MonitoringPage" }],
    nav: [{ id: "nav:monitoring/overview", page: "page:monitoring/overview", group: "health" }],
    extensions: [
      { id: "pill:monitoring/alerts", kind: "pill", attachTo: { slot: "app/topbar.status", order: 10 }, component: "AlertsSummary" },
      { id: "pill:monitoring/metrics", kind: "pill", attachTo: { slot: "app/topbar.status", order: 20 }, component: "MetricsSummary" },
    ],
  },
};

export const monitoringModule = defineServerModule(MONITORING_MANIFEST, () => {});

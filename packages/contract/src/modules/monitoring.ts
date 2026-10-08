import type { WebModuleManifest } from "@deck/module-sdk";

/**
 * The monitoring module's identity and UI contributions: the monitoring page, its nav entry,
 * and the alerts and metrics topbar pills. The server's manifest spreads this in, and the web
 * half registers its component table against it, so both read one copy of where each
 * contribution attaches. It is data only (no runtime imports), so the browser bundle can load it.
 */
export const MONITORING_UI: WebModuleManifest = {
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

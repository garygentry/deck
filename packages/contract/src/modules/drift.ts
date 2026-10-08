import type { WebModuleManifest } from "@deck/module-sdk";

/**
 * The drift module's identity and UI contributions: the drift and coverage page, its nav entry,
 * the topbar summary pill, and the findings sections on the host and service detail pages. The
 * server's manifest spreads this in, and the web half registers its component table against it,
 * so both read one copy of where each contribution attaches. It is data only (no runtime
 * imports), so the browser bundle can load it.
 */
export const DRIFT_UI: WebModuleManifest = {
  id: "drift",
  version: "0.1.0",
  deckApi: "^0.1",
  contributes: {
    pages: [{ id: "page:drift/overview", path: "/drift", title: "Drift", icon: "git-compare", component: "DriftPage" }],
    nav: [{ id: "nav:drift/overview", page: "page:drift/overview", group: "health" }],
    extensions: [
      { id: "pill:drift/summary", kind: "pill", attachTo: { slot: "app/topbar.status" }, component: "DriftHealthSummary" },
      {
        id: "section:drift/host-findings",
        kind: "entity-section",
        attachTo: { slot: "entity:host/sections", order: 10 },
        component: "FindingsFragment",
        config: { section: "findings", title: "Findings" },
      },
      {
        id: "section:drift/service-findings",
        kind: "entity-section",
        attachTo: { slot: "entity:service/sections", order: 10 },
        component: "FindingsFragment",
        config: { section: "findings", title: "Findings" },
      },
    ],
  },
};

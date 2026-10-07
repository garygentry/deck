import { defineServerModule, type ModuleManifest } from "@deck/module-sdk";

/**
 * The drift module: the drift and coverage page, its topbar summary pill and the findings
 * sections on the host and service detail pages. It reads the snapshot provider and derives
 * its projection where it renders, so it has no config section and no server code.
 */
export const DRIFT_MANIFEST: ModuleManifest = {
  id: "drift",
  version: "0.1.0",
  deckApi: "^0.1",
  // Drift is derived from the snapshot provider: without the snapshot module there is nothing to show.
  dependsOn: ["snapshot"],
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

export const driftModule = defineServerModule(DRIFT_MANIFEST, () => {});

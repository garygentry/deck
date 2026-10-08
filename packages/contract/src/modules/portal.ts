import type { WebModuleManifest } from "@deck/module-sdk";

/** The widget slot the portal page hosts, under its header: summary cards other modules attach. */
export const PORTAL_SUMMARY_SLOT = "portal/summary";

/**
 * The portal module's identity and UI contributions: its launch page, nav entry, the
 * `portal/summary` widget slot it hosts and its endpoint pill. The server's manifest spreads
 * this in, and the web half registers its component table against it, so both read one copy
 * of where each contribution attaches. It is data only (no runtime imports), so the browser
 * bundle can load it.
 */
export const PORTAL_UI: WebModuleManifest = {
  id: "portal",
  version: "0.1.0",
  deckApi: "^0.1",
  contributes: {
    pages: [{ id: "page:portal/overview", path: "/portal", title: "Portal", icon: "layout-grid", component: "PortalPage" }],
    nav: [{ id: "nav:portal/overview", page: "page:portal/overview", group: "overview", order: -1 }],
    slots: [{ id: PORTAL_SUMMARY_SLOT, accepts: "widget" }],
    extensions: [
      { id: "pill:portal/endpoints", kind: "pill", attachTo: { slot: "app/topbar.status" }, component: "EndpointStatusSummary" },
    ],
  },
};

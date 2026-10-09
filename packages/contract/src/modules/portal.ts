import type { WebModuleManifest } from "@deck/module-sdk";

/** The widget slot the portal page hosts, under its header: summary cards other modules attach. */
export const PORTAL_SUMMARY_SLOT = "portal/summary";

/** The portal's widget type: the groups of cards, with search and the status and group filters. */
export const PORTAL_GROUPS_WIDGET = "portal/groups";

/**
 * The portal module's identity and UI contributions: its launch page, nav entry, the
 * `portal/summary` widget slot it hosts, its endpoint pill and its `portal/groups` widget type.
 * The page is a dashboard: its default layout is the `portal/summary` slot over one
 * `portal/groups` widget showing every group, which the page renders without card chrome. The server's manifest spreads
 * this in, and the web half registers its component table against it, so both read one copy
 * of where each contribution attaches. It is data only (no runtime imports), so the browser
 * bundle can load it.
 */
export const PORTAL_UI: WebModuleManifest = {
  id: "portal",
  version: "0.1.0",
  deckApi: "^0.1",
  contributes: {
    pages: [
      {
        id: "page:portal/overview",
        path: "/portal",
        title: "Portal",
        icon: "layout-grid",
        component: "PortalPage",
        layout: { sections: [{ slot: PORTAL_SUMMARY_SLOT }, { widgets: [{ id: "groups", type: PORTAL_GROUPS_WIDGET }] }] },
      },
    ],
    nav: [{ id: "nav:portal/overview", page: "page:portal/overview", group: "overview", order: -1 }],
    slots: [{ id: PORTAL_SUMMARY_SLOT, accepts: "widget" }],
    widgetTypes: [
      {
        type: PORTAL_GROUPS_WIDGET,
        component: "PortalGroupsWidget",
        optionReferences: [{ option: "groups", list: "groups", key: "id" }],
        optionsSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            groups: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 256 },
              description: "The top-level groups shown (modules.portal.groups ids), in this order; default every group, in the portal's order.",
            },
          },
        },
      },
    ],
    extensions: [
      { id: "pill:portal/endpoints", kind: "pill", attachTo: { slot: "app/topbar.status" }, component: "EndpointStatusSummary" },
    ],
  },
};

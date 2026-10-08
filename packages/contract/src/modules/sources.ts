import type { WebModuleManifest } from "@deck/module-sdk";

/**
 * The sources module's identity and UI contributions: the Docs and Configs pages in the
 * knowledge nav group, and the owned-configs section on the host and service detail pages
 * (one extension per entity, both rendering the same component in the shared `configs`
 * section). The server's manifest spreads this in, adding its browsing routes, and the web half
 * registers its component table against it, so both read one copy of where each contribution
 * attaches. It is data only (no runtime imports), so the browser bundle can load it.
 */
export const SOURCES_UI: WebModuleManifest = {
  id: "sources",
  version: "0.1.0",
  deckApi: "^0.1",
  contributes: {
    pages: [
      { id: "page:sources/docs", path: "/docs", title: "Docs", icon: "book-open", component: "DocsPage" },
      { id: "page:sources/configs", path: "/configs", title: "Configs", icon: "file-cog", component: "ConfigsPage" },
    ],
    nav: [
      { id: "nav:sources/docs", page: "page:sources/docs", group: "knowledge" },
      { id: "nav:sources/configs", page: "page:sources/configs", group: "knowledge" },
    ],
    extensions: [
      {
        id: "section:sources/host-configs",
        kind: "entity-section",
        attachTo: { slot: "entity:host/sections", order: 20 },
        component: "OwnedConfigsFragment",
        config: { section: "configs", title: "Configs" },
      },
      {
        id: "section:sources/service-configs",
        kind: "entity-section",
        attachTo: { slot: "entity:service/sections", order: 20 },
        component: "OwnedConfigsFragment",
        config: { section: "configs", title: "Configs" },
      },
    ],
  },
};

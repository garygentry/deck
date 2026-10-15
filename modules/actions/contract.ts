import type { WebModuleManifest } from "@deck/module-sdk";

/**
 * The governed-actions module's identity and UI contributions: the Actions page and its nav
 * entry in the operate group. The server's manifest spreads this in (adding its routes, whose
 * refusal bodies are server code), and the web half registers its component table against it,
 * so both read one copy of where each contribution attaches. It is data only (no runtime
 * imports), so the browser bundle can load it.
 */
export const ACTIONS_UI: WebModuleManifest = {
  id: "actions",
  version: "1.0.0",
  deckApi: "^0.1",
  contributes: {
    pages: [{ id: "page:actions/overview", path: "/actions", title: "Actions", icon: "zap", component: "ActionsPage" }],
    nav: [{ id: "nav:actions/overview", page: "page:actions/overview", group: "operate" }],
  },
};

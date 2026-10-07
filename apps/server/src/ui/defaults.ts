import type { UiNavGroup } from "@deck/module-sdk";

/** The brand title when the estate has no name. */
export const DEFAULT_BRAND_TITLE = "Deck";

/** The parts of the `ui` config the resolver reads. */
export interface UiDefaults {
  nav: {
    /** Nav groups in sidebar order, with their headings; groups not listed follow by id. */
    groups: readonly UiNavGroup[];
  };
}

/**
 * The built-in ui config: what an estate renders when its config sets nothing. The nav
 * groups the built-in modules use, in sidebar order.
 */
export const DEFAULT_UI: UiDefaults = {
  nav: {
    groups: [
      { id: "overview", label: "Overview" },
      { id: "inventory", label: "Inventory" },
      { id: "health", label: "Health" },
      { id: "operate", label: "Operate" },
      { id: "knowledge", label: "Knowledge" },
    ],
  },
};

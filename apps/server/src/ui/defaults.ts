import type { UiNavGroup } from "@deck/module-sdk";

/** The brand title when the estate has no name. */
export const DEFAULT_BRAND_TITLE = "Deck";

/** The parts of the `ui` config the resolver reads. */
export interface UiDefaults {
  /** `ui.brand`: each field set replaces the default (the title defaults to the estate's name). */
  brand?: { title?: string; icon?: string; logoUrl?: string };
  /** `ui.home`: the id of the page `/` renders; the built-in default (`DEFAULT_HOME_PAGE`) when unset. */
  home?: string;
  nav: {
    /** The built-in nav groups in their default sidebar order, with their headings. */
    groups: readonly UiNavGroup[];
    /**
     * `ui.nav.groups`: groups in sidebar order, ahead of the built-in ones it does not list. A
     * label or icon it sets replaces the built-in one; a group that is not built in is new.
     */
    configured?: readonly UiNavGroupConfig[];
    /** `ui.nav.items`: the link entries and separators the config adds. */
    items?: readonly UiNavItemConfig[];
  };
}

/** One `ui.nav.groups` entry. */
export interface UiNavGroupConfig {
  id: string;
  label?: string;
  icon?: string;
}

/** One `ui.nav.items` entry: a link to an external URL, or a separator. */
export type UiNavItemConfig =
  | { id: string; group: string; label: string; href: string; icon?: string; order?: number }
  | { id: string; group: string; separator: true; order?: number };

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

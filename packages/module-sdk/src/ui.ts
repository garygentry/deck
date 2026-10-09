import type { JsonObject } from "./json.js";
import type { ExtensionId, SlotDecl, StatusMapData } from "./manifest.js";

/**
 * The resolved UI manifest served at `GET /api/ui`: which modules are installed, and which of
 * their pages, nav entries, slots and extensions render, where and with what config, after
 * config overrides. The web shell renders from it; it is plain JSON.
 */
export interface UiManifest {
  /** Version of this document's shape. */
  uiApi: 1;
  /** The shell's brand: the estate's name unless config sets one. */
  brand: UiBrand;
  /**
   * The page rendered at `/`: `ui.home` when it names a routed page with no path parameters,
   * else the portal's overview. `null` when neither is routed (then `/` is not found). Absent
   * only from an older server.
   */
  home?: UiHome | null;
  /** Every known module (enabled or not), by id. */
  modules: UiModule[];
  /** Slots that enabled modules host, by id. */
  slots: UiSlot[];
  /** Routed pages of enabled modules, by id. */
  pages: UiPage[];
  /**
   * Pages of disabled modules, by id: not routed, so the shell answers their path by saying
   * the module is off. A page whose path an enabled page or a root path serves, or whose path
   * is not a usable page path (a finding), is left out. An older server does not send it.
   */
  disabledPages?: UiDisabledPage[];
  /**
   * The groups of the `app/nav` entries, in sidebar order: the groups the ui config lists, in
   * its order, then any other group an entry names, by id. Only groups with an entry appear.
   */
  navGroups: UiNavGroup[];
  /** Nav entries of enabled modules, by group (in `navGroups` order), order, then id. */
  nav: UiNavItem[];
  /** Enabled extensions, by slot, order, then id. */
  extensions: UiExtension[];
  /** Registered provider instances, by id. */
  providers: UiProvider[];
  /**
   * The widget types of enabled modules (and the kernel's `core/…`), by type: what a config
   * page's widget may name. An older server does not send it.
   */
  widgetTypes?: UiWidgetType[];
  /**
   * The ui config's status maps (`ui.statusMaps`), by name: what a widget's `statusMap` option
   * names, read with `statusTone`. Absent when the config declares none.
   */
  statusMaps?: Record<string, StatusMapData>;
  /** Problems found while resolving; none of them stops the UI from rendering. */
  findings: UiFinding[];
}

export interface UiBrand {
  /** The product name the shell shows (sidebar header, document title). */
  title: string;
  /** An icon name for the sidebar mark, in place of the title's initial (`ui.brand.icon`). */
  icon?: string;
  /** An http(s) URL or root-relative path of a logo image for the sidebar mark (`ui.brand.logoUrl`). */
  logoUrl?: string;
}

/** The home page: the page `/` renders, which also stays routed at its own path. */
export interface UiHome {
  page: ExtensionId;
  /** The page's own path. */
  path: string;
}

export interface UiNavGroup {
  id: string;
  /** The group heading. */
  label: string;
  icon?: string;
}

export interface UiModule {
  id: string;
  version: string;
  enabled: boolean;
  /** Why the module is not enabled; absent when enabled. */
  reason?: string;
  /** `module`: a module on the module contract; `kernel`: a feature still wired into the kernel. */
  origin: "module" | "kernel";
  /**
   * The settings that would switch the module on, when their being unset is why the module is
   * off: its own unmet switches, and those of a dependency that is off only because of its
   * own. Each is an env var's name or a config key; names only, never values. Absent when no
   * setting would enable the module; never empty.
   */
  enabledBy?: UiModuleSwitch[];
}

/** An env var (`DECK_ACTIONS_ENABLED`) or a config key (`modules.<id>`) that enables a module. */
export type UiModuleSwitch = { env: string } | { config: string };

/** A page of a disabled module, as declared. */
export interface UiDisabledPage {
  id: ExtensionId;
  module: string;
  path: string;
  title: string;
  icon?: string;
}

export interface UiSlot {
  id: string;
  accepts: SlotDecl["accepts"];
  /** The module hosting the slot (`core` for the shell's own slots). */
  module: string;
}

export interface UiPage {
  id: ExtensionId;
  module: string;
  path: string;
  title: string;
  icon?: string;
  /** Export name in the module's web component table (`ConfigPage` for a config page). */
  component: string;
  /** A config page's sections and widgets (`ui.pages`); only pages of module `ui` have one. */
  layout?: UiPageLayout;
}

/** A config page's body: its sections, in reading order. */
export interface UiPageLayout {
  sections: UiLayoutSection[];
}

/** One section of a config page: a heading over a grid of widgets, one column below `md`. */
export interface UiLayoutSection {
  title: string;
  /** Grid columns from the `md` breakpoint up. */
  columns: 1 | 2 | 3 | 4;
  /** Its widgets, in reading order (DOM order). */
  widgets: UiWidgetInstance[];
}

/** A widget placed on a config page: a widget descriptor with its source resolved. */
export interface UiWidgetInstance {
  /**
   * `widget:ui/<page>.<id>` from the widget's `id`, else positional (`widget:ui/<page>.s<N>w<M>`,
   * 1-based), which changes when sections or widgets move.
   */
  id: ExtensionId;
  /** The widget type, `<module>/<name>`. */
  type: string;
  title?: string;
  /**
   * The provider it reads, resolved from its `source` (an id, or the first provider of a
   * kind); `null` when it names none, or one that is not registered (a finding).
   */
  source: UiProvider | null;
  /** Why its `source` resolved to no provider (it renders an error state); absent otherwise. */
  sourceProblem?: string;
  /**
   * Why it cannot render: no enabled module provides its type. It then reads no source and has
   * no projection, and renders as unavailable. Absent otherwise.
   */
  typeProblem?: string;
  /** Its JMESPath `select`, which the server evaluates over the provider's data at each poll. */
  select?: string;
  /**
   * The key of its `select` result in the provider envelope's `projections` (its id); absent
   * when it has no `select`, and it reads the envelope's `data` whole.
   */
  projection?: string;
  options: JsonObject;
  /** Columns spanned, at most the section's. */
  span: 1 | 2 | 3 | 4;
  rows: number;
}

/** A widget type a module provides. */
export interface UiWidgetType {
  type: string;
  module: string;
  /** Provider kinds it can render; absent means any. */
  sources?: string[];
}

/**
 * A nav entry: a module's, or one the ui config adds (`ui.nav.items`, listed with module
 * `ui`, `UI_CONFIG_MODULE`): a link to a page, an href, or a separator.
 */
export interface UiNavItem {
  id: ExtensionId;
  module: string;
  /** The nav slot the entry attaches to (`app/nav` unless an override re-attaches it). */
  slot: string;
  page?: ExtensionId;
  /** An in-app path, or an external `http(s)` URL the shell opens in a new tab. */
  href?: string;
  group: string;
  /** The entry's label, defaulting to its page's title; empty for a separator. */
  label: string;
  /** The entry's icon, defaulting to its page's icon. */
  icon?: string;
  order: number;
  /** A divider between the group's entries, with no page or href. */
  separator?: true;
}

export interface UiExtension {
  id: ExtensionId;
  kind: string;
  module: string;
  slot: string;
  order: number;
  component?: string;
  widget?: JsonObject;
  config?: JsonObject;
}

export interface UiProvider {
  id: string;
  kind: string;
}

export type UiFindingCode =
  | "UI_UNKNOWN_EXTENSION"
  | "UI_UNKNOWN_SLOT"
  | "UI_PAGE_PATH_COLLISION"
  | "UI_DUPLICATE_ID"
  | "UI_SLOT_KIND_MISMATCH"
  | "UI_INVALID_OVERRIDE"
  | "UI_INVALID_PAGE"
  | "UI_HOME_UNKNOWN"
  | "UI_HOME_DISABLED"
  | "UI_HOME_NOT_ROUTABLE"
  /** The config directory changed and no longer loads: the last good config is still served. */
  | "UI_CONFIG_INVALID"
  /** The config directory changed outside `ui`: that change takes effect when deck restarts. */
  | "UI_RESTART_REQUIRED"
  | "UI_WIDGET_SOURCE_UNKNOWN"
  | "UI_WIDGET_SOURCE_KIND"
  | "UI_WIDGET_SPAN"
  | "UI_OVERRIDE_POSITIONAL";

export interface UiFinding {
  code: UiFindingCode;
  /** `info` only for what works as configured but is fragile (UI_OVERRIDE_POSITIONAL). */
  severity: "warning" | "info";
  message: string;
  /** The extension, page, nav or nav group id the finding is about. */
  id?: string;
  slot?: string;
}

/**
 * A config override for one extension, page or nav entry, by id (the `ui.extensions` map of
 * the `ui` config section). Overrides replace: `false` disables
 * it, `true` enables it, and an object replaces its `attachTo` and/or `config` wholesale (no
 * deep merge). In a replacement `attachTo`, an omitted `slot` keeps the current slot, an
 * omitted `group` (a nav entry's) keeps the current group, and an omitted `order` is the
 * default (100). A page and a config page's widget take only `enabled`, a nav entry `enabled`
 * and `attachTo`. A malformed entry is ignored with a finding.
 */
export type UiOverride =
  | boolean
  | { enabled?: boolean; attachTo?: { slot?: string; order?: number; group?: string }; config?: JsonObject };

import type { JsonObject } from "./json.js";
import type { ExtensionId, SlotDecl } from "./manifest.js";

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
  /** Export name in the module's web component table. */
  component: string;
}

export interface UiNavItem {
  id: ExtensionId;
  module: string;
  /** The nav slot the entry attaches to (`app/nav` unless an override re-attaches it). */
  slot: string;
  page?: ExtensionId;
  href?: string;
  group: string;
  /** The entry's label, defaulting to its page's title. */
  label: string;
  /** The entry's icon, defaulting to its page's icon. */
  icon?: string;
  order: number;
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
  | "UI_HOME_NOT_ROUTABLE";

export interface UiFinding {
  code: UiFindingCode;
  severity: "warning";
  message: string;
  /** The extension, page, nav or nav group id the finding is about. */
  id?: string;
  slot?: string;
}

/**
 * A config override for one extension, page or nav entry, by id (the `ui.extensions` map of
 * the `ui` config section). Overrides replace: `false` disables
 * it, `true` enables it, and an object replaces its `attachTo` and/or `config` wholesale (no
 * deep merge). In a replacement `attachTo`, an omitted `slot` keeps the current slot and an
 * omitted `order` is the default (100). A page takes only `enabled`, a nav entry `enabled` and
 * `attachTo`. A malformed entry is ignored with a finding.
 */
export type UiOverride =
  | boolean
  | { enabled?: boolean; attachTo?: { slot?: string; order?: number }; config?: JsonObject };

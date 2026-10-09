import type {
  ExtensionDecl,
  ExtensionId,
  ModuleManifest,
  NavDecl,
  PageDecl,
  StatusMapData,
  StatusRule,
  Tone,
  UiExtension,
  UiFinding,
  UiManifest,
  UiBrand,
  UiDisabledPage,
  UiHome,
  UiModule,
  UiModuleSwitch,
  UiNavGroup,
  UiNavItem,
  UiOverride,
  UiPage,
  UiProvider,
  UiSlot,
  UiWidgetType,
} from "@deck/module-sdk";

import {
  DEFAULT_HOME_PAGE,
  entitySectionProblem,
  homePathProblem,
  isExternalHref,
  isTone,
  NAV_GROUP_ID_PATTERN,
  pagePathProblem,
  UI_CONFIG_MODULE,
  UI_CONFIG_NAV_ID_PATTERN,
} from "@deck/module-sdk";

import { buildLayout, CONFIG_PAGE_COMPONENT, configPageIds, configWidgetIds, type ConfigPage } from "./config-pages.js";
import { DEFAULT_BRAND_TITLE, DEFAULT_UI, type UiDefaults, type UiNavGroupConfig, type UiNavItemConfig } from "./defaults.js";
import type { KernelFeature } from "./kernel-features.js";
import { isRecord, RESERVED_MODULE_IDS } from "./validate.js";

/** Order given to a contribution that declares none. */
export const DEFAULT_ORDER = 100;

/** The slot nav entries attach to unless an override re-attaches them. */
export const NAV_SLOT = "app/nav";

/** The path that renders the home page. */
const HOME_PATH = "/";

/** The module hosting the shell's own slots; its contributions are always the incumbent. */
const CORE_MODULE = "core";

export interface UiModuleInput {
  manifest: ModuleManifest;
  enabled: boolean;
  /** Why the module is not running; absent when enabled. */
  reason?: string;
  /** A module that ships with deck: it keeps contested ids, slots and paths over other modules. */
  builtin?: boolean;
  /** The unset settings that keep the module off, when they are why (names, never values). */
  enabledBy?: readonly UiModuleSwitch[];
}

export interface ResolveUiInput {
  /** Every module the host knows, with its plan state. */
  modules: readonly UiModuleInput[];
  /** Features still wired into the kernel; a module with the same id replaces one. */
  kernelFeatures?: readonly KernelFeature[];
  /** Kernel capabilities by name (e.g. `actions`); absent means off. */
  capabilities?: Readonly<Record<string, boolean>>;
  /** Registered provider instances. */
  providers?: readonly UiProvider[];
  /** Config overrides by extension, page or nav id (`ui.extensions`); unchecked input. */
  overrides?: Readonly<Record<string, unknown>>;
  /** The estate's name (`estate.name`), the default brand title. */
  estateName?: string;
  /** The ui config the shell starts from; the built-in default when absent. */
  ui?: UiDefaults;
  /** Config-defined pages (`ui.pages`), listed as pages of module `ui` with their layout. */
  configPages?: readonly ConfigPage[];
}

interface Unit {
  manifest: ModuleManifest;
  origin: UiModule["origin"];
  enabled: boolean;
  reason?: string;
  builtin?: boolean;
  enabledBy?: readonly UiModuleSwitch[];
}

type Owned<T> = T & { module: string };
type Override = Exclude<UiOverride, boolean>;
/** A nav entry as declared: a module's, or the ui config's (which may be a separator). */
type NavEntryDecl = NavDecl & { separator?: true };

/**
 * Resolve the UI manifest: module contributions with config overrides applied. Pure and
 * deterministic: the same input always yields the same document.
 *
 * 1. Start from the contributions of every module and kernel feature, with their defaults.
 *    Where two claim the same id, slot or page path, the incumbent keeps it: `core` first,
 *    then the kernel-wired features and built-in modules, then other modules, each by id.
 *    The newcomer gets a finding.
 *    The ui config's own nav entries (`ui.nav.items`) follow, listed under module `ui`.
 * 2. Apply overrides by id. They replace: `false` disables, an object replaces the
 *    `attachTo` (an omitted slot or nav group keeps it, an omitted order is the default) and
 *    the `config` wholesale. Disabling a page also drops the nav entries to it. A malformed
 *    override is ignored with a finding.
 * 3. Drop contributions of disabled modules, and anything attached to a slot whose host is
 *    disabled.
 * 4. Validate, as findings that never fail: an override for an unknown id, an attachment to
 *    an unknown slot or to a slot that does not accept the contribution's kind, two pages on
 *    one path or a page on a module's root path, an id or slot contributed twice, a nav entry
 *    to an undeclared page.
 *    Their pages are listed as disabled pages, unless an enabled page or a root path serves
 *    the path or the path is not a usable page path (a finding), so the shell can say the module is off rather than that nothing is there.
 * 5. Sort pages by id, nav by group/order/id, extensions by slot/order/id. Nav groups follow
 *    the ui config's group order, then the built-in groups it does not list, then any other
 *    group by id.
 *
 * Config pages (`ui.pages`) are pages of module `ui` (`page:ui/<id>`, with a `nav:ui/<id>`
 * entry when they set `nav`), after every module's in precedence. Each routed one carries its
 * layout; each of its widgets is addressable by id (`widget:ui/<page>.<name>`), and an override
 * can switch it off. Widget types are those of enabled modules and the kernel, by type.
 */
export function resolveUiManifest(input: ResolveUiInput): UiManifest {
  const findings: UiFinding[] = [];
  const units = collectUnits(input);
  const byPrecedence = [...units].sort(comparePrecedence);
  const enabledUnits = byPrecedence.filter((unit) => unit.enabled);
  const ui = input.ui ?? DEFAULT_UI;
  const configNav = (ui.nav.items ?? []).map(configNavDecl);

  // Everything any module declares, enabled or not: an override naming one is never unknown,
  // and an attachment to a declared slot whose host is off is dropped without a finding.
  const knownIds = new Set<string>();
  const declaredPages = new Set<string>();
  const declaredNav = new Set<string>();
  const knownSlots = new Set<string>();
  const entitySections = new Set<string>();
  for (const { manifest } of units) {
    const contributes = manifest.contributes ?? {};
    for (const page of contributes.pages ?? []) declaredPages.add(page.id);
    for (const nav of contributes.nav ?? []) declaredNav.add(nav.id);
    for (const extension of contributes.extensions ?? []) if (extension.kind === "entity-section") entitySections.add(extension.id);
    for (const decl of [...(contributes.pages ?? []), ...(contributes.nav ?? []), ...(contributes.extensions ?? [])]) {
      knownIds.add(decl.id);
    }
    for (const slot of contributes.slots ?? []) knownSlots.add(slot.id);
  }
  // The ui config's nav entries take overrides like a module's.
  for (const item of configNav) {
    declaredNav.add(item.id);
    knownIds.add(item.id);
  }
  const configPages = input.configPages ?? [];
  const configPageIdSet = new Set<string>();
  // Widget id → whether it is positional (changes when widgets move).
  const widgetIds = new Map<string, boolean>();
  for (const page of configPages) {
    const ids = configPageIds(page);
    knownIds.add(ids.page);
    declaredPages.add(ids.page);
    configPageIdSet.add(ids.page);
    if (page.nav !== undefined) {
      knownIds.add(ids.nav);
      declaredNav.add(ids.nav);
    }
    for (const widget of configWidgetIds(page)) {
      knownIds.add(widget.id);
      widgetIds.set(widget.id, widget.positional);
    }
  }

  const seen = new Map<string, string>();
  const claim = (id: string, module: string): boolean => {
    const owner = seen.get(id);
    if (owner !== undefined) {
      findings.push({ code: "UI_DUPLICATE_ID", severity: "warning", message: `"${id}" is already contributed by module "${owner}"; module "${module}"'s copy is ignored`, id });
      return false;
    }
    seen.set(id, module);
    return true;
  };

  const slots = new Map<string, UiSlot>();
  const pageDecls: Owned<PageDecl>[] = [];
  const navDecls: Owned<NavEntryDecl>[] = [];
  const extensionDecls: Owned<ExtensionDecl>[] = [];
  for (const { manifest } of enabledUnits) {
    const module = manifest.id;
    const contributes = manifest.contributes ?? {};
    for (const slot of contributes.slots ?? []) {
      const owner = slots.get(slot.id);
      if (owner !== undefined) {
        findings.push({ code: "UI_DUPLICATE_ID", severity: "warning", message: `slot "${slot.id}" is already hosted by module "${owner.module}"; module "${module}"'s declaration is ignored`, slot: slot.id });
        continue;
      }
      slots.set(slot.id, { id: slot.id, accepts: slot.accepts, module });
    }
    for (const page of contributes.pages ?? []) if (claim(page.id, module)) pageDecls.push({ ...page, module });
    for (const nav of contributes.nav ?? []) if (claim(nav.id, module)) navDecls.push({ ...nav, module });
    for (const extension of contributes.extensions ?? []) if (claim(extension.id, module)) extensionDecls.push({ ...extension, module });
  }
  // The config's entries are `nav:ui/…`, a namespace no module may use (`ui` is reserved).
  for (const item of configNav) if (claim(item.id, UI_CONFIG_MODULE)) navDecls.push({ ...item, module: UI_CONFIG_MODULE });

  // Config pages come after every module's contributions, so a module keeps a contested id or path.
  const configPageById = new Map<string, ConfigPage>();
  for (const page of configPages) {
    const ids = configPageIds(page);
    const problem = pagePathProblem(page.path, `page "${ids.page}"`);
    if (problem !== null) {
      findings.push({ code: "UI_INVALID_PAGE", severity: "warning", message: `${problem}; it is not routed`, id: ids.page });
      continue;
    }
    if (!claim(ids.page, UI_CONFIG_MODULE)) continue;
    configPageById.set(ids.page, page);
    pageDecls.push({
      id: ids.page,
      module: UI_CONFIG_MODULE,
      path: page.path,
      title: page.title,
      ...(page.icon === undefined ? {} : { icon: page.icon }),
      component: CONFIG_PAGE_COMPONENT,
    });
    if (page.nav !== undefined && claim(ids.nav, UI_CONFIG_MODULE)) {
      navDecls.push({
        id: ids.nav,
        module: UI_CONFIG_MODULE,
        page: ids.page,
        group: page.nav.group,
        ...(page.nav.label === undefined ? {} : { label: page.nav.label }),
        ...(page.nav.order === undefined ? {} : { order: page.nav.order }),
      });
    }
  }

  // Widget types: the first by precedence keeps a type two modules declare.
  const widgetTypes = new Map<string, UiWidgetType>();
  for (const { manifest } of enabledUnits) {
    for (const decl of manifest.contributes?.widgetTypes ?? []) {
      const owner = widgetTypes.get(decl.type);
      if (owner !== undefined) {
        findings.push({ code: "UI_DUPLICATE_ID", severity: "warning", message: `widget type "${decl.type}" is already provided by module "${owner.module}"; module "${manifest.id}"'s is ignored`, id: decl.type });
        continue;
      }
      widgetTypes.set(decl.type, { type: decl.type, module: manifest.id, ...(decl.sources === undefined ? {} : { sources: [...decl.sources] }) });
    }
  }

  const overrides = new Map<string, UiOverride>();
  for (const [id, value] of Object.entries(input.overrides ?? {}).sort(([a], [b]) => compareIds(a, b))) {
    if (!knownIds.has(id)) {
      findings.push({ code: "UI_UNKNOWN_EXTENSION", severity: "warning", message: `override "${id}" names no known extension, page or nav entry`, id });
      continue;
    }
    const target: OverrideTarget = declaredPages.has(id) ? "page" : declaredNav.has(id) ? "nav" : widgetIds.has(id) ? "widget" : "extension";
    const problem = overrideProblem(value, target);
    if (problem !== null) {
      findings.push({ code: "UI_INVALID_OVERRIDE", severity: "warning", message: `override "${id}" is ignored: ${problem}`, id });
      continue;
    }
    if (widgetIds.get(id) === true) {
      findings.push({
        code: "UI_OVERRIDE_POSITIONAL",
        severity: "info",
        message: `override "${id}" targets a widget by position, which changes when its page's sections or widgets move; give the widget an id`,
        id,
      });
    }
    // A replacement config must still be a usable entity section (it replaces, never merges).
    // Only the config is dropped: the rest of the override (`enabled: false` above all) holds.
    const sectionProblem =
      entitySections.has(id) && isRecord(value) && value.config !== undefined ? entitySectionProblem(value.config, "an entity section's") : null;
    if (sectionProblem !== null) {
      findings.push({ code: "UI_INVALID_OVERRIDE", severity: "warning", message: `override "${id}" config is ignored: ${sectionProblem}`, id });
      const { config: _dropped, ...rest } = value as Record<string, unknown>;
      overrides.set(id, rest as UiOverride);
      continue;
    }
    overrides.set(id, value as UiOverride);
  }

  /**
   * Where a contribution attaches after its override, or null when it cannot render there:
   * an unknown slot (finding), a slot whose host is off (silent), or a slot that does not
   * accept its kind (finding).
   */
  const attach = (
    id: string,
    kind: string,
    fallback: { slot: string; order: number },
    override: UiOverride | undefined,
  ): { slot: string; order: number } | null => {
    const replaced = replacement(override)?.attachTo;
    const attachTo = replaced === undefined ? fallback : { slot: replaced.slot ?? fallback.slot, order: replaced.order ?? DEFAULT_ORDER };
    const slot = slots.get(attachTo.slot);
    if (slot === undefined) {
      if (!knownSlots.has(attachTo.slot)) {
        findings.push({ code: "UI_UNKNOWN_SLOT", severity: "warning", message: `"${id}" attaches to unknown slot "${attachTo.slot}"`, id, slot: attachTo.slot });
      }
      return null;
    }
    if (slot.accepts !== kind) {
      findings.push({
        code: "UI_SLOT_KIND_MISMATCH",
        severity: "warning",
        message: `"${id}" (${kind}) attaches to slot "${slot.id}", which accepts ${slot.accepts}`,
        id,
        slot: slot.id,
      });
      return null;
    }
    return attachTo;
  };

  // Pages: overrides, then one page per path; the incumbent (by precedence) keeps it. A
  // module's declared root path always owns the path, even while that module is off: the
  // server answers it (or 404s), so a page there could never be deep-linked. (The host
  // refuses a module whose root path would cover a built-in or kernel page.)
  const pages: UiPage[] = [];
  const pathOwner = new Map<string, string>();
  const rootPathOwner = new Map<string, Unit>();
  for (const unit of byPrecedence) {
    for (const path of unit.manifest.contributes?.routes?.rootPaths ?? []) {
      if (!rootPathOwner.has(path)) rootPathOwner.set(path, unit);
    }
  }
  for (const decl of pageDecls) {
    if (!isEnabled(overrides.get(decl.id), true)) continue;
    // `/` is the home route: it renders the home page, which every page can be from its own path.
    if (decl.path === HOME_PATH) {
      findings.push({ code: "UI_PAGE_PATH_COLLISION", severity: "warning", message: `page "${decl.id}" uses path "/", which renders the home page (\`ui.home\`); it is not routed`, id: decl.id });
      continue;
    }
    const rootOwner = rootPathOwner.get(decl.path);
    if (rootOwner !== undefined) {
      findings.push({ code: "UI_PAGE_PATH_COLLISION", severity: "warning", message: `page "${decl.id}" uses path "${decl.path}", a root path module "${rootOwner.manifest.id}" serves; it is not routed`, id: decl.id });
      continue;
    }
    const owner = pathOwner.get(decl.path);
    if (owner !== undefined) {
      findings.push({ code: "UI_PAGE_PATH_COLLISION", severity: "warning", message: `page "${decl.id}" uses path "${decl.path}", already served by "${owner}"; it is not routed`, id: decl.id });
      continue;
    }
    pathOwner.set(decl.path, decl.id);
    const configPage = decl.module === UI_CONFIG_MODULE ? configPageById.get(decl.id) : undefined;
    pages.push({
      id: decl.id,
      module: decl.module,
      path: decl.path,
      title: decl.title,
      ...(decl.icon === undefined ? {} : { icon: decl.icon }),
      component: decl.component,
      ...(configPage === undefined
        ? {}
        : {
            layout: buildLayout(configPage, {
              providers: input.providers ?? [],
              widgetTypes: [...widgetTypes.values()],
              enabled: (id) => isEnabled(overrides.get(id), true),
              findings,
            }),
          }),
    });
  }
  const routedPages = new Set<string>(pages.map((page) => page.id));
  const home = resolveHome(
    ui.home,
    pages,
    (id) => (configPageIdSet.has(id) ? configUnroutedReason(id, overrides) : unroutedReason(id, units, overrides)),
    findings,
  );

  // Pages of disabled modules, on paths nothing routed or root-served claims. The first by
  // precedence keeps a path two disabled modules declare.
  const disabledPages: UiDisabledPage[] = [];
  const disabledIds = new Set<string>();
  for (const unit of byPrecedence) {
    if (unit.enabled) continue;
    for (const page of unit.manifest.contributes?.pages ?? []) {
      if (page.path === HOME_PATH || pathOwner.has(page.path) || rootPathOwner.has(page.path) || seen.has(page.id) || disabledIds.has(page.id)) continue;
      // The web routes this path to its not-enabled page: it must be one the router compiles.
      const problem = pagePathProblem(page.path, `page "${page.id}"`, []);
      if (problem !== null) {
        findings.push({ code: "UI_INVALID_PAGE", severity: "warning", message: `${problem}; it is not listed as a disabled page`, id: page.id });
        continue;
      }
      pathOwner.set(page.path, page.id);
      disabledIds.add(page.id);
      disabledPages.push({
        id: page.id,
        module: unit.manifest.id,
        path: page.path,
        title: page.title,
        ...(page.icon === undefined ? {} : { icon: page.icon }),
      });
    }
  }

  // Nav: attached to `app/nav` by default and resolved like any attachment. An entry to a
  // page that is not routed is dropped; one to a page no module declares is a finding.
  const nav: UiNavItem[] = [];
  for (const decl of navDecls) {
    const override = overrides.get(decl.id);
    if (!isEnabled(override, true)) continue;
    if (decl.page !== undefined && !routedPages.has(decl.page)) {
      if (!declaredPages.has(decl.page)) {
        findings.push({ code: "UI_UNKNOWN_EXTENSION", severity: "warning", message: `nav entry "${decl.id}" targets undeclared page "${decl.page}"`, id: decl.id });
      }
      continue;
    }
    const attachTo = attach(decl.id, "nav", { slot: NAV_SLOT, order: decl.order ?? DEFAULT_ORDER }, override);
    if (attachTo === null) continue;
    // An entry without its own label or icon shows its page's; a separator has neither.
    const page = decl.page === undefined ? undefined : pages.find((candidate) => candidate.id === decl.page);
    const icon = decl.icon ?? page?.icon;
    nav.push({
      id: decl.id,
      module: decl.module,
      slot: attachTo.slot,
      ...(decl.page === undefined ? {} : { page: decl.page }),
      ...(decl.href === undefined ? {} : { href: decl.href }),
      // A re-attachment moves the entry to its group, or keeps the entry's own.
      group: replacement(override)?.attachTo?.group ?? decl.group,
      label: decl.separator === true ? "" : (decl.label ?? page?.title ?? decl.href ?? decl.id),
      ...(icon === undefined ? {} : { icon }),
      order: attachTo.order,
      ...(decl.separator === true ? { separator: true as const } : {}),
    });
  }
  const navGroups = resolveNavGroups(nav, ui, findings);
  const groupRank = new Map(navGroups.map((group, index) => [group.id, index]));
  // A group only entries outside `app/nav` use is not listed; it sorts after the listed ones.
  const rankOf = (group: string): number => groupRank.get(group) ?? navGroups.length;

  // Extensions: overrides replace attachTo/config, then the same slot checks.
  const extensions: UiExtension[] = [];
  for (const decl of extensionDecls) {
    const override = overrides.get(decl.id);
    if (!isEnabled(override, decl.enabled ?? true)) continue;
    const attachTo = attach(decl.id, decl.kind, { slot: decl.attachTo.slot, order: decl.attachTo.order ?? DEFAULT_ORDER }, override);
    if (attachTo === null) continue;
    const config = replacement(override)?.config ?? decl.config;
    extensions.push({
      id: decl.id,
      kind: decl.kind,
      module: decl.module,
      slot: attachTo.slot,
      order: attachTo.order,
      ...(decl.component === undefined ? {} : { component: decl.component }),
      ...(decl.widget === undefined ? {} : { widget: decl.widget }),
      ...(config === undefined ? {} : { config }),
    });
  }

  return {
    uiApi: 1,
    brand: resolveBrand(input.estateName, ui.brand),
    home: home ?? null,
    modules: units.map(({ manifest, origin, enabled, reason, enabledBy }) => ({
      id: manifest.id,
      version: manifest.version,
      enabled,
      ...(reason === undefined ? {} : { reason }),
      origin,
      ...(enabled || enabledBy === undefined || enabledBy.length === 0 ? {} : { enabledBy: enabledBy.map(copySwitch) }),
    })),
    slots: [...slots.values()].sort((a, b) => compareIds(a.id, b.id)),
    pages: pages.sort((a, b) => compareIds(a.id, b.id)),
    disabledPages: disabledPages.sort((a, b) => compareIds(a.id, b.id)),
    navGroups,
    nav: nav.sort((a, b) => rankOf(a.group) - rankOf(b.group) || compareIds(a.group, b.group) || a.order - b.order || compareIds(a.id, b.id)),
    extensions: extensions.sort((a, b) => compareIds(a.slot, b.slot) || a.order - b.order || compareIds(a.id, b.id)),
    providers: [...(input.providers ?? [])]
      .map(({ id, kind }) => ({ id, kind }))
      .sort((a, b) => compareIds(a.id, b.id)),
    widgetTypes: [...widgetTypes.values()].sort((a, b) => compareIds(a.type, b.type)),
    ...(ui.statusMaps === undefined || Object.keys(ui.statusMaps).length === 0 ? {} : { statusMaps: copyStatusMaps(ui.statusMaps) }),
    findings,
  };
}

/** The status maps, copied (the manifest is served as is), by name. */
function copyStatusMaps(maps: Readonly<Record<string, StatusMapData>>): Record<string, StatusMapData> {
  return Object.fromEntries(
    Object.keys(maps)
      .sort(compareIds)
      .map((name) => {
        const { values, rules } = maps[name]!;
        return [name, { ...(values === undefined ? {} : { values: { ...values } }), ...(rules === undefined ? {} : { rules: rules.map((rule) => ({ ...rule })) }) }];
      }),
  );
}

/**
 * The brand: the configured title, else the estate's name, else deck's; the configured icon
 * and logo as given (config validation has checked their form).
 */
function resolveBrand(estateName: string | undefined, brand: UiDefaults["brand"]): UiBrand {
  const title = [brand?.title, estateName].map((candidate) => candidate?.trim() ?? "").find((candidate) => candidate !== "");
  return {
    title: title ?? DEFAULT_BRAND_TITLE,
    ...(brand?.icon === undefined ? {} : { icon: brand.icon }),
    ...(brand?.logoUrl === undefined ? {} : { logoUrl: brand.logoUrl }),
  };
}

/**
 * The page `/` renders: the configured one when it is a routed page with no path parameters,
 * else the default (`DEFAULT_HOME_PAGE`) on the same terms, else none. A configured page
 * that cannot be home is a finding, and the default stands in.
 */
function resolveHome(
  configured: string | undefined,
  pages: readonly UiPage[],
  unrouted: (id: string) => string | null,
  findings: UiFinding[],
): UiHome | undefined {
  const usable = (id: string): UiPage | undefined => {
    const page = pages.find((candidate) => candidate.id === id);
    return page !== undefined && homePathProblem(page.path) === null ? page : undefined;
  };
  const fallbackPage = usable(DEFAULT_HOME_PAGE);
  const fallbackHome = fallbackPage === undefined ? undefined : { page: fallbackPage.id, path: fallbackPage.path };
  if (configured !== undefined) {
    const page = pages.find((candidate) => candidate.id === configured);
    const problem = page === undefined ? null : homePathProblem(page.path);
    if (page !== undefined && problem === null) return { page: page.id, path: page.path };
    const fallback = fallbackHome === undefined ? `; nothing renders at "/"` : `; "/" renders "${fallbackHome.page}" instead`;
    if (page !== undefined) {
      findings.push({ code: "UI_HOME_NOT_ROUTABLE", severity: "warning", message: `home page "${configured}" cannot render at "/": ${problem}${fallback}`, id: configured });
    } else if (unrouted(configured) !== null) {
      findings.push({ code: "UI_HOME_DISABLED", severity: "warning", message: `home page "${configured}" is not routed: ${unrouted(configured)}${fallback}`, id: configured });
    } else {
      findings.push({ code: "UI_HOME_UNKNOWN", severity: "warning", message: `home page "${configured}" names no known page${fallback}`, id: configured });
    }
  }
  return fallbackHome;
}

/**
 * The groups of the `app/nav` entries, in sidebar order: the configured groups (`ui.nav.groups`)
 * in config order, then the built-in groups the config does not list in their default order,
 * then the other groups entries name, by id. A group's heading and icon are the configured
 * ones, else the built-in group's, else its id and none. Only a group with a link (not just a
 * separator) is listed. A group configured twice keeps its first entry; the repeat is a finding.
 */
function resolveNavGroups(nav: readonly UiNavItem[], ui: UiDefaults, findings: UiFinding[]): UiNavGroup[] {
  const used = new Set(nav.filter((item) => item.slot === NAV_SLOT && item.separator !== true).map((item) => item.group));
  const builtin = new Map(ui.nav.groups.map((group) => [group.id, group]));
  const ordered: UiNavGroupConfig[] = [];
  const listed = new Set<string>();
  for (const group of ui.nav.configured ?? []) {
    if (listed.has(group.id)) {
      findings.push({ code: "UI_DUPLICATE_ID", severity: "warning", message: `nav group "${group.id}" is configured more than once; its first entry is used`, id: group.id });
      continue;
    }
    listed.add(group.id);
    ordered.push(group);
  }
  for (const group of ui.nav.groups) {
    if (listed.has(group.id)) continue;
    listed.add(group.id);
    ordered.push(group);
  }
  ordered.push(...[...used].filter((id) => !listed.has(id)).sort(compareIds).map((id) => ({ id })));
  return ordered
    .filter(({ id }) => used.has(id))
    .map(({ id, label, icon }) => {
      const fallback = builtin.get(id);
      const heading = icon ?? fallback?.icon;
      return { id, label: label ?? fallback?.label ?? id, ...(heading === undefined ? {} : { icon: heading }) };
    });
}

/** A `ui.nav.items` entry as a nav declaration: a link, or a separator. */
function configNavDecl(item: UiNavItemConfig): NavEntryDecl {
  const order = item.order === undefined ? {} : { order: item.order };
  if ("separator" in item) return { id: item.id as ExtensionId, group: item.group, separator: true, ...order };
  return {
    id: item.id as ExtensionId,
    group: item.group,
    label: item.label,
    href: item.href,
    ...(item.icon === undefined ? {} : { icon: item.icon }),
    ...order,
  };
}

/**
 * Why a declared page is not among the routed pages, or null for a page no module declares:
 * its module is off, an override switches it off, or another page or a root path has its path.
 */
function unroutedReason(id: string, units: readonly Unit[], overrides: ReadonlyMap<string, UiOverride>): string | null {
  const unit = units.find(({ manifest }) => manifest.contributes?.pages?.some((page) => page.id === id));
  if (unit === undefined) return null;
  if (!unit.enabled) return `its module "${unit.manifest.id}" is off`;
  if (!isEnabled(overrides.get(id), true)) return "a ui.extensions override switches it off";
  if (unit.manifest.contributes?.pages?.find((page) => page.id === id)?.path === HOME_PATH) return 'it declares "/", which renders the home page';
  return "another contribution has its id, or another page or a module's root path has its path";
}

/** Why a config page is not routed. */
function configUnroutedReason(id: string, overrides: ReadonlyMap<string, UiOverride>): string {
  if (!isEnabled(overrides.get(id), true)) return "a ui.extensions override switches it off";
  return "another contribution has its id, or another page or a module's root path has its path, or its path is unusable";
}

/** Modules, then the kernel features no module replaces, by id (a reserved id is listed twice, by origin). */
function collectUnits(input: ResolveUiInput): Unit[] {
  const units: Unit[] = input.modules.map(({ manifest, enabled, reason, builtin, enabledBy }) => ({
    manifest,
    origin: "module",
    enabled,
    ...(reason === undefined ? {} : { reason }),
    ...(builtin === true ? { builtin } : {}),
    ...(enabledBy === undefined ? {} : { enabledBy }),
  }));
  const moduleIds = new Set(units.map((unit) => unit.manifest.id));
  for (const { manifest, requires } of input.kernelFeatures ?? []) {
    // A module replaces the kernel feature of its id, except a reserved one (`core`): the
    // host refuses such a module, and the kernel's copy stays the incumbent regardless.
    if (moduleIds.has(manifest.id) && !RESERVED_MODULE_IDS.has(manifest.id)) continue;
    const enabled = requires === undefined || input.capabilities?.[requires] === true;
    units.push({
      manifest,
      origin: "kernel",
      enabled,
      ...(enabled ? {} : { reason: `capability "${requires}" is off` }),
    });
  }
  return units.sort((a, b) => compareIds(a.manifest.id, b.manifest.id));
}

/**
 * Who keeps a contested id, slot or path: `core`, then kernel-wired features and built-in
 * modules, then other modules, each by id.
 */
function comparePrecedence(a: Unit, b: Unit): number {
  return rank(a) - rank(b) || compareIds(a.manifest.id, b.manifest.id);
}

function rank(unit: Unit): number {
  if (unit.manifest.id === CORE_MODULE && unit.origin === "kernel") return 0;
  return unit.origin === "kernel" || unit.builtin === true ? 1 : 2;
}

type OverrideTarget = "page" | "nav" | "widget" | "extension";

/**
 * The override keys each target takes: a page or a config page's widget can only be switched,
 * a nav entry also re-attached.
 */
const OVERRIDE_KEYS: Readonly<Record<OverrideTarget, readonly string[]>> = {
  page: ["enabled"],
  nav: ["enabled", "attachTo"],
  widget: ["enabled"],
  extension: ["enabled", "attachTo", "config"],
};

const TARGET_NAMES: Readonly<Record<OverrideTarget, string>> = { page: "a page", nav: "a nav entry", widget: "a widget", extension: "an extension" };

/** Why an override value is malformed for its target, or null. */
function overrideProblem(value: unknown, target: OverrideTarget): string | null {
  if (typeof value === "boolean") return null;
  if (!isRecord(value)) return "it must be true, false or an object";
  const allowed = OVERRIDE_KEYS[target];
  const misplaced = Object.keys(value).filter((key) => !allowed.includes(key) && OVERRIDE_KEYS.extension.includes(key));
  if (misplaced.length > 0) return `${misplaced.map((key) => `"${key}"`).join(", ")} does not apply to ${TARGET_NAMES[target]}`;
  const unknown = Object.keys(value).filter((key) => !OVERRIDE_KEYS.extension.includes(key));
  if (unknown.length > 0) return `unknown key ${unknown.map((key) => `"${key}"`).join(", ")}`;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return "enabled must be a boolean";
  if (value.config !== undefined && !isRecord(value.config)) return "config must be an object";
  const attachTo = value.attachTo;
  if (attachTo !== undefined) {
    if (!isRecord(attachTo)) return "attachTo must be an object";
    const extra = Object.keys(attachTo).filter((key) => key !== "slot" && key !== "order" && key !== "group");
    if (extra.length > 0) return `unknown attachTo key ${extra.map((key) => `"${key}"`).join(", ")}`;
    if (attachTo.group !== undefined) {
      if (target !== "nav") return `attachTo.group applies only to a nav entry`;
      if (typeof attachTo.group !== "string" || !NAV_GROUP_ID_PATTERN.test(attachTo.group)) {
        return "attachTo.group must be a nav group id (lower-case letters, digits and hyphens)";
      }
    }
    if (attachTo.slot !== undefined && (typeof attachTo.slot !== "string" || attachTo.slot.length === 0)) {
      return "attachTo.slot must be a non-empty string";
    }
    if (attachTo.order !== undefined && (typeof attachTo.order !== "number" || !Number.isFinite(attachTo.order))) {
      return "attachTo.order must be a finite number";
    }
  }
  return null;
}

function isEnabled(override: UiOverride | undefined, byDefault: boolean): boolean {
  if (typeof override === "boolean") return override;
  return override?.enabled ?? byDefault;
}

function replacement(override: UiOverride | undefined): Override | undefined {
  return typeof override === "object" ? override : undefined;
}

/** The switch's name alone: an input object carrying anything else never leaks it. */
function copySwitch(enabledBy: UiModuleSwitch): UiModuleSwitch {
  return "env" in enabledBy ? { env: enabledBy.env } : { config: enabledBy.config };
}

/** Code-unit order, independent of locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The estate's name in a config document, or none. */
export function estateNameOf(config: unknown): string | undefined {
  const name = (config as { estate?: { name?: unknown } } | null)?.estate?.name;
  return typeof name === "string" ? name : undefined;
}

/**
 * The `ui` config the resolver reads: the built-in defaults with the config's brand, home and
 * nav. The config has been validated, so fields of the wrong type cannot occur; they are
 * dropped anyway rather than trusted (an entry missing what it needs is dropped whole).
 */
export function uiConfigOf(config: unknown): UiDefaults {
  const ui = (config as { ui?: { brand?: unknown; home?: unknown; nav?: unknown; statusMaps?: unknown } } | null)?.ui;
  const brand = isRecord(ui?.brand) ? ui.brand : {};
  const picked = { title: text(brand.title), icon: text(brand.icon), logoUrl: text(brand.logoUrl) };
  const home = text(ui?.home);
  const nav = isRecord(ui?.nav) ? ui.nav : {};
  const groups = records(nav.groups).flatMap((group): UiNavGroupConfig[] => {
    const id = text(group.id);
    return id === undefined ? [] : [defined({ id, label: text(group.label), icon: text(group.icon) })];
  });
  const items = records(nav.items).flatMap((item): UiNavItemConfig[] => {
    const id = text(item.id);
    const group = text(item.group);
    // Always in the reserved `ui` namespace, so an entry never takes a module's id.
    if (id === undefined || !UI_CONFIG_NAV_ID_PATTERN.test(id) || group === undefined) return [];
    const order = typeof item.order === "number" && Number.isFinite(item.order) ? item.order : undefined;
    if (item.separator === true) return [defined({ id, group, separator: true as const, order })];
    const label = text(item.label);
    const href = text(item.href);
    // Only an external http(s) link: config entries do not route in-app.
    if (label === undefined || href === undefined || !isExternalHref(href)) return [];
    return [defined({ id, group, label, href, icon: text(item.icon), order })];
  });
  const statusMaps = statusMapsOf(ui?.statusMaps);
  return {
    ...DEFAULT_UI,
    brand: defined(picked),
    ...(statusMaps === undefined ? {} : { statusMaps }),
    ...(home === undefined ? {} : { home }),
    nav: {
      ...DEFAULT_UI.nav,
      ...(groups.length === 0 ? {} : { configured: groups }),
      ...(items.length === 0 ? {} : { items }),
    },
  };
}

const STATUS_MAP_NAME = /^[a-z0-9][a-z0-9-]*$/;
const RULE_BOUNDS = ["lt", "lte", "gt", "gte"] as const;

/**
 * `ui.statusMaps`, read leniently: a map whose name is malformed is dropped, and so are a
 * value whose tone is not one, and a rule with an unknown tone or a malformed condition (config
 * validation refuses all of these). `undefined` when no map remains.
 */
function statusMapsOf(value: unknown): Record<string, StatusMapData> | undefined {
  if (!isRecord(value)) return undefined;
  const maps: Record<string, StatusMapData> = {};
  for (const [name, map] of Object.entries(value)) {
    if (!STATUS_MAP_NAME.test(name) || !isRecord(map)) continue;
    const values = isRecord(map.values)
      ? Object.fromEntries(Object.entries(map.values).filter((entry): entry is [string, Tone] => isTone(entry[1])))
      : undefined;
    const rules = records(map.rules).flatMap((rule): StatusRule[] => {
      if (!isTone(rule.tone)) return [];
      const kept: StatusRule = { tone: rule.tone };
      for (const bound of RULE_BOUNDS) {
        const limit = rule[bound];
        if (limit === undefined) continue;
        if (typeof limit !== "number" || !Number.isFinite(limit)) return [];
        kept[bound] = limit;
      }
      if (rule.eq !== undefined) {
        if (!["string", "number", "boolean"].includes(typeof rule.eq)) return [];
        kept.eq = rule.eq as StatusRule["eq"];
      }
      return [kept];
    });
    // The name pattern keeps out `__proto__` and its kin, so this is always an own entry.
    maps[name] = { ...(values === undefined ? {} : { values }), ...(rules.length === 0 ? {} : { rules }) };
  }
  return Object.keys(maps).length === 0 ? undefined : maps;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** An object's fields that may be undefined become optional ones, left out when undefined. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** The object without its undefined fields. */
function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Defined<T>;
}

/** The `ui.extensions` override map of a config document, or none. Entries are checked on resolution. */
export function uiOverridesOf(config: unknown): Record<ExtensionId, unknown> {
  const ui = (config as { ui?: { extensions?: unknown } } | null)?.ui;
  const extensions = ui?.extensions;
  return isRecord(extensions) ? (extensions as Record<ExtensionId, unknown>) : {};
}

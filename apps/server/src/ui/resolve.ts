import type {
  ExtensionDecl,
  ExtensionId,
  ModuleManifest,
  NavDecl,
  PageDecl,
  UiExtension,
  UiFinding,
  UiManifest,
  UiBrand,
  UiModule,
  UiNavGroup,
  UiNavItem,
  UiOverride,
  UiPage,
  UiProvider,
  UiSlot,
} from "@deck/module-sdk";

import { entitySectionProblem } from "@deck/module-sdk";

import { DEFAULT_BRAND_TITLE, DEFAULT_UI, type UiDefaults } from "./defaults.js";
import type { KernelFeature } from "./kernel-features.js";
import { isRecord, RESERVED_MODULE_IDS } from "./validate.js";

/** Order given to a contribution that declares none. */
export const DEFAULT_ORDER = 100;

/** The slot nav entries attach to unless an override re-attaches them. */
export const NAV_SLOT = "app/nav";

/** The module hosting the shell's own slots; its contributions are always the incumbent. */
const CORE_MODULE = "core";

export interface UiModuleInput {
  manifest: ModuleManifest;
  enabled: boolean;
  /** Why the module is not running; absent when enabled. */
  reason?: string;
  /** A module that ships with deck: it keeps contested ids, slots and paths over other modules. */
  builtin?: boolean;
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
}

interface Unit {
  manifest: ModuleManifest;
  origin: UiModule["origin"];
  enabled: boolean;
  reason?: string;
  builtin?: boolean;
}

type Owned<T> = T & { module: string };
type Override = Exclude<UiOverride, boolean>;

/**
 * Resolve the UI manifest: module contributions with config overrides applied. Pure and
 * deterministic: the same input always yields the same document.
 *
 * 1. Start from the contributions of every module and kernel feature, with their defaults.
 *    Where two claim the same id, slot or page path, the incumbent keeps it: `core` first,
 *    then the kernel-wired features and built-in modules, then other modules, each by id.
 *    The newcomer gets a finding.
 * 2. Apply overrides by id. They replace: `false` disables, an object replaces the
 *    `attachTo` (an omitted slot keeps the slot, an omitted order is the default) and the
 *    `config` wholesale. Disabling a page also drops the nav entries to it. A malformed
 *    override is ignored with a finding.
 * 3. Drop contributions of disabled modules, and anything attached to a slot whose host is
 *    disabled.
 * 4. Validate, as findings that never fail: an override for an unknown id, an attachment to
 *    an unknown slot or to a slot that does not accept the contribution's kind, two pages on
 *    one path or a page on a module's root path, an id or slot contributed twice, a nav entry
 *    to an undeclared page.
 * 5. Sort pages by id, nav by group/order/id, extensions by slot/order/id. Nav groups follow
 *    the ui config's group order, then any other group by id.
 */
export function resolveUiManifest(input: ResolveUiInput): UiManifest {
  const findings: UiFinding[] = [];
  const units = collectUnits(input);
  const byPrecedence = [...units].sort(comparePrecedence);
  const enabledUnits = byPrecedence.filter((unit) => unit.enabled);

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
  const navDecls: Owned<NavDecl>[] = [];
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

  const overrides = new Map<string, UiOverride>();
  for (const [id, value] of Object.entries(input.overrides ?? {}).sort(([a], [b]) => compareIds(a, b))) {
    if (!knownIds.has(id)) {
      findings.push({ code: "UI_UNKNOWN_EXTENSION", severity: "warning", message: `override "${id}" names no known extension, page or nav entry`, id });
      continue;
    }
    const target: OverrideTarget = declaredPages.has(id) ? "page" : declaredNav.has(id) ? "nav" : "extension";
    const problem = overrideProblem(value, target);
    if (problem !== null) {
      findings.push({ code: "UI_INVALID_OVERRIDE", severity: "warning", message: `override "${id}" is ignored: ${problem}`, id });
      continue;
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
    pages.push({
      id: decl.id,
      module: decl.module,
      path: decl.path,
      title: decl.title,
      ...(decl.icon === undefined ? {} : { icon: decl.icon }),
      component: decl.component,
    });
  }
  const routedPages = new Set<string>(pages.map((page) => page.id));

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
    // An entry without its own label or icon shows its page's.
    const page = decl.page === undefined ? undefined : pages.find((candidate) => candidate.id === decl.page);
    const icon = decl.icon ?? page?.icon;
    nav.push({
      id: decl.id,
      module: decl.module,
      slot: attachTo.slot,
      ...(decl.page === undefined ? {} : { page: decl.page }),
      ...(decl.href === undefined ? {} : { href: decl.href }),
      group: decl.group,
      label: decl.label ?? page?.title ?? decl.href ?? decl.id,
      ...(icon === undefined ? {} : { icon }),
      order: attachTo.order,
    });
  }
  const navGroups = resolveNavGroups(nav, input.ui ?? DEFAULT_UI, findings);
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
    brand: resolveBrand(input.estateName),
    modules: units.map(({ manifest, origin, enabled, reason }) => ({
      id: manifest.id,
      version: manifest.version,
      enabled,
      ...(reason === undefined ? {} : { reason }),
      origin,
    })),
    slots: [...slots.values()].sort((a, b) => compareIds(a.id, b.id)),
    pages: pages.sort((a, b) => compareIds(a.id, b.id)),
    navGroups,
    nav: nav.sort((a, b) => rankOf(a.group) - rankOf(b.group) || compareIds(a.group, b.group) || a.order - b.order || compareIds(a.id, b.id)),
    extensions: extensions.sort((a, b) => compareIds(a.slot, b.slot) || a.order - b.order || compareIds(a.id, b.id)),
    providers: [...(input.providers ?? [])]
      .map(({ id, kind }) => ({ id, kind }))
      .sort((a, b) => compareIds(a.id, b.id)),
    findings,
  };
}

/** The brand title: the estate's name, or deck's when the estate has none. */
function resolveBrand(estateName: string | undefined): UiBrand {
  const title = estateName?.trim() ?? "";
  return { title: title === "" ? DEFAULT_BRAND_TITLE : title };
}

/**
 * The groups of the `app/nav` entries, in sidebar order: the configured groups that have an
 * entry, in config order, then the other groups entries name, by id, headed by their id. A
 * group configured twice keeps its first entry; the repeat is a finding.
 */
function resolveNavGroups(nav: readonly UiNavItem[], ui: UiDefaults, findings: UiFinding[]): UiNavGroup[] {
  const used = new Set(nav.filter((item) => item.slot === NAV_SLOT).map((item) => item.group));
  const known = new Set<string>();
  const configured: UiNavGroup[] = [];
  for (const group of ui.nav.groups) {
    if (known.has(group.id)) {
      findings.push({ code: "UI_DUPLICATE_ID", severity: "warning", message: `nav group "${group.id}" is configured more than once; its first entry is used`, id: group.id });
      continue;
    }
    known.add(group.id);
    if (used.has(group.id)) configured.push(group);
  }
  const others = [...used].filter((id) => !known.has(id)).sort(compareIds).map((id) => ({ id, label: id }));
  return [
    ...configured.map(({ id, label, icon }) => ({ id, label, ...(icon === undefined ? {} : { icon }) })),
    ...others,
  ];
}

/** Modules, then the kernel features no module replaces, by id (a reserved id is listed twice, by origin). */
function collectUnits(input: ResolveUiInput): Unit[] {
  const units: Unit[] = input.modules.map(({ manifest, enabled, reason, builtin }) => ({
    manifest,
    origin: "module",
    enabled,
    ...(reason === undefined ? {} : { reason }),
    ...(builtin === true ? { builtin } : {}),
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

type OverrideTarget = "page" | "nav" | "extension";

/** The override keys each target takes: a page can only be switched, a nav entry also re-attached. */
const OVERRIDE_KEYS: Readonly<Record<OverrideTarget, readonly string[]>> = {
  page: ["enabled"],
  nav: ["enabled", "attachTo"],
  extension: ["enabled", "attachTo", "config"],
};

const TARGET_NAMES: Readonly<Record<OverrideTarget, string>> = { page: "a page", nav: "a nav entry", extension: "an extension" };

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
    const extra = Object.keys(attachTo).filter((key) => key !== "slot" && key !== "order");
    if (extra.length > 0) return `unknown attachTo key ${extra.map((key) => `"${key}"`).join(", ")}`;
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

/** Code-unit order, independent of locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The estate's name in a config document, or none. */
export function estateNameOf(config: unknown): string | undefined {
  const name = (config as { estate?: { name?: unknown } } | null)?.estate?.name;
  return typeof name === "string" ? name : undefined;
}

/** The `ui.extensions` override map of a config document, or none. Entries are checked on resolution. */
export function uiOverridesOf(config: unknown): Record<ExtensionId, unknown> {
  const ui = (config as { ui?: { extensions?: unknown } } | null)?.ui;
  const extensions = ui?.extensions;
  return isRecord(extensions) ? (extensions as Record<ExtensionId, unknown>) : {};
}

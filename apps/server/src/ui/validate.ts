import {
  entitySectionProblem,
  extensionIdProblem,
  EXTENSION_KINDS as KINDS,
  isSafeHref,
  NAV_GROUP_ID_PATTERN,
  orderProblem,
  BUILTIN_ROOT_PATHS,
  pagePathProblem,
  parseExtensionId,
  RESERVED_MODULE_IDS as RESERVED_IDS,
  slotAcceptsProblem,
  slotIdProblem,
  SLOT_ACCEPTS as ACCEPTS,
  type ModuleManifest,
} from "@deck/module-sdk";

import { RESERVED_ROOT_PATHS } from "../server/reserved-paths.js";

/** Module ids the kernel keeps for itself (`core`, which hosts the shell's slots, and `ui`, the ui config's). */
export const RESERVED_MODULE_IDS: ReadonlySet<string> = new Set(RESERVED_IDS);

/** What a slot accepts. */
export const SLOT_ACCEPTS: ReadonlySet<string> = new Set(ACCEPTS);

/** The kinds an extension may have: everything a slot accepts except pages and nav entries. */
export const EXTENSION_KINDS: ReadonlySet<string> = new Set(KINDS);

type Problem = string | null;

export interface UiContributionOptions {
  /**
   * Allow the kernel-reserved slot namespaces (`app/…`, `entity:<entity>/…`). Only the
   * kernel's own feature declarations pass it; a module never does.
   */
  kernel?: boolean;
  /**
   * Root paths no page may use: the kernel's and the built-in modules' (default: the kernel's
   * plus `BUILTIN_ROOT_PATHS`). Planning passes the root paths its built-ins declare.
   */
  reservedRootPaths?: readonly string[];
}

/**
 * Why a manifest's UI contributions (pages, nav, slots, extensions) are unusable, or null.
 * The checks are per module:
 * - ids are well formed and name the module itself;
 * - an extension's kind is one a slot can accept, and its id does not use a page or nav prefix;
 * - a slot id is namespaced to its module (`<module>/…`); `app/…` and `entity:…` are the kernel's;
 * - a page path is not under `/api` or on a root path the kernel or a built-in module serves;
 * - a nav `href` is an `http(s):` URL or an absolute path, and its `group` a nav group id;
 * - an entity section's config has a `title` and, optionally, a `section` name to share (lowercase, no `.`);
 * - every field the resolver reads has the declared type.
 * Cross-module conflicts (an id or a path used twice) are left to the resolver, which reports
 * them as findings.
 */
export function uiContributionProblem(manifest: ModuleManifest, options: UiContributionOptions = {}): Problem {
  const contributes: unknown = manifest.contributes;
  if (contributes === undefined) return null;
  if (!isRecord(contributes)) return "contributes must be an object";
  return (
    listProblem(contributes.pages, "pages", (page) => pageProblem(manifest.id, page, options.reservedRootPaths ?? DEFAULT_RESERVED)) ??
    listProblem(contributes.nav, "nav", (nav) => navProblem(manifest.id, nav)) ??
    listProblem(contributes.slots, "slots", (slot) => slotProblem(manifest.id, slot, options)) ??
    listProblem(contributes.extensions, "extensions", (extension) => extensionProblem(manifest.id, extension))
  );
}

function listProblem(value: unknown, field: string, check: (item: Record<string, unknown>) => Problem): Problem {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `contributes.${field} must be a list`;
  for (const item of value) {
    if (!isRecord(item)) return `contributes.${field} entries must be objects`;
    const problem = check(item);
    if (problem !== null) return `contributes.${field}: ${problem}`;
  }
  return null;
}

function idProblem(moduleId: string, id: unknown, kind?: string): Problem {
  return extensionIdProblem(id, { module: moduleId, ...(kind === undefined ? {} : { kind }) });
}

/** The root paths no page may use, unless planning passes its own built-ins' list. */
const DEFAULT_RESERVED: readonly string[] = [...RESERVED_ROOT_PATHS, ...BUILTIN_ROOT_PATHS];

function pageProblem(moduleId: string, page: Record<string, unknown>, reservedRootPaths: readonly string[]): Problem {
  const label = `page "${String(page.id)}"`;
  return (
    idProblem(moduleId, page.id, "page") ??
    pagePathProblem(page.path, label, reservedRootPaths) ??
    (nonEmpty(page.title) ? null : `${label} needs a title`) ??
    (nonEmpty(page.component) ? null : `${label} needs a component`) ??
    optionalString(page.icon, `${label} icon`)
  );
}

function navProblem(moduleId: string, nav: Record<string, unknown>): Problem {
  const label = `nav entry "${String(nav.id)}"`;
  return (
    idProblem(moduleId, nav.id, "nav") ??
    ((nav.page === undefined) === (nav.href === undefined) ? `${label} needs exactly one of page or href` : null) ??
    (nav.page !== undefined && parseExtensionId(nav.page)?.kind !== "page"
      ? `${label} page must be a page id`
      : null) ??
    optionalString(nav.href, `${label} href`) ??
    (typeof nav.href === "string" && !isSafeHref(nav.href) ? `${label} href must be an http(s) URL or an absolute path` : null) ??
    (nonEmpty(nav.group) ? null : `${label} needs a group`) ??
    (NAV_GROUP_ID_PATTERN.test(nav.group as string) ? null : `${label} group must be a nav group id (lower-case letters, digits and hyphens)`) ??
    optionalString(nav.label, `${label} label`) ??
    optionalString(nav.icon, `${label} icon`) ??
    orderProblem(nav.order, `${label} order`)
  );
}

function slotProblem(moduleId: string, slot: Record<string, unknown>, options: UiContributionOptions): Problem {
  return slotIdProblem(slot.id, moduleId, options) ?? slotAcceptsProblem(slot.accepts, String(slot.id));
}

function extensionProblem(moduleId: string, extension: Record<string, unknown>): Problem {
  const label = `extension "${String(extension.id)}"`;
  const attachTo = extension.attachTo;
  return (
    idProblem(moduleId, extension.id) ??
    (typeof extension.kind === "string" && EXTENSION_KINDS.has(extension.kind)
      ? null
      : `${label} kind must be one of ${[...EXTENSION_KINDS].join(", ")}`) ??
    (isRecord(attachTo) && nonEmpty(attachTo.slot) ? null : `${label} needs attachTo.slot`) ??
    orderProblem(isRecord(attachTo) ? attachTo.order : undefined, `${label} order`) ??
    optionalString(extension.component, `${label} component`) ??
    (extension.widget === undefined || isRecord(extension.widget) ? null : `${label} widget must be an object`) ??
    (extension.config === undefined || isRecord(extension.config) ? null : `${label} config must be an object`) ??
    (extension.kind === "entity-section" ? entitySectionProblem(extension.config, label) : null) ??
    (extension.enabled === undefined || typeof extension.enabled === "boolean" ? null : `${label} enabled must be a boolean`)
  );
}

function optionalString(value: unknown, label: string): Problem {
  return value === undefined || nonEmpty(value) ? null : `${label} must be a non-empty string`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import {
  CONFIG_PAGE_COMPONENT,
  contributedIconsProblem,
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

import { CORE_WIDGET_TYPES } from "@deck/contract/modules/core";
import { widgetOptionsProblem } from "@deck/schema";

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
 * - a page path is not under `/api` or on a root path the kernel or a built-in module serves,
 *   and its component is not the kernel's `ConfigPage`;
 * - a nav `href` is an `http(s):` URL or an absolute path, and its `group` a nav group id;
 * - an entity section's config has a `title` and, optionally, a `section` name to share (lowercase, no `.`);
 * - a widget type is `<module>/<name>` in its own module, listed once, with an options schema
 *   object, and optionally a component name and the provider kinds it renders;
 * - a page's dashboard (`layout`) holds only the module's own widget slots and `{ id, type }`
 *   widgets of its own types or core's, each of whose options schema accepts `{}`;
 * - every field the resolver reads has the declared type.
 * Cross-module conflicts (an id or a path used twice) are left to the resolver, which reports
 * them as findings.
 */
export function uiContributionProblem(manifest: ModuleManifest, options: UiContributionOptions = {}): Problem {
  const contributes: unknown = manifest.contributes;
  if (contributes === undefined) return null;
  if (!isRecord(contributes)) return "contributes must be an object";
  return (
    listProblem(contributes.pages, "pages", (page) => pageProblem(manifest.id, page, options.reservedRootPaths ?? DEFAULT_RESERVED, contributes)) ??
    listProblem(contributes.nav, "nav", (nav) => navProblem(manifest.id, nav)) ??
    listProblem(contributes.slots, "slots", (slot) => slotProblem(manifest.id, slot, options)) ??
    listProblem(contributes.extensions, "extensions", (extension) => extensionProblem(manifest.id, extension)) ??
    listProblem(contributes.widgetTypes, "widgetTypes", (type) => widgetTypeProblem(manifest.id, type)) ??
    duplicateWidgetTypeProblem(contributes.widgetTypes) ??
    contributedIconsProblem(manifest.id, contributes.icons)
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

function pageProblem(
  moduleId: string,
  page: Record<string, unknown>,
  reservedRootPaths: readonly string[],
  contributes: Record<string, unknown>,
): Problem {
  const label = `page "${String(page.id)}"`;
  return (
    idProblem(moduleId, page.id, "page") ??
    pagePathProblem(page.path, label, reservedRootPaths) ??
    (nonEmpty(page.title) ? null : `${label} needs a title`) ??
    (nonEmpty(page.component) ? null : `${label} needs a component`) ??
    // The shell routes every ConfigPage page by its layout: only the kernel's pages are one.
    (page.component === CONFIG_PAGE_COMPONENT ? `${label} component "${CONFIG_PAGE_COMPONENT}" is the kernel's` : null) ??
    optionalString(page.icon, `${label} icon`) ??
    (page.layout === undefined ? null : layoutProblem(moduleId, page.layout, label, contributes))
  );
}

/** A module page dashboard's widget id: unique on the page, the tail of `widget:<module>/<page name>.<id>`. */
const LAYOUT_WIDGET_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Sections and widgets a module page's dashboard may hold. */
const MAX_LAYOUT_SECTIONS = 16;
const MAX_LAYOUT_WIDGETS = 24;

/**
 * Why a module page's dashboard (`layout`) is unusable: each section is exactly a `{ slot }`
 * the module hosts as a `widget` slot, or `{ widgets }` (1–24), each widget exactly `{ id, type }`
 * with an id unique on the page and a type of the module's own (`contributes.widgetTypes`) or
 * core's. Its widgets take no options and read no provider.
 */
function layoutProblem(moduleId: string, layout: unknown, label: string, contributes: Record<string, unknown>): Problem {
  if (!isRecord(layout) || !onlyKeys(layout, ["sections"]) || !Array.isArray(layout.sections)) return `${label} layout must be { sections: [...] }`;
  if (layout.sections.length > MAX_LAYOUT_SECTIONS) return `${label} layout has more than ${MAX_LAYOUT_SECTIONS} sections`;
  const slots = Array.isArray(contributes.slots) ? (contributes.slots as unknown[]).filter(isRecord) : [];
  const ownTypes = Array.isArray(contributes.widgetTypes) ? (contributes.widgetTypes as unknown[]).filter(isRecord) : [];
  const ids = new Set<string>();
  for (const section of layout.sections as unknown[]) {
    if (isRecord(section) && onlyKeys(section, ["slot"]) && typeof section.slot === "string") {
      if (!slots.some((slot) => slot.id === section.slot && slot.accepts === "widget")) {
        return `${label} layout slot "${section.slot}" must be a widget slot the module hosts`;
      }
      continue;
    }
    if (!isRecord(section) || !onlyKeys(section, ["widgets"]) || !Array.isArray(section.widgets)) {
      return `${label} layout sections must be { slot } or { widgets: [...] }`;
    }
    if (section.widgets.length === 0 || section.widgets.length > MAX_LAYOUT_WIDGETS) return `${label} layout sections need 1 to ${MAX_LAYOUT_WIDGETS} widgets`;
    for (const widget of section.widgets as unknown[]) {
      if (!isRecord(widget) || !onlyKeys(widget, ["id", "type"])) return `${label} layout widgets must be { id, type } (they take no options or source)`;
      if (typeof widget.id !== "string" || !LAYOUT_WIDGET_ID.test(widget.id)) return `${label} layout widget id "${String(widget.id)}" must be lowercase letters, digits and "-"`;
      if (ids.has(widget.id)) return `${label} layout widget id "${widget.id}" is used twice`;
      ids.add(widget.id);
      const match = typeof widget.type === "string" ? WIDGET_TYPE.exec(widget.type) : null;
      const declared = match === null
        ? undefined
        : match[1] === moduleId
          ? ownTypes.find((type) => type.type === widget.type)
          : match[1] === "core"
            ? CORE_WIDGET_TYPES.find((type) => type.type === widget.type)
            : undefined;
      if (declared === undefined) return `${label} layout widget "${widget.id}" type must be one of the module's own widget types or core's`;
      // Its options are `{}`: a type whose schema refuses them cannot be placed here.
      const options = widgetOptionsProblem(declared.optionsSchema, {});
      if (options !== null) return `${label} layout widget "${widget.id}" (${String(widget.type)}): ${options}`;
    }
  }
  return null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
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

/** A widget type: `<module>/<name>`. */
const WIDGET_TYPE = /^([a-z][a-z0-9-]*)\/[a-z0-9][a-z0-9-]*$/;

/** A widget type the module lists twice: its own defect, so the module is disabled. */
function duplicateWidgetTypeProblem(types: unknown): Problem {
  if (!Array.isArray(types)) return null;
  const seen = new Set<unknown>();
  for (const { type } of types as Array<{ type?: unknown }>) {
    if (seen.has(type)) return `contributes.widgetTypes: widget type "${String(type)}" is listed twice`;
    seen.add(type);
  }
  return null;
}

function widgetTypeProblem(moduleId: string, type: Record<string, unknown>): Problem {
  const label = `widget type "${String(type.type)}"`;
  const match = typeof type.type === "string" ? WIDGET_TYPE.exec(type.type) : null;
  return (
    (match !== null && match[1] === moduleId ? null : `${label} must have the form ${moduleId}/<name>`) ??
    (isRecord(type.optionsSchema) ? null : `${label} needs an optionsSchema object`) ??
    optionalString(type.component, `${label} component`) ??
    (type.sources === undefined || (Array.isArray(type.sources) && type.sources.every(nonEmpty)) ? null : `${label} sources must be a list of provider kinds`) ??
    (type.optionReferences === undefined ||
    (Array.isArray(type.optionReferences) &&
      type.optionReferences.every((reference) => isRecord(reference) && onlyKeys(reference, ["option", "list", "key"]) && nonEmpty(reference.option) && nonEmpty(reference.list) && nonEmpty(reference.key)))
      ? null
      : `${label} optionReferences must be a list of { option, list, key }`)
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

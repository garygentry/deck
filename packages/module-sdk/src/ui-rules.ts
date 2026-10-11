/**
 * The rules UI contributions follow, shared by the server (which validates manifests) and the
 * web registry (which validates registrations), so both accept exactly the same ids, slots,
 * orders and paths. Pure functions over plain values: each returns why a value is unusable,
 * or `null`.
 */

import type { ExtensionId } from "./manifest.js";

/** `<kind>:<module>/<name>`: a kebab-case kind and module id, then a name. */
export const EXTENSION_ID_PATTERN = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9.-]*)$/;

/** What a slot accepts. Pages and nav entries attach to the shell's `app/routes` and `app/nav`. */
export const SLOT_ACCEPTS: readonly string[] = ["pill", "widget", "entity-section", "nav", "page", "action"];

/** The kinds an extension may have: everything a slot accepts except pages and nav entries. */
export const EXTENSION_KINDS: readonly string[] = ["pill", "widget", "entity-section", "action"];

/** Id prefixes an extension may not use: pages and nav entries have their own declarations. */
export const RESERVED_EXTENSION_PREFIXES: readonly string[] = ["page", "nav"];

/**
 * Module ids the kernel keeps: `core` hosts the shell's slots and widget types, and `ui` owns the
 * ui config's own nav entries, pages and widgets (`nav:ui/…`, `page:ui/…`, `widget:ui/…`), so no
 * module may take either.
 */
export const RESERVED_MODULE_IDS: readonly string[] = ["core", "ui"];

/**
 * The module the ui config's own contributions are listed under in the UI manifest: its nav
 * entries (`ui.nav.items`), its pages (`ui.pages`, `page:ui/<id>`, with `nav:ui/<id>`) and
 * their widgets (`widget:ui/<page>.<name>`).
 */
export const UI_CONFIG_MODULE = "ui";

/**
 * The page component of a page whose body is its manifest `layout` of widget sections: a `ui.pages`
 * page, or a page a module contributes at runtime. The kernel's own: a module manifest's page may
 * not name it, so the shell can route by it alone.
 */
export const CONFIG_PAGE_COMPONENT = "ConfigPage";

/** A `ui.nav.items` entry's id: always in the reserved `ui` namespace, `nav:ui/<name>`. */
export const UI_CONFIG_NAV_ID_PATTERN = /^nav:ui\/[a-z0-9][a-z0-9.-]*$/;

/** A nav group id: kebab-case, as `ui.nav.groups` and a nav entry's `group` override take it. */
export const NAV_GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Root paths outside `/api` the kernel serves, which no page may use. None today. */
export const KERNEL_ROOT_PATHS: readonly string[] = [];

/**
 * Root paths outside `/api` that deck's built-in modules declare (`contributes.routes.rootPaths`),
 * which no page may use, whether the module runs or not. The server checks this list against
 * its built-in modules' manifests, so the two never drift.
 */
export const BUILTIN_ROOT_PATHS: readonly string[] = ["/metrics"];

/** Where the server serves runtime modules' web halves (`/modules/<id>/web.js`): no page or root path may sit under it. */
export const MODULE_ASSETS_ROOT = "/modules";

/** What an icon's markup may not contain, whatever the sanitiser where it renders would do. */
const ICON_MARKERS: readonly (readonly [RegExp, string])[] = [
  [/<style/i, "a <style> element"],
  [/\sstyle\s*=/i, "a style attribute"],
  [/@import/i, "@import"],
  [/\\/, "a backslash (a CSS escape)"],
  [/href\s*=\s*(["'])(?!#)/i, "an href to anything but a local #id"],
  // CSS image functions, which fetch from attributes such as mask or fill.
  [/image-set|image\s*\(|cross-fade|-webkit-|src\s*\(/i, "a CSS image function (image-set, image(), cross-fade, -webkit-, src())"],
];

/** Bounds on a module's contributed icons (`contributes.icons`). */
export const MAX_MODULE_ICONS = 64;
export const MAX_ICON_BYTES = 16 * 1024;

/**
 * Why a module's contributed icons are unusable, or null: at most {@link MAX_MODULE_ICONS}, each
 * named `<module>/<kebab-name>` and an SVG document of at most {@link MAX_ICON_BYTES} UTF-8
 * bytes whose root `<svg>` declares the SVG namespace. As defence in depth beside the web's
 * allowlist sanitiser, markup with styles (`<style`, `style=`, `@import`), a backslash (a CSS
 * escape), an `href` to anything but a local `#id`, or a CSS image function is refused here too.
 */
export function contributedIconsProblem(moduleId: string, icons: unknown): Problem {
  if (icons === undefined) return null;
  if (icons === null || typeof icons !== "object" || Array.isArray(icons)) return "contributes.icons must be an object of name → SVG";
  const entries = Object.entries(icons);
  if (entries.length > MAX_MODULE_ICONS) return `contributes.icons has more than ${MAX_MODULE_ICONS} icons`;
  for (const [name, svg] of entries) {
    const tail = name.startsWith(`${moduleId}/`) ? name.slice(moduleId.length + 1) : "";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tail)) return `icon "${name}" must be named ${moduleId}/<kebab-name>`;
    if (typeof svg !== "string" || !/^\s*<svg[\s>]/.test(svg)) return `icon "${name}" must be SVG markup starting with <svg`;
    if (!/^\s*<svg\b[^>]*\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/.test(svg)) return `icon "${name}" must declare xmlns="http://www.w3.org/2000/svg" on its <svg>`;
    const marker = ICON_MARKERS.find(([pattern]) => pattern.test(svg));
    if (marker !== undefined) return `icon "${name}" must not contain ${marker[1]}`;
    if (new TextEncoder().encode(svg).length > MAX_ICON_BYTES) return `icon "${name}" is larger than ${MAX_ICON_BYTES} bytes`;
  }
  return null;
}

/** Every root path a page may never use: the kernel's and the built-in modules'. */
export const RESERVED_PAGE_PATHS: readonly string[] = [...KERNEL_ROOT_PATHS, ...BUILTIN_ROOT_PATHS];

/** Slot namespaces reserved for the kernel: the shell's `app/…` and the entity pages' `entity:…`. */
const RESERVED_SLOT_NAMESPACE = /^(app\/|entity:)/;

/** Whether a slot id is in a kernel-reserved namespace (`app/…`, `entity:…`), which only core declares. */
export function isKernelSlot(id: string): boolean {
  return RESERVED_SLOT_NAMESPACE.test(id);
}

/** A slot id's tail after its `<module>/` namespace: one or more `/`-separated names. */
const SLOT_NAME = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*)*$/;

type Problem = string | null;

/** The parts of a well-formed extension id, or null. */
export function parseExtensionId(id: unknown): { kind: string; module: string; name: string } | null {
  const match = typeof id === "string" ? EXTENSION_ID_PATTERN.exec(id) : null;
  return match === null ? null : { kind: match[1]!, module: match[2]!, name: match[3]! };
}

/**
 * Why an id is unusable for `moduleId`: malformed, naming another module, not of `kind` when
 * one is required, or (without a required kind) using a reserved `page:`/`nav:` prefix.
 */
export function extensionIdProblem(id: unknown, options: { module?: string; kind?: string } = {}): Problem {
  const parts = parseExtensionId(id);
  if (parts === null) return `id "${String(id)}" must have the form <kind>:<module>/<name>`;
  if (options.module !== undefined && parts.module !== options.module) {
    return `id "${String(id)}" must name its own module ("${options.module}")`;
  }
  if (options.kind !== undefined && parts.kind !== options.kind) return `id "${String(id)}" must start with "${options.kind}:"`;
  if (options.kind === undefined && RESERVED_EXTENSION_PREFIXES.includes(parts.kind)) {
    return `id "${String(id)}" uses the "${parts.kind}:" prefix, which only ${parts.kind} declarations may use`;
  }
  return null;
}

/**
 * Why a slot id is unusable for its host `module`: outside `<module>/<name>` (with a well-formed
 * name), or in a kernel-reserved namespace (`app/…`, `entity:…`) unless `kernel` is set.
 */
export function slotIdProblem(id: unknown, module: string, options: { kernel?: boolean } = {}): Problem {
  if (typeof id !== "string" || id.length === 0) return "slot id must be a non-empty string";
  if (isKernelSlot(id)) {
    return options.kernel === true ? null : `slot "${id}" is in a kernel-reserved namespace (app/, entity:)`;
  }
  if (!id.startsWith(`${module}/`) || !SLOT_NAME.test(id.slice(module.length + 1))) {
    return `slot "${id}" must be namespaced to its module ("${module}/<name>")`;
  }
  return null;
}

/** Why `accepts` is not a slot kind. */
export function slotAcceptsProblem(accepts: unknown, slotId: string): Problem {
  return typeof accepts === "string" && SLOT_ACCEPTS.includes(accepts)
    ? null
    : `slot "${slotId}" accepts must be one of ${SLOT_ACCEPTS.join(", ")}`;
}

/** Why an optional order is not a finite number. */
export function orderProblem(order: unknown, label: string): Problem {
  return order === undefined || (typeof order === "number" && Number.isFinite(order)) ? null : `${label} must be a finite number`;
}

/**
 * The RegExp the web router (wouter, through regexparam 3) builds for a route pattern, or the
 * error compiling it throws. A copy of regexparam's `parse`, kept to the compile step: the
 * web tests check it agrees with the router's own parser.
 */
function compileRoutePattern(pattern: string): RegExp {
  let source = "";
  const segments = pattern.split("/");
  if (segments[0] === "") segments.shift();
  for (let segment = segments.shift(); segment; segment = segments.shift()) {
    const first = segment[0];
    if (first === "*") {
      source += segment[1] === "?" ? "(?:/(.*))?" : "/(.*)";
    } else if (first === ":") {
      const optional = segment.indexOf("?", 1);
      const ext = segment.indexOf(".", 1);
      source += optional !== -1 && ext === -1 ? "(?:/([^/]+?))?" : "/([^/]+?)";
      if (ext !== -1) source += (optional !== -1 ? "?" : "") + "\\" + segment.substring(ext);
    } else {
      source += "/" + segment;
    }
  }
  return new RegExp("^" + source + "\\/?$", "i");
}

/** Why a path is not a route pattern the web router can compile (a stray `[` or `(` throws there). */
export function routablePathProblem(path: string, label: string): Problem {
  try {
    compileRoutePattern(path);
    return null;
  } catch {
    return `${label} path "${path}" is not a route pattern the web router can compile`;
  }
}

/**
 * Why a page path is unusable: not absolute, not a route pattern the web router compiles,
 * under `/api` (the server answers it), or a reserved root path (by default the kernel's and
 * the built-in modules', {@link RESERVED_PAGE_PATHS}).
 */
export function pagePathProblem(path: unknown, label: string, reservedRootPaths: readonly string[] = RESERVED_PAGE_PATHS): Problem {
  if (typeof path !== "string" || !path.startsWith("/")) return `${label} path must start with "/"`;
  const unroutable = routablePathProblem(path, label);
  if (unroutable !== null) return unroutable;
  if (path === "/api" || path.startsWith("/api/")) return `${label} path "${path}" is under /api, which the server answers`;
  if (path === MODULE_ASSETS_ROOT || path.startsWith(`${MODULE_ASSETS_ROOT}/`)) return `${label} path "${path}" is under ${MODULE_ASSETS_ROOT}, which serves runtime modules' web halves`;
  if (reservedRootPaths.includes(path)) return `${label} path "${path}" is a reserved root path, which the server answers`;
  return null;
}

/**
 * A section name an entity section may name explicitly to share it: lowercase letters, digits and
 * `-`, with no `.`. Dotted names are reserved for the implicit `<module>.<name>` sections
 * ({@link entitySectionName}), so an extension's own section cannot be joined. Both kinds are
 * safe in a DOM id (`entity-slot-<name>`).
 */
export const ENTITY_SECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Why an `entity-section` extension's config is unusable. An entity page (`entity:host/sections`,
 * `entity:service/sections`) is open: every extension attached to it renders in a section of its
 * own unless it names a shared `section`. Its config needs a `title`, the section's heading, and
 * may name the `section` it joins (no `.`), so several extensions (from any module) can render
 * under one heading. Without one, the extension has its own section, which cannot be joined
 * ({@link entitySectionName}). Sections render in the order of their first extension.
 */
export function entitySectionProblem(config: unknown, label: string): Problem {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return `${label} config needs a title`;
  const { title, section } = config as Record<string, unknown>;
  if (typeof title !== "string" || title.trim().length === 0) return `${label} config needs a title`;
  if (section !== undefined && (typeof section !== "string" || !ENTITY_SECTION_NAME_PATTERN.test(section))) {
    return `${label} config section must be a lowercase name (a-z, 0-9, "-"); dotted names are reserved for implicit sections`;
  }
  return null;
}

/**
 * The section an entity-section extension renders in: the `section` its config names (shared on
 * purpose, e.g. `findings`), else its own `<module>.<name>` from its id. The `.` keeps the two
 * apart: no explicit name has one, so an extension's own section cannot be joined, and two
 * modules' extensions with the same name never merge. Null for a malformed id.
 */
export function entitySectionName(id: unknown, config: unknown): string | null {
  const section = config !== null && typeof config === "object" ? (config as Record<string, unknown>).section : undefined;
  if (typeof section === "string") return section;
  const parts = parseExtensionId(id);
  return parts === null ? null : `${parts.module}.${parts.name}`;
}

/** Whether a link leaves the app: an `http(s):` URL with a host. */
export function isExternalHref(href: string): boolean {
  return /^https?:\/\/[^/]/i.test(href);
}

// Spaces, controls and backslashes: a browser drops tabs and line breaks from a URL and reads
// `\` as `/`, so `/\t/evil.example` or `/\evil.example` would leave deck.
const UNSAFE_HREF_CHARS = /[\u0000-\u0020\u007f\\]/;
const SAME_ORIGIN = "http://deck.invalid";

/**
 * Whether a link is safe to render: an `http(s):` URL, or an absolute path that stays on this
 * origin once a browser parses it (not `//…`). A link holding a space, a control character or a
 * backslash never is.
 */
export function isSafeHref(href: string): boolean {
  if (UNSAFE_HREF_CHARS.test(href)) return false;
  if (isExternalHref(href)) return true;
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  try {
    return new URL(href, SAME_ORIGIN).origin === SAME_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * A module page dashboard widget's id: `widget:<module>/<page name>.<id>`, from its page's id
 * (`page:<module>/<page name>`). The server lists it, an override names it, and the web
 * renders a declared layout under the same id. Null for a malformed page id.
 */
export function modulePageWidgetId(page: string, widget: string): ExtensionId | null {
  const parts = parseExtensionId(page);
  return parts === null ? null : `widget:${parts.module}/${parts.name}.${widget}`;
}

/** The page `/` renders when the `ui` config names no home page: the portal's overview. */
export const DEFAULT_HOME_PAGE = "page:portal/overview";

/** Why a page path cannot be the home page's, or `null`: `/` renders it with no parameters. */
export function homePathProblem(path: string): string | null {
  return /[:*]/.test(path) ? `its path "${path}" has parameters, which "/" cannot supply` : null;
}

/**
 * The UI finding codes about reloading the config itself, rather than about resolving it: the
 * config changed and no longer loads, or changed outside `ui`. The shell shows these.
 */
export const UI_RELOAD_FINDING_CODES: readonly string[] = ["UI_CONFIG_INVALID", "UI_RESTART_REQUIRED"];

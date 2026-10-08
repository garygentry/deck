/**
 * The rules UI contributions follow, shared by the server (which validates manifests) and the
 * web registry (which validates registrations), so both accept exactly the same ids, slots,
 * orders and paths. Pure functions over plain values: each returns why a value is unusable,
 * or `null`.
 */

/** `<kind>:<module>/<name>`: a kebab-case kind and module id, then a name. */
export const EXTENSION_ID_PATTERN = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9.-]*)$/;

/** What a slot accepts. Pages and nav entries attach to the shell's `app/routes` and `app/nav`. */
export const SLOT_ACCEPTS: readonly string[] = ["pill", "widget", "entity-section", "nav", "page", "action"];

/** The kinds an extension may have: everything a slot accepts except pages and nav entries. */
export const EXTENSION_KINDS: readonly string[] = ["pill", "widget", "entity-section", "action"];

/** Id prefixes an extension may not use: pages and nav entries have their own declarations. */
export const RESERVED_EXTENSION_PREFIXES: readonly string[] = ["page", "nav"];

/** Module ids the kernel keeps: `core` hosts the shell's slots, so no module may replace it. */
export const RESERVED_MODULE_IDS: readonly string[] = ["core"];

/** The module the ui config's own nav entries (`ui.nav.items`) are listed under in the UI manifest. */
export const UI_CONFIG_MODULE = "ui";

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

/** Whether a nav link is safe: an `http(s):` URL, or an absolute path on this origin (not `//…`). */
export function isSafeHref(href: string): boolean {
  if (/^https?:\/\/[^/]/i.test(href)) return true;
  return href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\");
}

/** The page `/` renders when the `ui` config names no home page: the portal's overview. */
export const DEFAULT_HOME_PAGE = "page:portal/overview";

/** Why a page path cannot be the home page's, or `null`: `/` renders it with no parameters. */
export function homePathProblem(path: string): string | null {
  return /[:*]/.test(path) ? `its path "${path}" has parameters, which "/" cannot supply` : null;
}

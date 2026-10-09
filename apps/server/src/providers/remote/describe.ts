import { isExternalHref, isSafeHref, type JsonObject } from "@deck/module-sdk";
import { CORE_WIDGET_TYPES } from "@deck/contract/modules/core";
import { compileWidgetOptions, createAjv, remoteDescribeSchema, type SchemaProblem } from "@deck/schema";
import { selectProblem } from "@deck/schema/select";
import MarkdownIt from "markdown-it";

/**
 * The widget types a sidecar may place: deck's declarative `core/…` types, each rendered by
 * `@/ui` from data. Not a `core/` prefix: `core/health-pills` shows the shell's own state, and
 * `core/embed` (a frame) is never one a sidecar can name, whatever `ui.allowUnsafeEmbeds` says.
 */
export const REMOTE_WIDGET_TYPES: ReadonlySet<string> = new Set([
  "core/stat",
  "core/stat-grid",
  "core/meter",
  "core/key-value",
  "core/list",
  "core/table",
  "core/status-grid",
  "core/link-tiles",
  "core/markdown",
  "core/json",
]);

/** The widget id deck gives a sidecar's link tiles; a sidecar's own widget may not take it. */
export const REMOTE_LINKS_WIDGET = "links";

/** The longest string anywhere in a describe document (the markdown widget's own cap). */
export const REMOTE_MAX_STRING = 20_000;

export interface RemoteWidget {
  id: string;
  type: string;
  title?: string;
  select?: string;
  options?: JsonObject;
  span?: number;
  rows?: number;
}

export interface RemoteLink {
  title: string;
  href: string;
  description?: string;
  icon?: string;
}

export interface RemoteNav {
  id: string;
  label: string;
  href: string;
  icon?: string;
  order?: number;
}

/** A describe document that passed every check. */
export interface RemoteDescribe {
  deck: 1;
  id: string;
  version: string;
  title?: string;
  columns?: number;
  widgets: RemoteWidget[];
  links: RemoteLink[];
  nav: RemoteNav[];
}

export type DescribeCheck =
  | { ok: true; describe: RemoteDescribe; notes: string[] }
  | { ok: false; problem: string };

const checkSchema = createAjv().compile(remoteDescribeSchema());
/** Each allowed type's options check, compiled once. */
const optionChecks: ReadonlyMap<string, (options: unknown) => SchemaProblem | null> = new Map(
  CORE_WIDGET_TYPES.filter((entry) => REMOTE_WIDGET_TYPES.has(entry.type)).map((entry) => [entry.type, compileWidgetOptions(entry.optionsSchema)]),
);

/**
 * Check a sidecar's describe document for the integration `instanceId`: its schema (the config's
 * own descriptors), then what a schema cannot say. A widget's type must be one of
 * {@link REMOTE_WIDGET_TYPES}, its options must satisfy that type's schema and its `select` the
 * server's select limits; a link's href must pass `isSafeHref`, and a nav href is an external
 * http(s) URL. Any problem refuses the whole document. A document naming another id is still
 * used (the id picks nothing), with a note. Problems name a path, never echo the document.
 */
export function checkDescribe(value: unknown, instanceId: string): DescribeCheck {
  const long = longStringPath(value);
  if (long !== null) return { ok: false, problem: `${long} is longer than ${REMOTE_MAX_STRING} characters` };
  if (!checkSchema(value)) {
    const [first] = checkSchema.errors ?? [];
    return { ok: false, problem: `${first?.instancePath || "the document"} ${first?.message ?? "is invalid"}` };
  }
  const document = value as unknown as Omit<RemoteDescribe, "widgets" | "links" | "nav"> & Partial<RemoteDescribe>;
  const describe: RemoteDescribe = { ...document, widgets: document.widgets ?? [], links: document.links ?? [], nav: document.nav ?? [] };

  const widgetIds = new Set<string>();
  for (const [index, widget] of describe.widgets.entries()) {
    const at = `/widgets/${index}`;
    if (widgetIds.has(widget.id)) return { ok: false, problem: `${at} repeats widget id "${widget.id}"` };
    if (widget.id === REMOTE_LINKS_WIDGET) return { ok: false, problem: `${at} id "${REMOTE_LINKS_WIDGET}" is deck's own (its links)` };
    widgetIds.add(widget.id);
    if (!REMOTE_WIDGET_TYPES.has(widget.type)) return { ok: false, problem: `${at} type "${widget.type}" is not one a sidecar may place` };
    const checkOptions = optionChecks.get(widget.type);
    const optionsProblem = checkOptions === undefined ? { path: "/", message: "has no options check" } : checkOptions(widget.options ?? {});
    if (optionsProblem !== null) return { ok: false, problem: `${at}/options${optionsProblem.path === "/" ? "" : optionsProblem.path} ${optionsProblem.message}` };
    const unsafeLink = unsafeOptionHref(widget.options) ?? unsafeMarkdownHref(widget.options);
    if (unsafeLink !== null) return { ok: false, problem: `${at} options: ${unsafeLink}` };
    if (widget.select !== undefined) {
      const problem = selectProblem(widget.select);
      if (problem !== null) return { ok: false, problem: `${at} select: ${problem}` };
    }
  }
  for (const [index, link] of describe.links.entries()) {
    if (!isSafeHref(link.href)) return { ok: false, problem: `/links/${index}/href is not a safe link` };
  }
  const navIds = new Set<string>();
  for (const [index, entry] of describe.nav.entries()) {
    if (navIds.has(entry.id)) return { ok: false, problem: `/nav/${index} repeats nav id "${entry.id}"` };
    navIds.add(entry.id);
    if (!isExternalHref(entry.href) || !isSafeHref(entry.href)) return { ok: false, problem: `/nav/${index}/href is not a safe external link` };
  }
  const notes = describe.id === instanceId ? [] : [`it names itself "${describe.id}", not "${instanceId}"; the integration's id is used`];
  return { ok: true, describe, notes };
}

/** A `core/link-tiles` option link whose href `isSafeHref` refuses (the schema checks only its shape). */
function unsafeOptionHref(options: JsonObject | undefined): string | null {
  const links = options?.links;
  if (!Array.isArray(links)) return null;
  for (const [index, link] of links.entries()) {
    const href = (link as { href?: unknown } | null)?.href;
    if (typeof href === "string" && !isSafeHref(href)) return `links/${index}/href is not a safe link`;
  }
  return null;
}

/**
 * Markdown parsed as the web renders it (raw HTML on, bare URLs linked). Every link destination
 * is kept for the check, even one the renderer would drop (`javascript:`), so it is refused here.
 */
const markdown = new MarkdownIt({ html: true, linkify: true });
markdown.validateLink = () => true;

/** Attributes of a real HTML tag that navigate, submit or fetch. */
const URL_ATTRIBUTE = /^(?:href|xlink:href|src|srcset|action|formaction|poster|background|cite|longdesc|data|ping)$/i;
/** One HTML start tag, and one attribute in it (name, then a quoted or bare value). */
const HTML_TAG = /<[A-Za-z][^\s/>]*((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const HTML_ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * The link and resource targets of markdown text, from its parse: link destinations (inline,
 * reference-style and autolinks), image sources, and the URL attributes of real HTML tags
 * (`html_inline` / `html_block` tokens). Code spans and fences are never read.
 */
function markdownTargets(text: string): string[] {
  const targets: string[] = [];
  const html = (fragment: string) => {
    for (const tag of fragment.matchAll(HTML_TAG)) {
      for (const [, name, double, single, bare] of (tag[1] ?? "").matchAll(HTML_ATTRIBUTE)) {
        if (name !== undefined && URL_ATTRIBUTE.test(name)) targets.push(double ?? single ?? bare ?? "");
      }
    }
  };
  const pending = markdown.parse(text, {});
  while (pending.length > 0) {
    const token = pending.shift()!;
    if (token.type === "link_open") targets.push(token.attrGet("href") ?? "");
    else if (token.type === "image") targets.push(token.attrGet("src") ?? "");
    else if (token.type === "html_inline" || token.type === "html_block") html(token.content);
    if (token.children !== null) pending.push(...token.children);
  }
  return targets;
}

/**
 * A `core/markdown` `content` target that is not an absolute http(s) URL (a path, a
 * protocol-relative `//host`, another scheme): a sidecar's markdown may link only off deck.
 * Best effort before rendering; the web's render-time link policy is the authority.
 */
function unsafeMarkdownHref(options: JsonObject | undefined): string | null {
  const content = options?.content;
  if (typeof content !== "string") return null;
  for (const target of markdownTargets(content)) {
    if (!isExternalHref(target) || !isSafeHref(target)) return "content links somewhere other than an absolute http(s) URL";
  }
  return null;
}

/** The JSON pointer of the first string or key longer than {@link REMOTE_MAX_STRING}, or null. Iterative. */
function longStringPath(value: unknown): string | null {
  const pending: Array<[unknown, string]> = [[value, ""]];
  while (pending.length > 0) {
    const [current, path] = pending.pop()!;
    if (typeof current === "string") {
      if (current.length > REMOTE_MAX_STRING) return path || "the document";
    } else if (Array.isArray(current)) {
      current.forEach((item, index) => pending.push([item, `${path}/${index}`]));
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (key.length > REMOTE_MAX_STRING) return `${path}/<key>`;
        pending.push([child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`]);
      }
    }
  }
  return null;
}

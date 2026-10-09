import { randomBytes } from "node:crypto";

import type { UiManifest } from "@deck/module-sdk";
import { frameOriginOf, ORIGIN_SETTING_PATTERN } from "@deck/schema/embed";
import type { MiddlewareHandler } from "hono";

/**
 * The browser policy deck sends. Every response carries its own `frame-ancestors` policy (who may
 * frame deck), `X-Frame-Options` while only deck may, and `nosniff`; the web shell's page also
 * carries the full Content-Security-Policy, whose script nonce is fresh per response.
 */

/** What `ui.frameAncestors` and `ui.frameSources` accept (the config schema's pattern). */
export const ORIGIN_SETTING = new RegExp(ORIGIN_SETTING_PATTERN);

/** The origins a `ui` origin list (`frameAncestors`, `frameSources`) names, by config. */
function originSetting(config: unknown, key: "frameAncestors" | "frameSources"): readonly string[] {
  const value = (config as { ui?: Record<string, unknown> } | null)?.ui?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && ORIGIN_SETTING.test(item)) : [];
}

/** The ancestors deck may be framed by beside its own origin (`ui.frameAncestors`). */
export function frameAncestorsOf(config: unknown): readonly string[] {
  return originSetting(config, "frameAncestors");
}

/** The `frame-ancestors` policy: deck's own origin, plus `extra`. */
export function frameAncestorsDirective(extra: readonly string[]): string {
  return ["frame-ancestors", "'self'", ...extra].join(" ");
}

/**
 * The origins of the `core/embed` widgets a manifest places (config pages' sections, and widget
 * extensions), while it allows embeds; none otherwise. Only origins a CSP source expression can
 * name ({@link frameOriginOf}). Worked out once per manifest.
 */
export function embedOriginsOf(manifest: UiManifest | undefined): readonly string[] {
  if (manifest?.allowUnsafeEmbeds !== true) return [];
  let origins = embedOrigins.get(manifest);
  if (origins === undefined) {
    const found = new Set<string>();
    const add = (widget: unknown) => {
      const { type, options } = (widget ?? {}) as { type?: unknown; options?: { url?: unknown } };
      const origin = type === "core/embed" ? frameOriginOf(options?.url) : null;
      if (origin !== null) found.add(origin);
    };
    for (const page of manifest.pages ?? []) {
      for (const section of page.layout?.sections ?? []) {
        if ("widgets" in section) section.widgets.forEach(add);
      }
    }
    for (const extension of manifest.extensions ?? []) add(extension.widget);
    origins = Object.freeze([...found].sort());
    embedOrigins.set(manifest, origins);
  }
  return origins;
}
const embedOrigins = new WeakMap<UiManifest, readonly string[]>();

/**
 * Whether a CSP source of {@link ORIGIN_SETTING}'s shape (or an exact origin) matches `origin`:
 * the same host (a `*.` wildcard matching any subdomain), a scheme at least as strong (`http:`
 * also matches `https:`, as CSP does), and the port, or the scheme's default when the source
 * names none.
 */
export function sourceMatches(source: string, origin: string): boolean {
  const parsed = /^(https?):\/\/(\*\.)?([^:]+)(?::(\d+))?$/.exec(source);
  const defaultPort = (scheme: string) => (scheme === "https" ? 443 : 80);
  if (parsed === null) return false;
  const [, scheme, wildcard, host, port] = parsed;
  let target: URL;
  try {
    target = new URL(origin);
  } catch {
    return false;
  }
  const targetScheme = target.protocol.slice(0, -1);
  if (targetScheme !== scheme && !(scheme === "http" && targetScheme === "https")) return false;
  const targetHost = target.hostname.toLowerCase();
  const sourceHost = host!.toLowerCase();
  if (wildcard === undefined ? targetHost !== sourceHost : !targetHost.endsWith(`.${sourceHost}`)) return false;
  // Ports compare as numbers (`0443` is 443), and an absent one is its scheme's default.
  const targetPort = target.port === "" ? defaultPort(targetScheme) : Number(target.port);
  const sourcePort = port === undefined ? defaultPort(targetScheme) : Number(port);
  return targetPort === sourcePort || (port === undefined && scheme === "http" && targetScheme === "https" && targetPort === 443);
}

/**
 * The origins the shell may frame for a request: its manifest's embed origins and, while embeds
 * are on, `ui.frameSources`; never deck's own origin as the request reached it (`selfOrigins`),
 * nor a wildcard that covers it, which is dropped whole. `dropped` names what was left out:
 * an embed's own origin (the widget then says deck does not frame its own pages) or a
 * `ui.frameSources` entry.
 */
export function frameOriginsFor(
  manifest: UiManifest | undefined,
  config: unknown,
  selfOrigins: readonly string[],
): { allowed: string[]; dropped: { embeds: string[]; frameSources: string[] } } {
  if (manifest?.allowUnsafeEmbeds !== true) return { allowed: [], dropped: { embeds: [], frameSources: [] } };
  const isSelf = (source: string) => selfOrigins.some((self) => sourceMatches(source, self));
  const embeds = embedOriginsOf(manifest);
  const listed = originSetting(config, "frameSources");
  return {
    allowed: [...new Set([...embeds, ...listed])].filter((source) => !isSelf(source)).sort(),
    dropped: { embeds: embeds.filter(isSelf), frameSources: listed.filter(isSelf) },
  };
}

/**
 * Deck's own origin as a request reached it: its URL's (the Host it was sent to), and, behind
 * the documented reverse proxy, the one `X-Forwarded-Proto` and `X-Forwarded-Host` name (their
 * first values). Used only to keep deck out of `frame-src`, so a forged header can only narrow it.
 */
export function requestOrigins(url: string, header: (name: string) => string | undefined): string[] {
  const origins = new Set<string>();
  const add = (candidate: string) => {
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Not an origin: nothing to exclude.
    }
  };
  add(url);
  const host = header("x-forwarded-host")?.split(",")[0]?.trim();
  if (host !== undefined && host !== "") {
    const forwardedProto = header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    const protos = forwardedProto === "http" || forwardedProto === "https" ? [forwardedProto] : ["http", "https"];
    for (const proto of protos) add(`${proto}://${host}`);
  }
  return [...origins];
}

/** A fresh script nonce: 128 random bits, base64. */
export function scriptNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * The web shell's Content-Security-Policy (framing is the separate policy every response
 * carries, {@link securityHeaders}):
 * - scripts from deck's origin (the app, `@deck/sdk` and runtime modules' `/modules/<id>/web.js`)
 *   and the page's own inline scripts carrying `nonce` (the import map and the pre-paint theme);
 *   no `eval`;
 * - styles from deck's origin, and inline ones (the UI library and sanitized markup set them);
 * - images from anywhere over http(s), `data:` and `blob:` (brand logos, markdown images);
 * - requests (`fetch`) to deck's origin only;
 * - frames of `frameOrigins` only (never deck's own origin), so a framed page that redirects
 *   or navigates into deck is refused;
 * - no plugins, no `<base>`, and forms posting to deck only.
 */
export function shellPolicy(options: { nonce: string; frameOrigins: readonly string[] }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${options.nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${options.frameOrigins.length === 0 ? "'none'" : options.frameOrigins.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * `response` with headers deck may change: the same body, status and headers, in a fresh
 * `Headers` (copied entry by entry if a runtime's `Headers` will not take the original whole).
 */
export function mutableCopy(response: Response): Response {
  let headers: Headers;
  try {
    headers = new Headers(response.headers);
  } catch {
    headers = new Headers();
    response.headers.forEach((value, name) => headers.append(name, value));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Set the framing policy on every response, read per request from `frameAncestors` (so a `ui`
 * hot reload applies at once). It is a Content-Security-Policy of its own, appended, so any
 * other policy a route sets (the shell's, a module's) still applies beside it, and a looser
 * one cannot relax it. `X-Frame-Options: SAMEORIGIN` goes with it while only deck may frame
 * itself, and is never sent otherwise (it cannot name another origin). Also `nosniff`. A
 * response whose headers are immutable (a `fetch()` result, `Response.redirect`) is copied first.
 */
export function securityHeaders(frameAncestors: () => readonly string[]): MiddlewareHandler {
  return async (context, next) => {
    await next();
    const extra = frameAncestors();
    const apply = (headers: Headers) => {
      headers.append("Content-Security-Policy", frameAncestorsDirective(extra));
      if (extra.length === 0) headers.set("X-Frame-Options", "SAMEORIGIN");
      else headers.delete("X-Frame-Options");
      headers.set("X-Content-Type-Options", "nosniff");
    };
    try {
      apply(context.res.headers);
    } catch {
      // Hono's setter copies the old response's headers onto the new one, so apply after it.
      context.res = mutableCopy(context.res);
      apply(context.res.headers);
    }
  };
}

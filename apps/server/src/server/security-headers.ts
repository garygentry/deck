import { randomBytes } from "node:crypto";

import type { UiManifest } from "@deck/module-sdk";
import { embedUrlProblem } from "@deck/schema/embed";
import type { MiddlewareHandler } from "hono";

/**
 * The browser policy deck sends. Every response carries `frame-ancestors` (who may frame deck)
 * and `nosniff`; the web shell's page carries the full Content-Security-Policy, whose script
 * nonce is fresh per response.
 */

/** The ancestors deck may be framed by beside its own origin (`ui.frameAncestors`), by config. */
export function frameAncestorsOf(config: unknown): readonly string[] {
  const value = (config as { ui?: { frameAncestors?: unknown } } | null)?.ui?.frameAncestors;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && FRAME_ANCESTOR.test(item)) : [];
}

/**
 * What `ui.frameAncestors` accepts: an http(s) origin, its host optionally starting with a
 * `*.` wildcard, with an optional port and no path. The schema holds the same pattern.
 */
export const FRAME_ANCESTOR = /^https?:\/\/(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?$/;

/** The `frame-ancestors` directive: deck's own origin, plus `extra`. */
export function frameAncestorsDirective(extra: readonly string[]): string {
  return ["frame-ancestors", "'self'", ...extra].join(" ");
}

/**
 * The origins the shell may frame: those of the manifest's `core/embed` widgets, wherever they
 * are placed, while it allows embeds; none otherwise. Only an origin a CSP source expression
 * can name (an http(s) scheme, a host name or IPv4 address, a port) is listed.
 */
export function frameOriginsOf(manifest: UiManifest | undefined): string[] {
  if (manifest?.allowUnsafeEmbeds !== true) return [];
  const origins = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object" || value === null) return;
    const node = value as { type?: unknown; options?: { url?: unknown } };
    const url = node.options?.url;
    if (node.type === "core/embed" && typeof url === "string" && embedUrlProblem(url) === null) {
      const { origin } = new URL(url);
      if (CSP_ORIGIN.test(origin)) origins.add(origin);
    }
    Object.values(value).forEach(visit);
  };
  visit(manifest);
  return [...origins].sort();
}

/** An origin a CSP host-source matches exactly (an IPv6 literal cannot be written as one). */
const CSP_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

/** A fresh script nonce: 128 random bits, base64. */
export function scriptNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * The web shell's Content-Security-Policy:
 * - scripts from deck's origin (the app, `@deck/sdk` and runtime modules' `/modules/<id>/web.js`)
 *   and the page's own inline scripts carrying `nonce` (the import map and the pre-paint theme);
 *   no `eval`;
 * - styles from deck's origin, and inline ones (the UI library and sanitized markup set them);
 * - images from anywhere over http(s), `data:` and `blob:` (brand logos, markdown images);
 * - requests (`fetch`) to deck's origin only;
 * - frames of `frameOrigins` only, never deck's own origin, so a framed page that redirects or
 *   navigates into deck is refused;
 * - no plugins, no `<base>`, forms posting to deck only, and deck framed only by `frameAncestors`.
 */
export function shellPolicy(options: { nonce: string; frameOrigins: readonly string[]; frameAncestors: readonly string[] }): string {
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
    frameAncestorsDirective(options.frameAncestors),
  ].join("; ");
}

/**
 * Set the policy every response carries, read per request from `frameAncestors` (so a `ui`
 * hot reload applies at once): `frame-ancestors`, plus `X-Frame-Options: SAMEORIGIN` for older
 * browsers when deck may be framed by its own origin only (it cannot name another origin), and
 * `X-Content-Type-Options: nosniff`. A response that sets its own Content-Security-Policy (the
 * shell's) keeps it.
 */
export function securityHeaders(frameAncestors: () => readonly string[]): MiddlewareHandler {
  return async (context, next) => {
    await next();
    const extra = frameAncestors();
    const headers = context.res.headers;
    if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", frameAncestorsDirective(extra));
    if (extra.length === 0) headers.set("X-Frame-Options", "SAMEORIGIN");
    else headers.delete("X-Frame-Options");
    headers.set("X-Content-Type-Options", "nosniff");
  };
}

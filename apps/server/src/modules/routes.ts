/**
 * Path rules for module routes. Module prefixes and root paths are literal paths only, so
 * what a manifest declares is exactly what the router matches; kernel routes are Hono
 * patterns (`:param`, `*`), compared segment by segment.
 */

/** The prefix every module's own sub-app is mounted under. */
export const MODULE_ROUTE_PREFIX = "/api/m";

const LITERAL_PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;

export function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/** A literal path: `/`-separated segments of `A-Z a-z 0-9 . _ ~ -`, no `.`/`..`, no trailing slash. */
export function isLiteralPath(path: string): boolean {
  return LITERAL_PATH.test(path) && !segments(path).some((s) => s === "." || s === "..");
}

/** Why a legacy alias is unusable, or null. */
export function aliasProblem(alias: string): string | null {
  if (!isLiteralPath(alias)) return "must be a literal path (A-Z a-z 0-9 . _ ~ - /)";
  const parts = segments(alias);
  if (parts[0] !== "api" || parts.length < 2) return "must be under /api/";
  if (parts[1] === "m") return `must be outside ${MODULE_ROUTE_PREFIX}`;
  return null;
}

/** Why a root path is unusable, or null. */
export function rootPathProblem(path: string): string | null {
  if (!isLiteralPath(path)) return "must be a literal path (A-Z a-z 0-9 . _ ~ - /)";
  if (segments(path)[0] === "api") return "must be outside /api";
  if (segments(path)[0] === "modules") return "must be outside /modules";
  return null;
}

/** Whether one literal prefix equals, or is a segment-wise ancestor of, the other. */
export function prefixesOverlap(a: string, b: string): boolean {
  const left = segments(a);
  const right = segments(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

const matchesSegment = (pattern: string, literal: string) => pattern.startsWith(":") || pattern === literal;

/**
 * Whether a router pattern can match the literal `prefix` or any path beneath it, i.e.
 * whether it would compete with a sub-app mounted at `prefix`.
 */
export function patternReachesPrefix(pattern: string, prefix: string): boolean {
  const pat = segments(pattern);
  const lit = segments(prefix);
  for (let i = 0; i < Math.min(pat.length, lit.length); i += 1) {
    if (pat[i] === "*") return true;
    if (!matchesSegment(pat[i]!, lit[i]!)) return false;
  }
  // Equal or longer patterns reach the prefix or something under it; a shorter one stops above.
  return pat.length >= lit.length;
}

/** Whether a router pattern matches exactly the literal `path`. */
export function patternMatchesPath(pattern: string, path: string): boolean {
  const pat = segments(pattern);
  const lit = segments(path);
  for (let i = 0; i < pat.length; i += 1) {
    if (pat[i] === "*") return true;
    if (i >= lit.length || !matchesSegment(pat[i]!, lit[i]!)) return false;
  }
  return pat.length === lit.length;
}

/** Global middleware patterns (`*`, `/*`) are not routes that can shadow a module. */
export function isCatchAllMiddleware(pattern: string): boolean {
  return pattern === "*" || pattern === "/*";
}

/**
 * The `core/embed` url rule, in one place: config validation (`ui-widgets`) and the web renderer
 * both call {@link embedUrlProblem}; the UI contract keeps a copy of {@link EMBED_URL_PATTERN}
 * that a contract test holds equal to this one. It is the URL parser's rule, not a hand-written host grammar. It has no
 * imports, so the browser bundle can load it (`@deck/schema/embed`). It also holds which embed
 * origins deck's Content-Security-Policy can name, and the pattern of origin settings.
 */

/**
 * The options schema's loose shape for a `core/embed` url, checked before the parser runs:
 * http(s), then a non-empty authority with no `@`, whitespace or backslash.
 */
export const EMBED_URL_PATTERN = "^https?://[^/?#@\\s\\\\]+(?:[/?#][^\\s\\\\]*)?$";
const EMBED_URL = new RegExp(EMBED_URL_PATTERN, "u");

const NOT_A_URL = "Its url is not an absolute http(s) URL with a host.";

/**
 * Why a `core/embed` url cannot be framed, or `null`. It must match {@link EMBED_URL_PATTERN},
 * then parse as a URL (WHATWG: an invalid IPv4 or IPv6 host, a port past 65535, and so on, do
 * not), with protocol http or https, a non-empty host, and no username or password.
 */
export function embedUrlProblem(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048 || !EMBED_URL.test(url)) return NOT_A_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NOT_A_URL;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") return NOT_A_URL;
  if (parsed.username !== "" || parsed.password !== "") return "Its url may not carry user:password@.";
  return null;
}

/**
 * An origin a Content-Security-Policy source expression names exactly: http(s), a host name or
 * IPv4 address of letters, digits, `.` and `-`, and an optional port. An IPv6 literal, or a host
 * with `_`, cannot be written as one, so a page under deck's policy can never frame it.
 */
export const FRAME_ORIGIN_PATTERN = "^https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$";
const FRAME_ORIGIN = new RegExp(FRAME_ORIGIN_PATTERN);

/**
 * The origin a `core/embed` url frames, as deck's policy names it (`frame-src`); `null` for a
 * url {@link embedUrlProblem} refuses, or whose origin no policy can name (`FRAME_ORIGIN_PATTERN`).
 */
export function frameOriginOf(url: unknown): string | null {
  if (embedUrlProblem(url) !== null) return null;
  const { origin } = new URL(url as string);
  return FRAME_ORIGIN.test(origin) ? origin : null;
}

/**
 * An origin the operator lists in `ui.frameAncestors` or `ui.frameSources`: http(s), a host that
 * may start with a `*.` wildcard, an optional port, no path. The config schema holds the same
 * pattern (a test keeps them equal).
 */
export const ORIGIN_SETTING_PATTERN = "^https?://(\\*\\.)?[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?$";

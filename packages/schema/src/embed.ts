/**
 * The `core/embed` url rule, in one place: config validation (`ui-widgets`) and the web renderer
 * both call {@link embedUrlProblem}; the UI contract keeps a copy of {@link EMBED_URL_PATTERN}
 * that a contract test holds equal to this one. It is the URL parser's rule, not a hand-written host grammar. It has no
 * imports, so the browser bundle can load it (`@deck/schema/embed`).
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

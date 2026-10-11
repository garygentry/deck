/**
 * The language hint a file read carries: a highlight.js token chosen by basename or extension.
 * Pure and dependency-free, so the web half's tests can check it against the kernel
 * highlighter's own table (every hint here must name the language the highlighter picks).
 */

/** Hint tokens chosen by full (lowercased) basename. */
export const LANGUAGE_HINT_BY_NAME: Readonly<Record<string, string>> = Object.freeze({
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "plaintext",
});

/** Hint tokens chosen by (lowercased) extension. */
export const LANGUAGE_HINT_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  env: "bash",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  html: "xml",
  sql: "sql",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  nginx: "nginx",
  service: "ini",
  properties: "properties",
  hcl: "hcl",
  tf: "hcl",
});

/**
 * Map a file path to a highlight.js language token by extension/basename, or `undefined`
 * for an unknown type (⇒ plaintext). Lowercased; matches common config/doc
 * types. This is a hint only — the web may fall back to plaintext if the language is not
 * registered in its highlight.js bundle.
 */
export function languageForPath(relPath: string): string | undefined {
  const base = (relPath.split("/").pop() ?? "").toLowerCase();
  if (Object.hasOwn(LANGUAGE_HINT_BY_NAME, base)) return LANGUAGE_HINT_BY_NAME[base];
  const dot = base.lastIndexOf(".");
  // Like path.extname: a leading dot alone (`.env`) is a name, not an extension.
  const ext = dot <= 0 ? "" : base.slice(dot + 1);
  return Object.hasOwn(LANGUAGE_HINT_BY_EXT, ext) ? LANGUAGE_HINT_BY_EXT[ext] : undefined;
}

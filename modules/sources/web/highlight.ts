/**
 * Syntax-highlighting wrapper over `highlight.js`, shared by two surfaces (tech-spec §3.8):
 * the markdown fenced-code hook (`markdown.ts`, §5) and the Configs `FileViewer` (07). One
 * highlight.js instance, one language-selection table, one plaintext fallback that **never
 * throws** on an unknown or unregistered language.
 *
 * The output of {@link highlightCode} is HTML-escaped highlight.js markup (or escaped
 * plaintext on fallback) — safe to embed in a `<code>` element. For markdown it is further
 * passed through the DOMPurify sanitize boundary (`markdown.ts` §5.2).
 */

// Import the highlight.js CORE build and register ONLY the languages this feature can select
// (the LANGUAGE_BY_* tables below). The default `highlight.js` entry bundles ~190 languages —
// hundreds of KB we never use. Core + a curated set keeps the bundle small; any token we don't
// register (e.g. `hcl`, which has no core language module) is simply not found by
// `hljs.getLanguage` and falls back to escaped plaintext — the same path as an unknown fence.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import plaintext from "highlight.js/lib/languages/plaintext";
import properties from "highlight.js/lib/languages/properties";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Register under the exact tokens the LANGUAGE_BY_* tables resolve to. highlight.js keys its
// own aliases (e.g. `js`→javascript) internally, but we always look up the resolved token.
for (const [name, language] of [
  ["bash", bash],
  ["dockerfile", dockerfile],
  ["go", go],
  ["ini", ini],
  ["javascript", javascript],
  ["json", json],
  ["makefile", makefile],
  ["markdown", markdown],
  ["nginx", nginx],
  ["plaintext", plaintext],
  ["properties", properties],
  ["python", python],
  ["ruby", ruby],
  ["rust", rust],
  ["sql", sql],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
] as const) {
  hljs.registerLanguage(name, language);
}

/** HTML-escape plaintext for the no-highlight fallback (never emit raw `<`/`&`/`"`). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** highlight.js language tokens chosen by full (lowercased) basename. */
const LANGUAGE_BY_NAME: Readonly<Record<string, string>> = Object.freeze({
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "plaintext",
  ".dockerignore": "plaintext",
});

/** highlight.js language tokens chosen by (lowercased) extension. Mirrors the server hint
 *  table (`modules/sources/server/tree.ts` `languageForPath`) so both surfaces agree. */
const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
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
 * Resolve a highlight.js language token from a file name or bare extension, or `undefined`
 * for an unknown type (⇒ plaintext). Accepts either a full path/basename (`config/app.yaml`,
 * `Dockerfile`) or a bare extension (`yaml`, `.yaml`). Pure; exported for the FileViewer (013)
 * and tests.
 */
export function languageForName(name: string): string | undefined {
  const base = name.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base in LANGUAGE_BY_NAME) return LANGUAGE_BY_NAME[base];
  const dot = base.lastIndexOf(".");
  // A bare extension arrives with no dot (`yaml`) or a leading dot (`.yaml`); a filename
  // uses the segment after its final dot.
  const ext = dot === -1 ? base : base.slice(dot + 1);
  return LANGUAGE_BY_EXT[ext];
}

/** Result of a highlight attempt: escaped HTML plus the language actually applied (or null). */
export interface HighlightResult {
  /** HTML-escaped highlight.js markup, or escaped plaintext when no language applied. */
  readonly value: string;
  /** The highlight.js language token applied, or `null` for the plaintext fallback. */
  readonly language: string | null;
}

/**
 * Highlight `code` under a highlight.js language token. `language` may be a fence info string
 * (`ts`), a resolved token, or `undefined`. An unknown or unregistered language — or any
 * highlight.js throw — falls back to escaped plaintext; this function **never throws**.
 */
export function highlightCode(code: string, language: string | undefined): HighlightResult {
  const token = language?.trim().toLowerCase();
  if (token && hljs.getLanguage(token)) {
    try {
      const { value } = hljs.highlight(code, { language: token, ignoreIllegals: true });
      return { value, language: token };
    } catch {
      // A registered language can still throw on pathological input — fall through.
    }
  }
  return { value: escapeHtml(code), language: null };
}

/**
 * Highlight `code` for a named file — resolves the language from the file name/extension
 * (`languageForName`) then highlights. Convenience for the Configs `FileViewer` (013), which
 * highlights by extension. Never throws.
 */
export function highlightFile(code: string, name: string): HighlightResult {
  return highlightCode(code, languageForName(name));
}

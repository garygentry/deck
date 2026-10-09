/**
 * The page's import map: the bare specifiers a runtime module's `web.js` may import, each
 * mapped to the host's own module, so a module shares the shell's React and `@deck/sdk`
 * rather than bundling its own (vite.config.ts builds each as an entry chunk and writes the map in).
 */

/** Each shared specifier and its source, relative to the web app's root. */
export const SHARED_MODULES: Readonly<Record<string, string>> = {
  react: "src/sdk/shared/react.js",
  "react-dom": "src/sdk/shared/react-dom.js",
  "react/jsx-runtime": "src/sdk/shared/jsx-runtime.js",
  "@deck/sdk": "src/sdk/index.ts",
};

/**
 * `html` with an import map of `imports` written in right after `<head>`, ahead of every
 * module script and `modulepreload` link (a map after either is ignored). Vite's own HTML
 * transform may then move the map, but only to just before the first module script, so it
 * stays ahead of them; CI checks the built page (scripts/check-web-build.mjs). The map's
 * JSON escapes `<`, so no specifier or URL can close the script element.
 */
export function injectImportMap(html: string, imports: Readonly<Record<string, string>>): string {
  const json = JSON.stringify({ imports }).replace(/</g, "\\u003c");
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head === null) throw new Error("index.html has no <head> for the import map");
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}\n    <script type="importmap">${json}</script>${html.slice(at)}`;
}

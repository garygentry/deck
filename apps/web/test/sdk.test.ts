import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { IMPORT_MAP_SPECIFIERS } from "@deck/sdk/lint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { injectImportMap, SHARED_MODULES } from "../src/sdk/import-map.js";

/**
 * `@deck/sdk` and the import map: the module API a runtime module's web half imports, which
 * shares deck's own React and never exposes the vendored shadcn/Radix primitives.
 */

const TEST_FILE_URL = import.meta.url;
const fromWeb = (path: string) => fileURLToPath(new URL(`../${path}`, TEST_FILE_URL));
const require = createRequire(TEST_FILE_URL);

/** The SDK's runtime exports: adding one makes it part of the module API, so it is listed here on purpose. */
const SDK_EXPORTS = [
  "Callout", "CardGrid", "CodeBlock", "DECK_API_VERSION", "DataTable", "Disclosure", "EmptyState", "ErrorState",
  "ExternalLink", "FragmentBoundary", "FreshnessBadge", "HealthPill", "Icon", "KeyValue", "KeyValueList", "LinkTile",
  "List", "ListGroup", "ListItem", "LoadingState", "Meter", "PageHeader", "Prose", "RelativeTime", "SafeRouteLink",
  "Section", "StatGrid", "StatTile", "StatusBadge", "TONES", "TONE_ICON", "VisuallyHidden", "defineStatusMap",
  "defineWebModule", "formatAge", "formatRelative", "formatTimestamp", "satisfiesDeckApi", "statusTone", "useConfig",
  "useProvider", "useProviders", "useUiManifest",
];

describe("@deck/sdk", () => {
  it("exports exactly the curated module API", async () => {
    const sdk = await import("../src/sdk/index.js");
    expect(Object.keys(sdk).sort()).toEqual([...SDK_EXPORTS].sort());
  });

  it("re-exports none of the shadcn/Radix primitives, nor cn", async () => {
    const sdk = await import("../src/sdk/index.js");
    const primitives = new Set<string>(["cn"]);
    for (const file of readdirSync(fromWeb("src/ui/primitives"))) {
      for (const name of Object.keys(await import(/* @vite-ignore */ fromWeb(`src/ui/primitives/${file}`)))) primitives.add(name);
    }
    expect(primitives.size).toBeGreaterThan(50);
    expect(Object.keys(sdk).filter((name) => primitives.has(name))).toEqual([]);
    // Nor does it import them by path.
    const specifiers = [...readFileSync(fromWeb("src/sdk/index.ts"), "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(specifiers)).toEqual(new Set(["../data/index.js", "@/ui", "@deck/module-sdk"]));
  });

  it("is typed for module authors by @deck/sdk's index.d.ts, which declares every one of these values", async () => {
    const sdk = await import("../src/sdk/index.js");
    const types = ts.createSourceFile("index.d.ts", readFileSync(fromWeb("../../packages/sdk/index.d.ts"), "utf8"), ts.ScriptTarget.Latest);
    const exported = types.statements.flatMap((statement) =>
      ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text)
        : [],
    );
    // The bundle also re-exports types by name (ColumnDef, Tone, …): every runtime value is declared.
    expect(Object.keys(sdk).filter((name) => !exported.includes(name))).toEqual([]);
  });

  it("shares each React entry point whole: every export of the package, by name, plus its default", async () => {
    for (const [specifier, source] of Object.entries(SHARED_MODULES)) {
      if (specifier === "@deck/sdk") continue;
      const shared = (await import(/* @vite-ignore */ fromWeb(source))) as Record<string, unknown>;
      const real = require(specifier) as Record<string, unknown>;
      const names = Object.keys(shared).filter((name) => name !== "default");
      expect(names.sort(), specifier).toEqual(Object.keys(real).sort());
      for (const name of names) expect(shared[name], `${specifier} ${name}`).toBe(real[name]);
      if (specifier !== "react/jsx-runtime") expect(shared.default, specifier).toBe(real);
    }
  });
});

describe("injectImportMap", () => {
  const IMPORTS = { react: "/assets/sdk-react-1.js", "@deck/sdk": "/assets/sdk-index-2.js" };
  /** A built index.html as Vite writes it: entry script and module preloads in <head>. */
  const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script>/* pre-paint */</script>
    <link rel="modulepreload" crossorigin href="/assets/jsx-runtime-a.js">
    <script type="module" crossorigin src="/assets/index-b.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-c.css">
  </head>
  <body><div id="app"></div><script type="module" src="/late.js"></script></body>
</html>`;

  it("writes the map ahead of every module script and modulepreload link", () => {
    const html = injectImportMap(BUILT, IMPORTS);
    const map = html.indexOf('<script type="importmap">');
    expect(map).toBeGreaterThan(-1);
    const modules = [...html.matchAll(/<script type="module"|<link rel="modulepreload"/g)].map((match) => match.index!);
    expect(modules).toHaveLength(3);
    for (const index of modules) expect(map).toBeLessThan(index);
    expect(html.match(/type="importmap"/g)).toHaveLength(1);
    const json = /<script type="importmap">(.*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(json)).toEqual({ imports: IMPORTS });
  });

  it("keeps the map's JSON inside its script element", () => {
    const html = injectImportMap("<html><head></head></html>", { "</script><script>alert(1)//": "/x.js" });
    expect(html).not.toContain("</script><script>alert");
    const json = /<script type="importmap">(.*?)<\/script>/.exec(html)![1]!;
    expect(Object.keys((JSON.parse(json) as { imports: object }).imports)).toEqual(["</script><script>alert(1)//"]);
  });

  it("maps exactly react, react-dom, react/jsx-runtime and @deck/sdk: what deck-module lint lets a built web.js import", () => {
    expect(Object.keys(SHARED_MODULES).sort()).toEqual(["@deck/sdk", "react", "react-dom", "react/jsx-runtime"]);
    expect(Object.keys(SHARED_MODULES).sort()).toEqual([...IMPORT_MAP_SPECIFIERS].sort());
  });

  it("refuses a page without a head", () => {
    expect(() => injectImportMap("<p>no head</p>", IMPORTS)).toThrow(/no <head>/);
  });
});

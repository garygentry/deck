import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const SERVER = /^@deck\/server(?:\/|$)/;

/** A statement's text as one line, without its trailing semicolon. */
const oneLine = (node: ts.Node, file: ts.SourceFile) => node.getText(file).replace(/;\s*$/, "").replace(/\s+/g, " ");

/** Whether every binding of a named import or export clause is marked `type`. */
const allTypeOnly = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) =>
  elements.length > 0 && elements.every((element) => element.isTypeOnly);

/**
 * Offending `@deck/server` imports in one file's source: anything but a type-only import. The
 * source is parsed, so comments, strings and statements without semicolons cannot mislead it.
 */
export function runtimeServerImports(source: string): string[] {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && SERVER.test(node.moduleSpecifier.text)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause === undefined) {
        offenders.push(`${specifier}: side-effect import`);
      } else {
        const named = clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
        const typeOnly = clause.isTypeOnly || (clause.name === undefined && named !== null && allTypeOnly(named));
        if (!typeOnly) offenders.push(`${specifier}: ${oneLine(node, file)}`);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) && SERVER.test(node.moduleSpecifier.text)) {
      const named = node.exportClause !== undefined && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      if (!node.isTypeOnly && !(named !== null && allTypeOnly(named))) offenders.push(`${node.moduleSpecifier.text}: ${oneLine(node, file)}`);
    } else if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0]) && SERVER.test(node.arguments[0].text)
    ) {
      // A type position (`typeof import("…")`) is an import type node, not a call.
      offenders.push(`${node.arguments[0].text}: dynamic import`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
}

describe("imports: the server package is types only", () => {
  it("imports @deck/server and its subpaths only with `import type`, so no server code reaches the bundle", () => {
    const files = walk(join(webRoot, "src")).filter((path) => /\.(ts|tsx)$/.test(path));
    const offenders = files.flatMap((path) =>
      runtimeServerImports(readFileSync(path, "utf8")).map((offence) => `${relative(webRoot, path)}: ${offence}`),
    );
    expect(offenders).toEqual([]);
    // The check has something to hold: the web takes wire types from the server barrel and the
    // portal feature takes its section types from the module.
    expect(files.some((path) => /from "@deck\/server"/.test(readFileSync(path, "utf8")))).toBe(true);
    expect(files.some((path) => /@deck\/server\/portal/.test(readFileSync(path, "utf8")))).toBe(true);
  });

  it.each([
    ['import type { Group } from "@deck/server/portal";', []],
    ['import type {\n  Group,\n  ServiceItem,\n} from "@deck/server/portal";', []],
    ['import { type Group, type LinkItem } from "@deck/server/portal";', []],
    ['export type { Group } from "@deck/server/portal";', []],
    ['type G = typeof import("@deck/server/portal");', []],
    ['import { Group } from "@deck/server/portal";', ['@deck/server/portal: import { Group } from "@deck/server/portal"']],
    ['import { type Group, orderedGroups } from "@deck/server/portal";', ['@deck/server/portal: import { type Group, orderedGroups } from "@deck/server/portal"']],
    ['import * as portal from "@deck/server/portal";', ['@deck/server/portal: import * as portal from "@deck/server/portal"']],
    ['export { Group } from "@deck/server/portal";', ['@deck/server/portal: export { Group } from "@deck/server/portal"']],
    ['import "@deck/server/portal";', ["@deck/server/portal: side-effect import"]],
    ['const m = await import("@deck/server/portal");', ["@deck/server/portal: dynamic import"]],
    ['import type { DeckConfig } from "@deck/server";', []],
    ['import { type DeckConfig, type ProviderEnvelope } from "@deck/server";', []],
    ['import { POLL_DEFAULTS } from "@deck/server";', ['@deck/server: import { POLL_DEFAULTS } from "@deck/server"']],
    ['import { type DeckConfig, validateActionParams } from "@deck/server";', ['@deck/server: import { type DeckConfig, validateActionParams } from "@deck/server"']],
    ['export * from "@deck/server";', ['@deck/server: export * from "@deck/server"']],
    ['import "@deck/server";', ["@deck/server: side-effect import"]],
    ['const m = await import("@deck/server");', ["@deck/server: dynamic import"]],
    ['/** Links (we import the page module). */\nimport type { SourceTreeNode } from "@deck/server";', []],
    ['import type { DeckConfig } from "@deck/server"\nimport { POLL_DEFAULTS } from "@deck/server"\n', ['@deck/server: import { POLL_DEFAULTS } from "@deck/server"']],
    ['import type { DeckConfig } from "@deck/server"\nimport { orderedGroups } from "@deck/server/portal"', ['@deck/server/portal: import { orderedGroups } from "@deck/server/portal"']],
    ['import type { Foo } from "./foo"\nimport { POLL_DEFAULTS } from "@deck/server"\n', ['@deck/server: import { POLL_DEFAULTS } from "@deck/server"']],
    ['const text = \'import { POLL_DEFAULTS } from "@deck/server";\';', []],
    ['import Server from "@deck/server";', ['@deck/server: import Server from "@deck/server"']],
    ['import { } from "@deck/server";', ['@deck/server: import { } from "@deck/server"']],
  ])("classifies %j", (source, expected) => {
    expect(runtimeServerImports(source)).toEqual(expected);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Every module a source file names: static imports and exports, and dynamic `import()`. */
function specifiers(source: string): string[] {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// A widget's `select` is evaluated on the server: the browser never loads the JMESPath engine,
// which only `@deck/schema/select` imports (the schema package's own test keeps it there).
it("never imports the select engine", () => {
  const offenders = walk(srcRoot)
    .filter((path) => /\.tsx?$/.test(path))
    .flatMap((path) =>
      specifiers(readFileSync(path, "utf8"))
        .filter((specifier) => /^(?:jmespath|@deck\/schema\/select)(?:\/|$)/.test(specifier))
        .map((specifier) => `${relative(srcRoot, path)}: ${specifier}`),
    );
  expect(offenders).toEqual([]);
});

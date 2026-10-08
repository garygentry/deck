import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const srcRoot = join(webRoot, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * The modules a source file loads at runtime: static imports and re-exports that are not
 * type-only, dynamic `import()` and `require()`. Type-only imports are erased, so they load nothing.
 */
export function runtimeSpecifiers(source: string): string[] {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && named !== null && named.length > 0 && named.every((element) => element.isTypeOnly)));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Workspace packages by name, with their directory and `exports` map. */
const workspace = new Map(
  ["packages", "apps"].flatMap((group) =>
    readdirSync(join(repoRoot, group)).flatMap((name) => {
      const manifest = join(repoRoot, group, name, "package.json");
      if (!existsSync(manifest)) return [];
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; exports?: Record<string, string> };
      return [[pkg.name, { dir: join(repoRoot, group, name), exports: pkg.exports ?? {} }] as const];
    }),
  ),
);

/** The file a workspace specifier (`@deck/schema/select`) loads, through its package's `exports`. */
function resolveWorkspace(specifier: string): string | undefined {
  const name = specifier.split("/").slice(0, 2).join("/");
  const pkg = workspace.get(name);
  if (pkg === undefined) return undefined;
  const subpath = `.${specifier.slice(name.length)}`;
  for (const [pattern, target] of Object.entries(pkg.exports)) {
    if (pattern === subpath) return join(pkg.dir, target);
    if (pattern.endsWith("/*") && subpath.startsWith(pattern.slice(0, -1))) return join(pkg.dir, target.replace("*", subpath.slice(pattern.length - 1)));
  }
  return undefined;
}

/** A relative specifier as a file: `.js` written for a `.ts` source, or a directory index. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** Every file the web's sources load at runtime, across the workspace, with a path to each. */
function runtimeGraph(): Map<string, string> {
  const reached = new Map<string, string>();
  const queue = walk(srcRoot).filter((path) => /\.tsx?$/.test(path)).map((path) => [path, relative(repoRoot, path)] as const);
  for (const [path] of queue) reached.set(path, relative(repoRoot, path));
  while (queue.length > 0) {
    const [file, via] = queue.shift()!;
    if (!/\.(tsx?|js)$/.test(file)) continue;
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const target = specifier.startsWith(".") ? resolveRelative(file, specifier) : resolveWorkspace(specifier);
      const key = target ?? `npm:${specifier}`;
      if (reached.has(key)) continue;
      const chain = `${via} → ${target === undefined ? specifier : relative(repoRoot, target)}`;
      reached.set(key, chain);
      if (target !== undefined && !target.includes("node_modules")) queue.push([target, chain]);
    }
  }
  return reached;
}

// A widget's `select` is evaluated on the server: the browser never loads the JMESPath engine
// (`@deck/schema/select` and the vendored engine it imports), at any depth.
describe("the web bundle", () => {
  it("never loads the select engine, directly or through a workspace package", () => {
    const graph = runtimeGraph();
    const engine = [join(repoRoot, "packages/schema/src/select.ts"), join(repoRoot, "packages/schema/src/select/jmespath.js")];
    const offenders = [...graph].filter(([key]) => engine.includes(key) || /^npm:(?:@jmespath-community\/)?jmespath(?:\/|$)/.test(key)).map(([, chain]) => chain);
    expect(offenders).toEqual([]);
    // The walk does reach into the workspace packages.
    expect(graph.has(join(repoRoot, "packages/contract/src/modules/core.ts"))).toBe(true);
    expect(graph.has(join(repoRoot, "packages/module-sdk/src/index.ts"))).toBe(true);
  });

  it("would catch a transitive import", () => {
    const source = 'import type { A } from "x";\nimport { b } from "@deck/schema/select";\nexport * from "./c.js";\nconst d = await import("e");\nrequire("f");';
    expect(runtimeSpecifiers(source)).toEqual(["@deck/schema/select", "./c.js", "e", "f"]);
    expect(resolveWorkspace("@deck/schema/select")).toBe(join(repoRoot, "packages/schema/src/select.ts"));
  });
});

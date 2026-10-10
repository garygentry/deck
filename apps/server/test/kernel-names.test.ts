import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";

const SRC = resolve(__dirname, "../src");

/**
 * Kernel files that must name no feature or provider kind: boot, the app skeleton (and the
 * rest of `server/`), and the config-to-provider mapping and registry. Everything a feature
 * or kind needs reaches them through the module host.
 */
const KERNEL_FILES = [
  ...readdirSync(join(SRC, "server")).filter((name) => name.endsWith(".ts")).map((name) => `server/${name}`),
  "providers/index.ts",
  "providers/registry.ts",
];

const camel = (id: string) => id.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

/** Every built-in module id and provider kind, as written and in camelCase. */
const NAMES: ReadonlySet<string> = new Set(
  BUILTIN_MODULES.flatMap(({ manifest }) => [manifest.id, ...(manifest.providerKinds ?? []).map((decl) => decl.kind)])
    .flatMap((name) => [name, camel(name)]),
);

/**
 * The identifiers and string-literal texts in `source` that equal a name in `names`. The
 * source is parsed, so comments never count; a string counts when it equals a name or names
 * one as a path segment (`/api/m/drift`).
 */
export function namedFeatures(source: string, names: ReadonlySet<string>): string[] {
  const file = ts.createSourceFile("kernel.ts", source, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (names.has(node.text)) found.add(node.text);
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const part of node.text.split(/[^A-Za-z0-9-]+/)) if (names.has(part)) found.add(part);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found].sort();
}

describe("the kernel names no feature or provider kind", () => {
  it("knows the built-in names it guards against", () => {
    for (const name of ["drift", "llm-usage", "llmUsage", "snapshot", "http-health", "httpHealth", "sources", "actions"]) {
      expect(NAMES.has(name), name).toBe(true);
    }
  });

  it.each(KERNEL_FILES)("%s", (path) => {
    expect(namedFeatures(readFileSync(join(SRC, path), "utf8"), NAMES)).toEqual([]);
  });

  it("finds names in code and strings but not in comments (guard self-test)", () => {
    const source = [
      "// docker stop: a comment never counts",
      "/** see the drift page */",
      'import { driftModule } from "../drift/module.js";',
      'const route = `/api/m/${id}/llm-usage`;',
      "const key = config.llmUsage;",
    ].join("\n");
    expect(namedFeatures(source, NAMES)).toEqual(["drift", "llm-usage", "llmUsage"]);
  });
});

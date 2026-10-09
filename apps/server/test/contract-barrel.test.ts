import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isKernelPath } from "../../../scripts/kernel-touch.js";

const REPO_ROOT = resolve(__dirname, "../../..");
const BARREL = resolve(REPO_ROOT, "apps/server/src/contract/index.ts");

/** Workspace packages the barrel may re-export from, by specifier, to their entry file. */
const PACKAGE_ENTRIES: Readonly<Record<string, string>> = {
  "@deck/contract": "packages/contract/src/index.ts",
  "@deck/module-sdk": "packages/module-sdk/src/index.ts",
};

/**
 * The repo-relative file each `export … from`, and each `import` (which a later `export { … }`
 * can re-export), in `source` (at `file`) names.
 */
function reExportTargets(source: string, file: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const targets: string[] = [];
  for (const statement of parsed.statements) {
    const from = ts.isExportDeclaration(statement) || ts.isImportDeclaration(statement) ? statement.moduleSpecifier : undefined;
    if (from === undefined || !ts.isStringLiteral(from)) continue;
    const specifier = from.text;
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      targets.push(relative(REPO_ROOT, target));
    } else {
      targets.push(PACKAGE_ENTRIES[specifier] ?? `unknown package:${specifier}`);
    }
  }
  return targets;
}

describe("the @deck/server barrel (contract/index.ts)", () => {
  it("re-exports kernel types only: every source it names is a kernel file", () => {
    const targets = reExportTargets(readFileSync(BARREL, "utf8"), BARREL);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => !isKernelPath(target))).toEqual([]);
  });

  it("flags a feature imported and then re-exported (guard self-test)", () => {
    const feature = 'import type { LlmUsageResponse } from "../../../../modules/llm-usage/server/types.js";\nexport type { LlmUsageResponse };';
    expect(reExportTargets(feature, BARREL).filter((target) => !isKernelPath(target))).toEqual(["modules/llm-usage/server/types.ts"]);
  });

  it("flags a feature re-export (guard self-test)", () => {
    const feature = 'export type { Action } from "../../../../modules/actions/server/config.generated.js";\nexport type { X } from "@deck/drift";';
    expect(reExportTargets(feature, BARREL).filter((target) => !isKernelPath(target))).toEqual([
      "modules/actions/server/config.generated.ts",
      "unknown package:@deck/drift",
    ]);
  });
});

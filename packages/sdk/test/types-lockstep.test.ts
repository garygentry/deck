import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain script with no declarations of its own.
import { EXTERNAL, generateTypes } from "../scripts/build-types.mjs";

/**
 * index.d.ts, the types a module author's web half checks against, is generated from deck's
 * own SDK entry, so it cannot drift from what the page's import map serves.
 */

const committed = readFileSync(new URL("../index.d.ts", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

describe("@deck/sdk types", () => {
  it("are byte-identical to generation from the web SDK", async () => {
    expect(await generateTypes()).toBe(committed);
  }, 120_000);

  it("import only React and the packages @deck/sdk depends on", () => {
    const source = ts.createSourceFile("index.d.ts", committed, ts.ScriptTarget.Latest);
    const imported = new Set(
      source.statements.flatMap((statement) =>
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? [statement.moduleSpecifier.text]
          : [],
      ),
    );
    expect([...imported].sort()).toEqual([...(EXTERNAL as string[])].sort());
    for (const name of EXTERNAL as string[]) {
      if (name === "react") expect(manifest.peerDependencies["@types/react"]).toBeDefined();
      else expect(manifest.dependencies[name], name).toBeDefined();
    }
  });
});

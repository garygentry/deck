import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "json-schema-to-typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Built-in modules (repo-relative paths) whose `modules.<id>` section type is generated from the module's own schema. */
const MODULE_SCHEMAS = [
  { schema: "modules/actions/schema.json", output: "modules/actions/server/config.generated.ts" },
  { schema: "modules/llm-usage/schema.json", output: "modules/llm-usage/server/config.generated.ts" },
  { schema: "modules/portal/schema.json", output: "modules/portal/server/config.generated.ts" },
] as const;

type Schema = Parameters<typeof compile>[0];

/** Generate each module's section types without writing them, for codegen and drift checks alike. */
export async function generateModuleTypes(): Promise<Array<{ output: string; source: string }>> {
  return Promise.all(MODULE_SCHEMAS.map(async ({ schema, output }) => {
    const parsed = JSON.parse(await readFile(resolve(repoRoot, schema), "utf8")) as Schema;
    const source = await compile(parsed, String(parsed.title), {
      additionalProperties: false,
      strictIndexSignatures: true,
      format: false,
      bannerComment: `/* GENERATED from ${schema} by apps/server/src/scripts/gen-module-types.ts — do not edit; run \`pnpm gen:module-types\`. */`,
    });
    return { output, source };
  }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  for (const { output, source } of await generateModuleTypes()) {
    await writeFile(resolve(repoRoot, output), source);
  }
}

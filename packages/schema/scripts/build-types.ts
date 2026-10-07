import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "json-schema-to-typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const generatedFiles = {
  config: {
    schema: "schema/deck.schema.json",
    output: "src/types.config.generated.ts",
    rootName: "DeckConfigDocument",
  },
  snapshot: {
    schema: "schema/snapshot.schema.json",
    output: "src/types.snapshot.generated.ts",
    rootName: "SnapshotDocument",
  },
} as const;

type Schema = Parameters<typeof compile>[0];

async function generateFile(
  schemaPath: string,
  rootName: string,
): Promise<string> {
  const schema = JSON.parse(
    await readFile(resolve(packageRoot, schemaPath), "utf8"),
  ) as Schema;

  return compile(schema, rootName, {
    additionalProperties: false,
    strictIndexSignatures: true,
    format: false,
    bannerComment: `/* GENERATED from ${schemaPath} — do not edit; run pnpm types:build */`,
  });
}

export interface GeneratedTypes {
  config: string;
  snapshot: string;
}

/** Generate both modules without writing them, for codegen and drift checks alike. */
export async function generateTypes(): Promise<GeneratedTypes> {
  return {
    config: await generateFile(
      generatedFiles.config.schema,
      generatedFiles.config.rootName,
    ),
    snapshot: await generateFile(
      generatedFiles.snapshot.schema,
      generatedFiles.snapshot.rootName,
    ),
  };
}

async function writeGeneratedTypes(): Promise<void> {
  const generated = await generateTypes();

  await Promise.all([
    writeFile(resolve(packageRoot, generatedFiles.config.output), generated.config),
    writeFile(
      resolve(packageRoot, generatedFiles.snapshot.output),
      generated.snapshot,
    ),
  ]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await writeGeneratedTypes();
}

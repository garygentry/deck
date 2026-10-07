import { readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEADER =
  "/* GENERATED from provider index.ts files by src/scripts/gen-providers.ts — do not edit; run `pnpm gen:providers`. */";

function helperName(folder: string): string {
  return `register${folder
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("")}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function main(): Promise<void> {
  const providersDir = resolve(dirname(fileURLToPath(import.meta.url)), "../providers");
  const entries = await readdir(providersDir, { withFileTypes: true });
  const folders: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if ((await stat(resolve(providersDir, entry.name, "index.ts"))).isFile()) {
        folders.push(entry.name);
      }
    } catch {
      // A directory is a provider only when it contains index.ts.
    }
  }

  folders.sort(compareText);
  const providers = folders
    .map((kind) => ({ kind, order: 0 }))
    .sort((a, b) => a.order - b.order || compareText(a.kind, b.kind));
  const imports = folders.map(
    (folder) => `import { ${helperName(folder)} } from "./${folder}/index.js";`,
  );
  const helpers = folders.map(helperName);
  const output = [
    HEADER,
    ...imports,
    "",
    "/** One discovered provider folder's registration surface. */",
    "export interface GeneratedProviderEntry {",
    "  kind: string;",
    "  order: number;",
    "}",
    "",
    "/** Provider kinds discovered at codegen time, sorted by (order, kind). */",
    "export const GENERATED_PROVIDERS: readonly GeneratedProviderEntry[] = [",
    ...providers.map(({ kind, order }) => `  { kind: "${kind}", order: ${order} },`),
    "];",
    "",
    "/** Typed registration helpers exposed by the discovered provider folders. */",
    `export { ${helpers.join(", ")} };`,
    "",
  ].join("\n");

  await writeFile(resolve(providersDir, "generated.ts"), output, "utf8");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

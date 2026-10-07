import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const SHIPPED_DIRECTORIES = ["schema", "src", "docs"] as const;

function filesUnder(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }

  return files;
}

/** Enumerate every regular file in the package's published files set. */
export function shippedFiles(packageRoot: string): string[] {
  return SHIPPED_DIRECTORIES.flatMap((directory) =>
    filesUnder(resolve(packageRoot, directory)),
  ).sort();
}

/** Yield lowercase whole tokens and the labels of dotted tokens from shipped files. */
export function* walkShippedTokens(
  packageRoot: string,
): Iterable<{ file: string; token: string }> {
  for (const path of shippedFiles(packageRoot)) {
    const file = relative(packageRoot, path);
    const tokens = readFileSync(path, "utf8").toLowerCase().split(/[^a-z0-9.-]+/);

    for (const token of tokens) {
      if (!token) continue;
      yield { file, token };

      if (token.includes(".")) {
        for (const label of token.split(".")) {
          if (label) yield { file, token: label };
        }
      }
    }
  }
}

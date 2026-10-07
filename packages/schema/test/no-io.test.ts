import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
const forbiddenNodeImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']node:(?:fs(?:\/promises)?|net|http|https|child_process)["']/;
const forbiddenNetworkApi = /\b(?:fetch\s*\(|XMLHttpRequest\b)/;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return files.flat();
}

test("the shipped library has no filesystem or network I/O", async () => {
  const files = (await sourceFiles(srcRoot)).filter((file) => {
    const path = relative(srcRoot, file);
    return path !== "fixtures" && !path.startsWith(`fixtures${sep}`);
  });

  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const path = relative(srcRoot, file);
    expect(source, `${path} imports a forbidden filesystem/network module`).not.toMatch(forbiddenNodeImport);
    expect(source, `${path} uses a forbidden network API`).not.toMatch(forbiddenNetworkApi);
  }
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { shippedFiles, walkShippedTokens } from "./negative-space/walk.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const denylistPath = resolve(packageRoot, "test/negative-space/denylist.sha256");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("the hashed denylist is non-empty and contains digests only", () => {
  const entries = readFileSync(denylistPath, "utf8").split(/\r?\n/).filter(Boolean);

  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) expect(entry).toMatch(/^[a-f0-9]{64}$/);
  expect(shippedFiles(packageRoot)).not.toContain(denylistPath);
});

test("no denylisted token or dotted label appears in shipped files", () => {
  const denylist = new Set(
    readFileSync(denylistPath, "utf8").split(/\r?\n/).filter(Boolean),
  );

  for (const { file, token } of walkShippedTokens(packageRoot)) {
    expect(denylist.has(sha256(token)), `${file}: denylisted token ${token}`).toBe(false);
  }
});

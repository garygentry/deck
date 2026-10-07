import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const denylistPath = resolve(packageRoot, "test/negative-space/denylist.sha256");

const digests = process.argv
  .slice(2)
  .map((value) => value.toLowerCase())
  .filter((value) => value.length >= 3)
  .map((value) => createHash("sha256").update(value).digest("hex"));

if (digests.length > 0) {
  await appendFile(denylistPath, `${digests.join("\n")}\n`, "utf8");
}

/**
 * Writes schema/remote-describe.schema.json from the config schema's descriptors
 * (src/remote-describe.ts). Run after changing either: `pnpm describe:build`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { remoteDescribeSchema } from "../src/remote-describe.js";

const target = fileURLToPath(new URL("../schema/remote-describe.schema.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(remoteDescribeSchema(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  CREDENTIAL_KEY_NAMES,
  FINDING_CATALOG,
  FINDING_CODES,
  KNOWN_PROVIDER_KINDS,
  SECRET_REF_PATTERN,
} from "../src/index.js";
import { IDENTITY, OWNERSHIP } from "../src/ownership.js";

const contract = readFileSync(
  fileURLToPath(new URL("../docs/CONTRACT.md", import.meta.url)),
  "utf8",
);

const headings = [
  "Schema files & consumption",
  "Layering: base + overlay",
  "Recommended loader call order",
  "The finding model",
  "Two-tier consumer model",
  "Finding codes",
  "Provider kinds",
  "Secrets",
  "Minimal valid documents",
  "Versioning policy",
  "Compatibility note",
] as const;

const libraryOnly = new Set([
  "HOST_DUPLICATE", "SERVICE_DUPLICATE", "ID_DUPLICATE",
  "REF_HOST_UNRESOLVED", "REF_SERVICE_UNRESOLVED",
  "LAYER_OVERLAY_KEY_IN_BASE", "LAYER_BASE_KEY_IN_OVERLAY", "OVERLAY_DANGLING_REF",
  "PROVIDER_KIND_UNKNOWN", "SECRET_VALUE_SUSPECTED", "LLM_USAGE_INVALID",
  "SNAPSHOT_HOST_DUPLICATE", "SNAPSHOT_SERVICE_DUPLICATE", "DRIFT_ID_DUPLICATE",
  "SNAPSHOT_HOST_UNDECLARED", "SNAPSHOT_SERVICE_UNDECLARED",
  "DRIFT_LOCATION_UNRESOLVED", "HOST_NOT_COLLECTED",
]);

test("contains every required heading in order and ends with compatibility note", () => {
  let cursor = -1;
  for (const heading of headings) {
    const index = contract.indexOf(`## ${heading}`);
    expect(index, heading).toBeGreaterThan(cursor);
    cursor = index;
  }
  expect(contract.slice(cursor).match(/^## /gm)).toHaveLength(1);
});

test("contains every finding code with its catalogued severity", () => {
  for (const code of FINDING_CODES) {
    expect(contract).toContain(`| \`${code}\` | \`${FINDING_CATALOG[code].severity}\` |`);
  }
});

test("partitions schema-level and library-only finding codes", () => {
  const schemaStart = contract.indexOf("### Schema-level codes");
  const start = contract.indexOf("### Library-only semantic rules");
  const end = contract.indexOf("\n## Provider kinds", start);
  const schemaSection = contract.slice(schemaStart, start);
  const semanticSection = contract.slice(start, end);
  for (const code of FINDING_CODES) {
    expect(semanticSection.includes(`\`${code}\``), code).toBe(libraryOnly.has(code));
    expect(schemaSection.includes(`\`${code}\``), code).toBe(!libraryOnly.has(code));
  }
});

test("contains every known provider kind", () => {
  for (const kind of KNOWN_PROVIDER_KINDS) expect(contract).toContain(`\`${kind}\``);
});

test("contains every ownership and identity row", () => {
  for (const [path, owner] of Object.entries(OWNERSHIP)) {
    expect(contract).toContain(`| \`${path}\` | \`${owner}\` |`);
  }
  for (const [collection, identity] of Object.entries(IDENTITY)) {
    expect(contract).toContain(`| \`${collection}\` | \`${JSON.stringify(identity)}\` |`);
  }
});

test("contains the secret pattern and every credential key", () => {
  expect(contract).toContain(SECRET_REF_PATTERN);
  for (const key of CREDENTIAL_KEY_NAMES) expect(contract).toContain(`\`${key}\``);
});

test("contains both minimal documents verbatim", () => {
  expect(contract).toContain(`{\n  "schemaVersion": 1,\n  "estate": { "name": "example-estate" }\n}`);
  expect(contract).toContain(`{\n  "schemaVersion": 1,\n  "generatedAt": "2020-01-01T00:00:00Z"\n}`);
});

test("contains a dated version-1 compatibility entry", () => {
  expect(contract).toMatch(/^\| 1 \| \d{4}-\d{2}-\d{2} \|/m);
});

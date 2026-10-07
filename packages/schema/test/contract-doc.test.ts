import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  composeDefault,
  CREDENTIAL_KEY_NAMES,
  MODULE_HOST_FINDING_CATALOG,
  SECRET_REF_PATTERN,
} from "../src/index.js";

const composed = composeDefault();
/** Every code `validate` and `validateSnapshot` can emit: the kernel's and the built-in sections'. */
const configCodes = Object.keys(composed.catalog).filter((code) => !(code in MODULE_HOST_FINDING_CATALOG));

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
  "HOST_DUPLICATE", "SERVICE_DUPLICATE", "ID_DUPLICATE", "PROVIDER_ID_SHARED",
  "REF_HOST_UNRESOLVED", "REF_SERVICE_UNRESOLVED",
  "LAYER_OVERLAY_KEY_IN_BASE", "LAYER_BASE_KEY_IN_OVERLAY", "OVERLAY_DANGLING_REF",
  "PROVIDER_BINDING_UNSUPPORTED", "PROVIDER_KIND_DISABLED", "PROVIDER_KIND_UNKNOWN", "SECRET_VALUE_SUSPECTED",
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
  for (const [code, { severity }] of Object.entries(composed.catalog)) {
    expect(contract).toContain(`| \`${code}\` | \`${severity}\` |`);
  }
});

test("partitions schema-level and library-only finding codes", () => {
  const schemaStart = contract.indexOf("### Schema-level codes");
  const start = contract.indexOf("### Library-only semantic rules");
  const hostStart = contract.indexOf("### Module host codes", start);
  const end = contract.indexOf("\n## Provider kinds", start);
  const schemaSection = contract.slice(schemaStart, start);
  const semanticSection = contract.slice(start, hostStart);
  const hostSection = contract.slice(hostStart, end);
  for (const code of Object.keys(MODULE_HOST_FINDING_CATALOG)) expect(hostSection).toContain(`\`${code}\``);
  for (const code of configCodes) {
    expect(semanticSection.includes(`\`${code}\``), code).toBe(libraryOnly.has(code));
    expect(schemaSection.includes(`\`${code}\``), code).toBe(!libraryOnly.has(code));
  }
});

test("contains every built-in provider kind", () => {
  for (const kind of composed.knownKinds) expect(contract).toContain(`\`${kind}\``);
});

test("contains every ownership and identity row", () => {
  for (const [path, owner] of Object.entries(composed.ownership)) {
    expect(contract).toContain(`| \`${path}\` | \`${owner}\` |`);
  }
  for (const [collection, identity] of Object.entries(composed.identity)) {
    expect(contract).toContain(`| \`${collection}\` | \`${JSON.stringify(identity)}\` |`);
  }
});

test("contains the secret pattern and every credential key", () => {
  expect(contract).toContain(SECRET_REF_PATTERN);
  for (const key of CREDENTIAL_KEY_NAMES) expect(contract).toContain(`\`${key}\``);
});

test("contains both minimal documents verbatim", () => {
  expect(contract).toContain(`{\n  "schemaVersion": 2,\n  "estate": { "name": "example-estate" }\n}`);
  expect(contract).toContain(`{\n  "schemaVersion": 1,\n  "generatedAt": "2020-01-01T00:00:00Z"\n}`);
});

test("contains dated version-1 and version-2 compatibility entries", () => {
  expect(contract).toMatch(/^\| 1 \| \d{4}-\d{2}-\d{2} \|/m);
  expect(contract).toMatch(/^\| 2 \| \d{4}-\d{2}-\d{2} \| Breaking/m);
});

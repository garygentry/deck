import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { SECRET_REF_MAX_LENGTH, SECRET_REF_PATTERN } from "../src/secrets.js";
import { composeDefault } from "../src/compose/builtin.js";
import { CONFIG_SCHEMA_VERSION, SNAPSHOT_SCHEMA_VERSION } from "../src/version.js";

type Schema = Record<string, unknown>;

const readSchema = (name: string): Schema =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../schema/${name}`, import.meta.url)), "utf8")) as Schema;

const deck = readSchema("deck.schema.json");
const snapshot = readSchema("snapshot.schema.json");

function visit(value: unknown, path: string, callback: (node: Schema, path: string) => void): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${path}/${index}`, callback));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Schema;
  callback(node, path);
  Object.entries(node).forEach(([key, child]) => visit(child, `${path}/${key}`, callback));
}

function propertyDescriptionFailures(schema: Schema): string[] {
  const failures: string[] = [];
  visit(schema, "#", (node, path) => {
    const properties = node.properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return;
    for (const [name, property] of Object.entries(properties)) {
      if (property === null || typeof property !== "object" || !("description" in property)) {
        failures.push(`${path}/properties/${name}`);
      }
    }
  });
  return failures;
}

const openObjects = new Set([
  "deck:#/$defs/Estate/properties/domains",
  "deck:#/$defs/Bindings",
  "deck:#/$defs/Integration/properties/card",
  "deck:#/$defs/JsonValue/anyOf/5",
  "deck:#/$defs/Ui/properties/extensions",
  "deck:#/$defs/UiOverride/anyOf/1/properties/config",
  // Checked against the widget type's own options schema once composed.
  "deck:#/$defs/UiWidget/properties/options",
  "snapshot:#/$defs/ObservedHost/properties/facts",
  "snapshot:#/$defs/ObservedService/properties/facts",
  "snapshot:#/$defs/JsonValue/anyOf/5",
]);

function objectClosednessFailures(name: string, schema: Schema): string[] {
  const failures: string[] = [];
  visit(schema, "#", (node, path) => {
    if (node.type !== "object") return;
    const qualified = `${name}:${path}`;
    if (openObjects.has(qualified)) {
      if (node.additionalProperties !== true && typeof node.additionalProperties !== "object") failures.push(qualified);
    } else if (node.additionalProperties !== false) {
      failures.push(qualified);
    }
  });
  return failures;
}

function strictAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, discriminator: true, strict: true });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => !Number.isNaN(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value),
  });
  return ajv;
}

describe("published schema files", () => {
  it("uses draft 2020-12, stable titles, and each document's own version", () => {
    expect(deck.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(snapshot.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(deck.title).toBe("DeckConfigDocument");
    expect(snapshot.title).toBe("SnapshotDocument");
    expect((deck.properties as Schema).schemaVersion).toMatchObject({ type: "integer", const: CONFIG_SCHEMA_VERSION });
    expect((snapshot.properties as Schema).schemaVersion).toMatchObject({ type: "integer", const: SNAPSHOT_SCHEMA_VERSION });
  });

  it("describes every property and closes every non-extension object", () => {
    expect(propertyDescriptionFailures(deck)).toEqual([]);
    expect(propertyDescriptionFailures(snapshot)).toEqual([]);
    expect(objectClosednessFailures("deck", deck)).toEqual([]);
    expect(objectClosednessFailures("snapshot", snapshot)).toEqual([]);
  });

  it("keeps every shared definition structurally identical", () => {
    const deckDefs = deck.$defs as Record<string, unknown>;
    const snapshotDefs = snapshot.$defs as Record<string, unknown>;
    const shared = Object.keys(deckDefs).filter((name) => name in snapshotDefs);
    expect(shared).toEqual(["Address", "JsonValue"]);
    shared.forEach((name) => expect(snapshotDefs[name]).toEqual(deckDefs[name]));
  });

  it("single-sources Severity and the secret-reference contract", () => {
    expect((deck.$defs as Schema).Severity).toBeUndefined();
    expect(((snapshot.$defs as Schema).Severity as Schema).enum).toEqual(["error", "warning", "info"]);
    expect((deck.$defs as Schema).SecretRef).toMatchObject({
      pattern: SECRET_REF_PATTERN,
      maxLength: SECRET_REF_MAX_LENGTH,
    });
  });

  it("compiles strictly and accepts the minimal documents", () => {
    const ajv = strictAjv();
    const validateDeck = ajv.compile(deck);
    const validateSnapshot = ajv.compile(snapshot);
    expect(validateDeck({ schemaVersion: 2, estate: { name: "example-estate" } }), validateDeck.errors?.map(String).join("\n")).toBe(true);
    const validateComposed = strictAjv().compile(composeDefault().schema);
    expect(validateComposed({ schemaVersion: 2, estate: { name: "example-estate" }, modules: {} }), validateComposed.errors?.map(String).join("\n")).toBe(true);
    expect(validateSnapshot({ schemaVersion: 1, generatedAt: "2025-01-01T00:00:00Z" }), validateSnapshot.errors?.map(String).join("\n")).toBe(true);
  });
});

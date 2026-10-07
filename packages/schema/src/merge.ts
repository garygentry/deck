import type { JsonObject, JsonValue } from "./types.js";
import { composeDefault } from "./compose/builtin.js";
import type { ComposedConfig } from "./compose/compose.js";
import { resolveOwner, type IdentitySpec, type Owner } from "./ownership.js";

/**
 * Thrown by `merge` on a precondition failure (REQ-LAYER-07), before any output is
 * constructed — so no partial document is ever produced. Consumers catch it and map
 * to exit 2. `merge` never returns findings.
 */
export class MergeError extends Error {
  /** Which precondition failed. */
  readonly code: "MERGE_INPUT_NOT_OBJECT" | "MERGE_VERSION_MISMATCH" | "MERGE_IDENTITY_MISSING";
  /** JSON Pointer to the offending value within the layer named by `layer`. */
  readonly path: string;
  /** Which input layer the offending value is in. */
  readonly layer: "base" | "overlay";

  constructor(
    code: MergeError["code"],
    layer: "base" | "overlay",
    path: string,
    message: string,
  ) {
    super(message);
    this.name = "MergeError";
    this.code = code;
    this.layer = layer;
    this.path = path;
  }
}

type InputLayer = "base" | "overlay";
/** The ownership and identity tables one merge reads. */
interface Tables {
  ownership: Readonly<Record<string, Owner>>;
  identity: Readonly<Record<string, IdentitySpec>>;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Combine generated inventory and authored presentation layers into a fresh object, by the
 * ownership and identity rows of `composed` (default: the kernel plus the built-in
 * contributions).
 */
export function merge(
  base: JsonObject,
  overlay: JsonObject,
  composed: ComposedConfig = composeDefault(),
): JsonObject {
  const tables: Tables = { ownership: composed.ownership, identity: composed.identity };
  assertObject(base, "base");
  assertObject(overlay, "overlay");
  assertVersions(base, overlay);
  assertIdentities(tables, base, "", "", "base");
  assertIdentities(tables, overlay, "", "", "overlay");
  return mergeObject(tables, base, overlay, "");
}

function assertObject(value: unknown, layer: InputLayer): asserts value is JsonObject {
  if (!isPlainObject(value)) {
    throw new MergeError(
      "MERGE_INPUT_NOT_OBJECT", layer, "", `${layer} merge input must be an object`,
    );
  }
}

function assertVersions(base: JsonObject, overlay: JsonObject): void {
  if (!hasOwn(base, "schemaVersion")) {
    throw new MergeError(
      "MERGE_VERSION_MISMATCH", "base", "/schemaVersion", "base schemaVersion is missing",
    );
  }
  if (!hasOwn(overlay, "schemaVersion")) {
    throw new MergeError(
      "MERGE_VERSION_MISMATCH", "overlay", "/schemaVersion", "overlay schemaVersion is missing",
    );
  }
  if (base.schemaVersion !== overlay.schemaVersion) {
    throw new MergeError(
      "MERGE_VERSION_MISMATCH", "overlay", "/schemaVersion", "layer schemaVersions do not match",
    );
  }
}

function assertIdentities(
  tables: Tables,
  value: JsonValue,
  ownerPath: string,
  pointer: string,
  layer: InputLayer,
): void {
  if (Array.isArray(value)) {
    const spec = identitySpec(tables, ownerPath);
    value.forEach((element, index) => {
      const elementPointer = `${pointer}/${index}`;
      if (spec !== undefined) assertElementIdentity(element, spec, elementPointer, layer);
      assertIdentities(tables, element, `${ownerPath}[]`, elementPointer, layer);
    });
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) continue;
    const childPath = ownerPath === "" ? key : `${ownerPath}.${key}`;
    assertIdentities(tables, value[key], childPath, `${pointer}/${escapePointer(key)}`, layer);
  }
}

function assertElementIdentity(
  element: JsonValue,
  spec: IdentitySpec,
  pointer: string,
  layer: InputLayer,
): void {
  if (!isPlainObject(element)) throwIdentity(layer, pointer);
  const keys = selectedIdentityKeys(element, spec);
  if (keys === undefined || keys.some((key) => !hasOwn(element, key))) {
    throwIdentity(layer, pointer);
  }
}

function throwIdentity(layer: InputLayer, pointer: string): never {
  throw new MergeError(
    "MERGE_IDENTITY_MISSING", layer, pointer, `identity is missing at ${pointer}`,
  );
}

function mergeObject(tables: Tables, base: JsonObject, overlay: JsonObject, ownerPath: string): JsonObject {
  const output: JsonObject = {};
  for (const key of Object.keys(base)) {
    if (isForbiddenKey(key)) continue;
    const childPath = ownerPath === "" ? key : `${ownerPath}.${key}`;
    output[key] = hasOwn(overlay, key)
      ? combine(tables, base[key], overlay[key], resolveOwner(childPath, tables.ownership), childPath)
      : clone(base[key]);
  }
  for (const key of Object.keys(overlay)) {
    if (isForbiddenKey(key) || hasOwn(base, key)) continue;
    output[key] = clone(overlay[key]);
  }
  return output;
}

function combine(tables: Tables, base: JsonValue, overlay: JsonValue, owner: Owner, path: string): JsonValue {
  switch (owner) {
    case "base":
    case "both":
      return clone(base);
    case "overlay":
      if (isPlainObject(base) && isPlainObject(overlay)) return mergeObject(tables, base, overlay, path);
      if (isIdentityArray(tables, path, base, overlay)) {
        return mergeIdentityArray(tables, base as JsonValue[], overlay as JsonValue[], path);
      }
      return clone(overlay);
    case "container":
      if (isPlainObject(base) && isPlainObject(overlay)) return mergeObject(tables, base, overlay, path);
      if (isIdentityArray(tables, path, base, overlay)) {
        return mergeIdentityArray(tables, base as JsonValue[], overlay as JsonValue[], path);
      }
      return clone(base);
  }
}

function mergeIdentityArray(
  tables: Tables,
  base: JsonValue[],
  overlay: JsonValue[],
  arrayPath: string,
): JsonValue[] {
  const spec = identitySpec(tables, arrayPath)!;
  const elementPath = `${arrayPath}[]`;
  const overlayByKey = new Map<string, JsonValue>();
  const overlayOrder: string[] = [];
  for (const element of overlay) {
    const key = identityKey(element, spec);
    overlayByKey.set(key, element);
    overlayOrder.push(key);
  }

  const matched = new Set<string>();
  const output: JsonValue[] = [];
  for (const baseElement of base) {
    const key = identityKey(baseElement, spec);
    const overlayElement = overlayByKey.get(key);
    if (overlayElement !== undefined && isPlainObject(baseElement) && isPlainObject(overlayElement)) {
      matched.add(key);
      output.push(mergeObject(tables, baseElement, overlayElement, elementPath));
    } else {
      output.push(clone(baseElement));
    }
  }
  for (const key of overlayOrder) {
    if (!matched.has(key)) output.push(clone(overlayByKey.get(key)!));
  }
  return output;
}

function identityKey(element: JsonValue, spec: IdentitySpec): string {
  const object = element as JsonObject;
  const keys = selectedIdentityKeys(object, spec)!;
  const tuple = isFixedIdentitySpec(spec)
    ? keys.map((key) => object[key])
    : [object.type, ...keys.map((key) => object[key])];
  return tuple.map(String).join("\0");
}

function selectedIdentityKeys(
  element: JsonObject,
  spec: IdentitySpec,
): readonly string[] | undefined {
  if (isFixedIdentitySpec(spec)) return spec;
  if (!hasOwn(element, "type") || typeof element.type !== "string") return undefined;
  return spec[element.type];
}

function isFixedIdentitySpec(spec: IdentitySpec): spec is readonly string[] {
  return Array.isArray(spec);
}

function identitySpec(tables: Tables, path: string): IdentitySpec | undefined {
  return Object.prototype.hasOwnProperty.call(tables.identity, path) ? tables.identity[path] : undefined;
}

function isIdentityArray(
  tables: Tables,
  path: string,
  base: JsonValue,
  overlay: JsonValue,
): base is JsonValue[] {
  return identitySpec(tables, path) !== undefined && Array.isArray(base) && Array.isArray(overlay);
}

function clone(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;
  const output: JsonObject = {};
  for (const key of Object.keys(value)) {
    if (!isForbiddenKey(key)) output[key] = clone(value[key]);
  }
  return output;
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

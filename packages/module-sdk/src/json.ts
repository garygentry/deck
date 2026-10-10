/** A JSON value: what a manifest may contain so the kernel can read it without running code. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** A JSON Schema document or fragment, kept as plain JSON. */
export type JsonSchema = JsonObject;

/** An RFC 6901 JSON Pointer, e.g. `/claude/statusLine/credentialEnv`. */
export type JsonPointer = `/${string}` | "";

export class ManifestSerialisationError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`manifest${path}: ${reason}`);
    this.name = "ManifestSerialisationError";
  }
}

/**
 * Assert that a value survives a JSON round trip unchanged: no functions, symbols, bigints,
 * `undefined` values, non-finite numbers, class instances, accessor properties or cycles.
 * Optional fields must be omitted rather than set to `undefined`. Properties are inspected
 * through their descriptors, so a getter is rejected without ever being called.
 */
export function assertJsonSerialisable(value: unknown, path = ""): void {
  walk(value, path, new Set());
}

/**
 * Validate a value with {@link assertJsonSerialisable}, then return a deep, frozen copy that
 * shares nothing with the original: later mutation of the source cannot change it.
 */
export function jsonSnapshot<T>(value: T): T {
  assertJsonSerialisable(value);
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const escapeKey = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

function walk(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ManifestSerialisationError(path, "number is not finite");
    return;
  }
  if (typeof value !== "object") {
    throw new ManifestSerialisationError(path, `${typeof value} is not JSON`);
  }
  if (seen.has(value)) throw new ManifestSerialisationError(path, "cycle");
  seen.add(value);
  const isArray = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (!isArray && proto !== Object.prototype && proto !== null) {
    throw new ManifestSerialisationError(path, "only plain objects are JSON");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ManifestSerialisationError(path, "symbol keys are not JSON");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (isArray && key === "length") continue;
    const childPath = `${path}/${escapeKey(key)}`;
    if (!("value" in descriptor)) throw new ManifestSerialisationError(childPath, "accessor properties are not JSON");
    if (!descriptor.enumerable) throw new ManifestSerialisationError(childPath, "non-enumerable properties are not JSON");
    walk(descriptor.value, childPath, seen);
  }
  if (isArray) {
    for (let index = 0; index < (value as unknown[]).length; index += 1) {
      if (!(String(index) in descriptors)) throw new ManifestSerialisationError(`${path}/${index}`, "sparse arrays are not JSON");
    }
  }
  seen.delete(value);
}

/** Resolve an RFC 6901 pointer against a JSON-like value; undefined when any step is missing. */
export function resolvePointer(value: unknown, pointer: JsonPointer): unknown {
  if (pointer === "") return value;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

import type { EnvReader, JsonObject, ProviderTiming } from "@deck/module-sdk";

import type { HttpJsonAuth, HttpJsonConfig } from "./fetch.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };

/**
 * What an instance of a kind that polls through {@link fetchJson} (`http-json`, `remote`) sets
 * for its requests, read the same way for each: the credential's variable and scheme, the
 * instance's own env reader, its timeout and body cap, and its provider timing.
 */

const schemaProperties = (instanceSchema as unknown as { properties: Record<string, unknown> }).properties;

/**
 * The `http-json` instance schema's properties `names`, for a kind whose instances take the
 * same settings. Throws on a name the schema does not have, so a renamed property cannot drop
 * out of another kind's schema unnoticed.
 */
export function sharedInstanceProperties(names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.map((name) => {
      const property = schemaProperties[name];
      if (property === undefined) throw new Error(`the http-json instance schema has no property "${name}"`);
      return [name, property];
    }),
  );
}

function auth(value: unknown): HttpJsonAuth | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { scheme, header } = value as { scheme?: unknown; header?: unknown };
  if (scheme === "bearer" || scheme === "basic") return { scheme };
  if (scheme === "header" && typeof header === "string") return { scheme, header };
  const { param } = value as { param?: unknown };
  if (scheme === "query" && typeof param === "string") return { scheme, param };
  return undefined;
}

/** A positive integer setting, or undefined. */
export const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** The provider timing an instance sets. Freshness defaults to its poll interval, not deck's. */
function timing(instance: JsonObject): ProviderTiming | undefined {
  const pollIntervalMs = integer(instance.pollIntervalMs);
  const timeoutMs = integer(instance.timeoutMs);
  const ttlMs = integer(instance.ttlMs) ?? pollIntervalMs;
  const resolved: ProviderTiming = {
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  };
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

/** An instance's request settings, as {@link fetchJson} takes them. */
export type InstanceRequest = Pick<HttpJsonConfig, "credentialEnv" | "auth" | "env" | "timeoutMs" | "maxBytes">;

/**
 * An instance's request settings and provider timing. `envFor` is the kind context's reader
 * factory: the request reads only this instance's own credential, never another's.
 */
export function instanceRequest(
  instance: JsonObject,
  envFor: (instance: JsonObject) => EnvReader,
): { request: InstanceRequest; timing?: ProviderTiming } {
  const instanceTiming = timing(instance);
  const instanceAuth = auth(instance.auth);
  const maxBytes = integer(instance.maxBytes);
  return {
    request: {
      ...(typeof instance.credentialEnv === "string" ? { credentialEnv: instance.credentialEnv } : {}),
      ...(instanceAuth === undefined ? {} : { auth: instanceAuth }),
      env: envFor(instance),
      ...(instanceTiming?.timeoutMs === undefined ? {} : { timeoutMs: instanceTiming.timeoutMs }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    },
    ...(instanceTiming === undefined ? {} : { timing: instanceTiming }),
  };
}

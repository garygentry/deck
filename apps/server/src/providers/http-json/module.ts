import {
  defineServerModule,
  type JsonObject,
  type JsonSchema,
  type ModuleManifest,
  type ProviderOffer,
  type ProviderTiming,
} from "@deck/module-sdk";

import { HttpJsonProvider, type HttpJsonAuth, type HttpJsonConfig } from "./index.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };

/**
 * The `http-json` data source: each `integrations[]` instance of kind `http-json` becomes a
 * provider under the instance's own id, polling its URL and serving the parsed JSON body as
 * the envelope's `data`. The only credential is the one the instance's `credentialEnv` names,
 * read at poll time; config holds no secret. The kind is not bindable.
 */
export const HTTP_JSON_MANIFEST: ModuleManifest = {
  id: "http-json",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [{ kind: "http-json", instanceSchema: instanceSchema as JsonSchema, statusCapable: false }],
};

/** Header names a literal header may not take (the instance schema refuses them too). */
const CREDENTIAL_HEADER = /auth|cookie|token|secret|key|pass|session|credential/i;

function auth(value: unknown): HttpJsonAuth | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { scheme, header } = value as { scheme?: unknown; header?: unknown };
  if (scheme === "bearer" || scheme === "basic") return { scheme };
  if (scheme === "header" && typeof header === "string") return { scheme, header };
  return undefined;
}

function headers(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && !CREDENTIAL_HEADER.test(entry[0]),
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

const integer = (value: unknown): number | undefined =>
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

export const httpJsonModule = defineServerModule(HTTP_JSON_MANIFEST, () => {}, {
  kinds: {
    "http-json": {
      instances: (instances, { envFor, logger }) =>
        instances.flatMap((instance): ProviderOffer[] => {
          const { id, url } = instance;
          // Config validation has checked the shape; anything else is skipped, never fatal.
          if (typeof id !== "string" || typeof url !== "string" || !/^https?:\/\//.test(url)) {
            logger.warn({ event: "http-json.instance.skipped", ...(typeof id === "string" ? { id } : {}) }, "http-json instance skipped");
            return [];
          }
          const instanceTiming = timing(instance);
          const literalHeaders = headers(instance.headers);
          const instanceAuth = auth(instance.auth);
          const maxBytes = integer(instance.maxBytes);
          const config: HttpJsonConfig = {
            url,
            ...(instance.method === "POST" ? { method: "POST" as const } : {}),
            ...(literalHeaders === undefined ? {} : { headers: literalHeaders }),
            ...(instance.body === undefined ? {} : { body: instance.body }),
            ...(typeof instance.credentialEnv === "string" ? { credentialEnv: instance.credentialEnv } : {}),
            ...(instanceAuth === undefined ? {} : { auth: instanceAuth }),
            // Only this instance's credential: another instance's is never readable here.
            env: envFor(instance),
            ...(instanceTiming?.timeoutMs === undefined ? {} : { timeoutMs: instanceTiming.timeoutMs }),
            ...(maxBytes === undefined ? {} : { maxBytes }),
          };
          return [{ provider: new HttpJsonProvider(id, config), ...(instanceTiming ? { timing: instanceTiming } : {}) }];
        }),
    },
  },
});

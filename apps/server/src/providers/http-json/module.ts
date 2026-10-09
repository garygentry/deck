import {
  defineServerModule,
  type JsonObject,
  type JsonSchema,
  type ConfigRuleFinding,
  type InstanceRuleContext,
  type ModuleManifest,
  type ProviderOffer,
  type ProviderTiming,
} from "@deck/module-sdk";

import { HttpJsonProvider, type HttpJsonAuth, type HttpJsonConfig } from "./index.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };
import { credentialBodyKeys, credentialHeaderNames, credentialQueryParams, isCredentialName, urlProblem } from "./literal.js";

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
  providerKinds: [
    {
      kind: "http-json",
      instanceSchema: instanceSchema as unknown as JsonSchema,
      statusCapable: false,
      findings: [
        {
          code: "HTTP_JSON_URL_INVALID",
          severity: "error",
          summary: "An http-json integration's url is not an http(s) URL the runtime can parse.",
          fix: "Give a full http:// or https:// URL with a valid host and port, and no user:password@.",
        },
        {
          code: "HTTP_JSON_LITERAL_CREDENTIAL",
          severity: "error",
          summary: "An http-json integration's header, url query or body names what looks like a credential, which config may not hold.",
          fix: "Put the credential in an environment variable, name it in credentialEnv, and send it with auth (scheme query for a query parameter).",
        },
        {
          code: "HTTP_JSON_ID_RESERVED",
          severity: "error",
          summary: "An http-json integration's id is the fixed provider id of another integration in the estate, so boot would fail.",
          fix: "Choose another id.",
        },
      ],
    },
  ],
};

/** What config validation reports for one instance beyond its schema. Pure. */
function validateInstance(instance: JsonObject, { document, fixedIds }: InstanceRuleContext): ConfigRuleFinding[] {
  const findings: ConfigRuleFinding[] = [];
  const { id, url, body, headers } = instance;
  // A fixed id clashes only when an instance of its kind is there to register it.
  for (const [kind, fixedId] of fixedIds) {
    if (id !== fixedId) continue;
    const holds = ["integrations", "sources"].some((list) => {
      const instances = document[list];
      return Array.isArray(instances) && instances.some((other) => other !== null && typeof other === "object" && (other as JsonObject).kind === kind);
    });
    if (holds) {
      findings.push({ code: "HTTP_JSON_ID_RESERVED", path: "/id", message: `id "${id}" is the fixed provider id of the ${kind} integration in this estate; boot would fail when both register.` });
    }
  }
  for (const name of credentialHeaderNames(headers)) {
    findings.push({ code: "HTTP_JSON_LITERAL_CREDENTIAL", path: `/headers/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`, message: `header "${name}" names a credential; config may not hold one.`, hint: "Use credentialEnv with auth: { scheme: header, header: ... }." });
  }
  if (typeof url === "string") {
    const problem = urlProblem(url);
    if (problem !== null) findings.push({ code: "HTTP_JSON_URL_INVALID", path: "/url", message: `url ${problem}.` });
    for (const param of credentialQueryParams(url)) {
      findings.push({ code: "HTTP_JSON_LITERAL_CREDENTIAL", path: "/url", message: `url query parameter "${param}" looks like a credential; config may not hold one.`, hint: "Use credentialEnv with auth: { scheme: query, param: ... }." });
    }
  }
  for (const key of credentialBodyKeys(body)) {
    findings.push({ code: "HTTP_JSON_LITERAL_CREDENTIAL", path: "/body", message: `body key "${key}" looks like a credential; config may not hold one.` });
  }
  return findings;
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

function headers(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && !isCredentialName(entry[0]),
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
      validate: (instance, context) => validateInstance(instance, context),
      instances: (instances, { envFor, logger }) =>
        instances.flatMap((instance): ProviderOffer[] => {
          const { id, url } = instance;
          // Config validation has checked the shape; anything else is skipped, never fatal.
          if (typeof id !== "string" || typeof url !== "string" || urlProblem(url) !== null) {
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

import {
  defineServerModule,
  type JsonObject,
  type JsonSchema,
  type ConfigRuleFinding,
  type ModuleManifest,
  type ProviderOffer,
} from "@deck/module-sdk";

import { HttpJsonProvider, type HttpJsonConfig } from "./index.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };
import { credentialBodyKeys, credentialHeaderNames, credentialQueryParams, isCredentialName, urlProblem } from "./literal.js";
import { instanceRequest } from "./request-config.js";

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
          code: "HTTP_JSON_REDIRECT_OPT_IN_IGNORED",
          severity: "warning",
          summary: "An http-json integration sets followCrossOriginRedirects with a credentialEnv; an authenticated poll never follows a cross-origin redirect, so the setting has no effect.",
          fix: "Remove followCrossOriginRedirects, or point url at the origin the API redirects to.",
        },
      ],
    },
  ],
};

/** What config validation reports for one instance beyond its schema. Pure. */
function validateInstance(instance: JsonObject): ConfigRuleFinding[] {
  const { url, body, headers } = instance;
  const findings: ConfigRuleFinding[] = [];
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
  if (instance.followCrossOriginRedirects === true && instance.credentialEnv !== undefined) {
    findings.push({ code: "HTTP_JSON_REDIRECT_OPT_IN_IGNORED", path: "/followCrossOriginRedirects", message: "followCrossOriginRedirects has no effect with credentialEnv: an authenticated poll never leaves the url's origin." });
  }
  return findings;
}

function headers(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && !isCredentialName(entry[0]),
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export const httpJsonModule = defineServerModule(HTTP_JSON_MANIFEST, () => {}, {
  kinds: {
    "http-json": {
      validate: (instance) => validateInstance(instance),
      instances: (instances, { envFor, logger }) =>
        instances.flatMap((instance): ProviderOffer[] => {
          const { id, url } = instance;
          // Config validation has checked the shape; anything else is skipped, never fatal.
          if (typeof id !== "string" || typeof url !== "string" || urlProblem(url) !== null) {
            logger.warn({ event: "http-json.instance.skipped", ...(typeof id === "string" ? { id } : {}) }, "http-json instance skipped");
            return [];
          }
          const { request, timing } = instanceRequest(instance, envFor);
          const literalHeaders = headers(instance.headers);
          const config: HttpJsonConfig = {
            url,
            ...(instance.method === "POST" ? { method: "POST" as const } : {}),
            ...(literalHeaders === undefined ? {} : { headers: literalHeaders }),
            ...(instance.body === undefined ? {} : { body: instance.body }),
            ...(instance.followCrossOriginRedirects === true ? { followCrossOriginRedirects: true } : {}),
            // Only this instance's credential: another instance's is never readable here.
            ...request,
          };
          return [{ provider: new HttpJsonProvider(id, config), ...(timing === undefined ? {} : { timing }) }];
        }),
    },
  },
});

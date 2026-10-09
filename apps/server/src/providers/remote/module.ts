import {
  defineServerModule,
  type ConfigRuleFinding,
  type InstanceRuleContext,
  type JsonObject,
  type JsonSchema,
  type ModuleManifest,
  type ProviderOffer,
} from "@deck/module-sdk";

import httpJsonSchema from "../http-json/instance.schema.json" with { type: "json" };
import { urlProblem } from "../http-json/literal.js";
import { auth, fixedIdFindings, integer, timing } from "../http-json/module.js";
import { RemoteProvider } from "./provider.js";

const httpJson = httpJsonSchema as unknown as { properties: Record<string, unknown> };
const shared = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, httpJson.properties[name]]));

/**
 * A `remote` integration: the http-json instance's own credential, timing and size settings
 * (the same schema), and a base URL with no query.
 */
const instanceSchema = {
  title: "Remote provider integration",
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "title", "url"],
  dependentRequired: { auth: ["credentialEnv"] },
  properties: {
    id: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]*$",
      maxLength: 64,
      description: "Integration id, unique across integrations; also the provider id.",
    },
    kind: { const: "remote", description: "Provider kind." },
    ...shared(["title", "deepLink"]),
    url: {
      type: "string",
      maxLength: 2048,
      pattern: "^https?://[^/?#@\\s]+(?:/[^?#\\s]*)?$",
      description: "The sidecar's base http(s) URL, such as http://nut-sidecar:9000; deck requests /deck/v1/data under it. No query, fragment or user:password@.",
    },
    ...shared(["credentialEnv", "auth", "pollIntervalMs", "timeoutMs", "ttlMs", "maxBytes"]),
  },
} as const;

/**
 * The `remote` data source (the remote provider protocol, version 1): each `integrations[]`
 * instance of kind `remote` is a sidecar deck polls at `<url>/deck/v1/data`.
 */
export const REMOTE_MANIFEST: ModuleManifest = {
  id: "remote",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [
    {
      kind: "remote",
      instanceSchema: instanceSchema as unknown as JsonSchema,
      statusCapable: false,
      findings: [
        {
          code: "REMOTE_URL_INVALID",
          severity: "error",
          summary: "A remote integration's url is not an http(s) URL the runtime can parse.",
          fix: "Give the sidecar's base URL, such as http://nut-sidecar:9000, with no user:password@.",
        },
        {
          code: "REMOTE_ID_RESERVED",
          severity: "error",
          summary: "A remote integration's id is the fixed provider id of another integration in the estate, so boot would fail.",
          fix: "Choose another id.",
        },
      ],
    },
  ],
};

function validateInstance(instance: JsonObject, context: InstanceRuleContext): ConfigRuleFinding[] {
  const findings = fixedIdFindings(instance.id, context, "REMOTE_ID_RESERVED");
  if (typeof instance.url === "string") {
    const problem = urlProblem(instance.url);
    if (problem !== null) findings.push({ code: "REMOTE_URL_INVALID", path: "/url", message: `url ${problem}.` });
  }
  return findings;
}

export const remoteModule = defineServerModule(REMOTE_MANIFEST, () => {}, {
  kinds: {
    remote: {
      validate: (instance, context) => validateInstance(instance, context),
      instances: (instances, { envFor, logger }) =>
        instances.flatMap((instance): ProviderOffer[] => {
          const { id, url } = instance;
          // Config validation has checked the shape; anything else is skipped, never fatal.
          if (typeof id !== "string" || typeof url !== "string" || urlProblem(url) !== null) {
            logger.warn({ event: "remote.instance.skipped", ...(typeof id === "string" ? { id } : {}) }, "remote instance skipped");
            return [];
          }
          const instanceTiming = timing(instance);
          const instanceAuth = auth(instance.auth);
          const maxBytes = integer(instance.maxBytes);
          const provider = new RemoteProvider(
            id,
            {
              url,
              request: {
                ...(typeof instance.credentialEnv === "string" ? { credentialEnv: instance.credentialEnv } : {}),
                ...(instanceAuth === undefined ? {} : { auth: instanceAuth }),
                // Only this instance's credential: another instance's is never readable here.
                env: envFor(instance),
              },
              ...(instanceTiming?.timeoutMs === undefined ? {} : { timeoutMs: instanceTiming.timeoutMs }),
              ...(maxBytes === undefined ? {} : { maxBytes }),
            },
          );
          return [{ provider, ...(instanceTiming ? { timing: instanceTiming } : {}) }];
        }),
    },
  },
});

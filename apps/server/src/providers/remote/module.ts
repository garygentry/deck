import {
  defineServerModule,
  type ConfigRuleFinding,
  type InstanceRuleContext,
  type JsonObject,
  type JsonSchema,
  type ModuleManifest,
  type ProviderOffer,
} from "@deck/module-sdk";
import deckSchema from "@deck/schema/deck.schema.json" with { type: "json" };

import httpJsonSchema from "../http-json/instance.schema.json" with { type: "json" };
import { urlProblem } from "../http-json/literal.js";
import { auth, fixedIdFindings, integer, timing } from "../http-json/module.js";
import { RUNTIME_PAGES } from "../../ui/runtime-pages.js";
import { RemoteDirectory, type RemotePageConfig } from "./directory.js";
import { RemoteProvider } from "./provider.js";

const uiDefs = (deckSchema as unknown as { $defs: Record<string, { properties: Record<string, unknown> }> }).$defs;
const httpJson = httpJsonSchema as unknown as { properties: Record<string, unknown> };
const shared = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, httpJson.properties[name]]));

/**
 * A `remote` integration: the http-json instance's own credential, timing and size settings
 * (the same schema), a base URL with no query, and where its contributions render.
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
      description: "Integration id, unique across integrations; also the provider id, and the name of its page (page:remote/<id>).",
    },
    kind: { const: "remote", description: "Provider kind." },
    ...shared(["title", "deepLink"]),
    url: {
      type: "string",
      maxLength: 2048,
      pattern: "^https?://[^/?#@\\s]+(?:/[^?#\\s]*)?$",
      description: "The sidecar's base http(s) URL, such as http://nut-sidecar:9000; deck requests /deck/v1/describe and /deck/v1/data under it. No query, fragment or user:password@.",
    },
    ...shared(["credentialEnv", "auth", "pollIntervalMs", "timeoutMs", "ttlMs", "maxBytes"]),
    describeIntervalMs: {
      type: "integer",
      minimum: 10000,
      maximum: 86400000,
      description: "Milliseconds between describe requests once one succeeded; default 300000. A failed describe is asked again at the next poll.",
    },
    page: {
      type: "object",
      additionalProperties: false,
      description: "Where the sidecar's widgets and links render: its page (default path /remote/<id>), and optionally a sidebar entry.",
      properties: {
        path: uiDefs.UiPage!.properties.path,
        icon: uiDefs.UiPage!.properties.icon,
        nav: { ...uiDefs.UiPageNav, description: "The page's sidebar entry (nav:remote/<id>); without it the page has none." },
      },
    },
  },
} as const;

/**
 * The `remote` data source (the remote provider protocol, version 1): each `integrations[]`
 * instance of kind `remote` is a sidecar deck polls at `<url>/deck/v1/data` and asks to
 * describe itself at `<url>/deck/v1/describe`. Its declarative widgets, links and nav entries
 * render on its own page: the directory this kind offers is its runtime page source.
 */
export const REMOTE_MANIFEST: ModuleManifest = {
  id: "remote",
  version: "1.0.0",
  deckApi: "^0.1",
  services: { provides: [RUNTIME_PAGES.name] },
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

/** Where an instance's contributions render: its `page` settings, the path defaulting to `/remote/<id>`. */
function pageOf(id: string, page: unknown): RemotePageConfig {
  const value = (page !== null && typeof page === "object" ? page : {}) as { path?: unknown; icon?: unknown; nav?: unknown };
  const nav = value.nav as RemotePageConfig["nav"] | undefined;
  return {
    path: typeof value.path === "string" ? value.path : `/remote/${id}`,
    ...(typeof value.icon === "string" ? { icon: value.icon } : {}),
    ...(nav !== undefined && typeof nav === "object" && typeof nav.group === "string" ? { nav: structuredClone(nav) } : {}),
  };
}

export const remoteModule = defineServerModule(REMOTE_MANIFEST, () => {}, {
  kinds: {
    remote: {
      validate: (instance, context) => validateInstance(instance, context),
      instances: (instances, { envFor, logger, services }) => {
        const directory = new RemoteDirectory();
        services.provide(RUNTIME_PAGES, directory);
        return instances.flatMap((instance): ProviderOffer[] => {
          const { id, url, title } = instance;
          // Config validation has checked the shape; anything else is skipped, never fatal.
          if (typeof id !== "string" || typeof url !== "string" || urlProblem(url) !== null) {
            logger.warn({ event: "remote.instance.skipped", ...(typeof id === "string" ? { id } : {}) }, "remote instance skipped");
            return [];
          }
          directory.declare(id, typeof title === "string" ? title : id, pageOf(id, instance.page));
          const instanceTiming = timing(instance);
          const instanceAuth = auth(instance.auth);
          const maxBytes = integer(instance.maxBytes);
          const describeIntervalMs = integer(instance.describeIntervalMs);
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
              ...(describeIntervalMs === undefined ? {} : { describeIntervalMs }),
            },
            directory,
          );
          return [{ provider, ...(instanceTiming ? { timing: instanceTiming } : {}) }];
        });
      },
    },
  },
});

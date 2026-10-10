import { HTTP_HEALTH_STATUS } from "@deck/contract/modules/data-sources";
import {
  defineServerModule,
  TIMING_FIELDS,
  timingProblem,
  type ConfigRuleFinding,
  type JsonObject,
  type ModuleManifest,
  type ProviderTiming,
} from "@deck/module-sdk";

import { HttpHealthProvider, type HttpHealthConfig } from "./index.js";

/**
 * The `http-health` data source: a host or service binding `{ url, method?, timing? }`
 * becomes a provider that probes the URL on every poll.
 */
export const HTTP_HEALTH_MANIFEST: ModuleManifest = {
  id: "http-health",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [
    {
      kind: "http-health",
      bindable: true,
      statusCapable: true,
      status: HTTP_HEALTH_STATUS,
      findings: [
        {
          code: "HTTP_HEALTH_TIMING_INVALID",
          severity: "error",
          summary: "An http-health binding's timing is not an object of deck's timing fields, each a whole number of milliseconds in its range.",
          fix: "Give timing only pollIntervalMs (1000 or more), ttlMs, unreachableAfterMs and timeoutMs (1 or more), each at most 2147483647; or remove it to use the defaults.",
        },
      ],
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The timing fields of a binding's `timing` object that deck's shared timing rule accepts
 * (`timingProblem`); anything else is dropped. Config validation refuses such a binding, so this
 * only guards a config that skipped it: a poll interval of 0 never reaches the scheduler.
 */
function timing(value: unknown): ProviderTiming | undefined {
  if (!isRecord(value)) return undefined;
  const resolved: ProviderTiming = {};
  for (const field of TIMING_FIELDS) if (timingProblem(field, value[field]) === null) resolved[field] = value[field] as number;
  return resolved;
}

/** What config validation reports for one http-health binding. Pure. */
function validateBinding(binding: JsonObject): ConfigRuleFinding[] {
  const raw = binding.timing;
  if (raw === undefined) return [];
  const invalid = (path: string, message: string): ConfigRuleFinding => ({ code: "HTTP_HEALTH_TIMING_INVALID", path, message });
  if (!isRecord(raw)) return [invalid("/timing", "timing must be an object of timing fields.")];
  const findings: ConfigRuleFinding[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(TIMING_FIELDS as readonly string[]).includes(key)) {
      findings.push(invalid(`/timing/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, `timing.${key} is not a timing field; use ${TIMING_FIELDS.join(", ")}.`));
      continue;
    }
    const problem = timingProblem(key as (typeof TIMING_FIELDS)[number], value);
    if (problem !== null) findings.push(invalid(`/timing/${key}`, `timing.${problem}.`));
  }
  return findings;
}

export const httpHealthModule = defineServerModule(HTTP_HEALTH_MANIFEST, () => {}, {
  kinds: {
    "http-health": {
      validateBinding,
      binding: ({ id, value }) => {
        if (typeof value.url !== "string") return [];
        const resolvedTiming = timing(value.timing);
        const config: HttpHealthConfig = {
          url: value.url,
          ...(value.method === "GET" || value.method === "HEAD" ? { method: value.method } : {}),
          ...(resolvedTiming ? { timing: resolvedTiming } : {}),
        };
        return [{ provider: new HttpHealthProvider(id, config), ...(config.timing ? { timing: config.timing } : {}) }];
      },
    },
  },
});

import { describe, expect, it } from "vitest";

import { AlertmanagerProvider, type AlertmanagerConfig } from "../../../modules/alertmanager/server/index.js";
import { PrometheusProvider, type PrometheusConfig } from "../../../modules/prometheus/server/index.js";
import { processEnv } from "./util/register-kinds.js";

/**
 * Type-level contract, checked by `tsc` (this file is in the typecheck include): naming a
 * credential requires the env reader that reads it. Each `@ts-expect-error` fails typecheck
 * if the line below it ever compiles.
 */

describe("prometheus and alertmanager provider configs", () => {
  it("require env whenever credentialEnv is set", () => {
    // @ts-expect-error credentialEnv without env
    const prometheusNoEnv: PrometheusConfig = { baseUrl: "http://prom", summaries: [], credentialEnv: "PROM_TOKEN" };
    // @ts-expect-error credentialEnv without env
    const alertmanagerNoEnv: AlertmanagerConfig = { baseUrl: "http://am", credentialEnv: "AM_TOKEN" };

    // The valid shapes: no credential (env optional), or a credential with its reader.
    const prometheus: PrometheusConfig[] = [
      { baseUrl: "http://prom", summaries: [] },
      { baseUrl: "http://prom", summaries: [], credentialEnv: "PROM_TOKEN", env: processEnv },
    ];
    const alertmanager: AlertmanagerConfig[] = [
      { baseUrl: "http://am" },
      { baseUrl: "http://am", credentialEnv: "AM_TOKEN", env: processEnv },
    ];

    expect([prometheusNoEnv, alertmanagerNoEnv]).toHaveLength(2);
    expect(prometheus.map((cfg) => new PrometheusProvider("prometheus", cfg).kind)).toEqual(["prometheus", "prometheus"]);
    expect(alertmanager.map((cfg) => new AlertmanagerProvider("alertmanager", cfg).kind)).toEqual(["alertmanager", "alertmanager"]);
  });
});

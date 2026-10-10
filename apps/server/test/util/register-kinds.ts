import type { EnvReader } from "@deck/module-sdk";

import { AlertmanagerProvider, type AlertmanagerConfig } from "../../../../modules/alertmanager/server/index.js";
import { DockerProvider, type DockerConfig } from "../../../../modules/docker/server/index.js";
import { GatusProvider, type GatusConfig } from "../../../../modules/gatus/server/index.js";
import { HttpHealthProvider, type HttpHealthConfig } from "../../../../modules/http-health/server/index.js";
import { LinkProvider, type LinkDescriptor } from "../../../../modules/link/server/index.js";
import { LINK_MANIFEST } from "../../../../modules/link/server/module.js";
import { PrometheusProvider, type PrometheusConfig } from "../../../../modules/prometheus/server/index.js";
import { register } from "../../src/providers/registry.js";

/**
 * Register one provider of a data-source module's kind straight into the kernel registry,
 * as the module's kind handler would, for tests that exercise a provider on its own.
 */

/** An env reader over the whole process env (tests only; modules get a filtered one). */
export const processEnv: EnvReader = { get: (name) => process.env[name] };

const linkIsStatic = LINK_MANIFEST.providerKinds?.find((decl) => decl.kind === "link")?.static === true;

export function registerLink(id: string, descriptor: LinkDescriptor): void {
  register(new LinkProvider(id, descriptor), undefined, undefined, { static: linkIsStatic });
}

export function registerHttpHealth(id: string, config: HttpHealthConfig): void {
  register(new HttpHealthProvider(id, config), config.timing);
}

export function registerDocker(id: string, config: DockerConfig): void {
  register(new DockerProvider(id, { env: processEnv, ...config }), config.timing);
}

export function registerGatus(id: string, config: GatusConfig): void {
  register(new GatusProvider(id, { env: processEnv, ...config }), config.timing);
}

export function registerPrometheus(id: string, config: PrometheusConfig): void {
  register(new PrometheusProvider(id, { ...config, env: config.env ?? processEnv }));
}

export function registerAlertmanager(id: string, config: AlertmanagerConfig): void {
  register(new AlertmanagerProvider(id, { ...config, env: config.env ?? processEnv }));
}

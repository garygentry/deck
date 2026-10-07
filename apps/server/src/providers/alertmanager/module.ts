import { defineServerModule, type JsonSchema, type ModuleManifest } from "@deck/module-sdk";

import { AlertmanagerProvider } from "./index.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };

/**
 * The `alertmanager` data source: the first `integrations[]` instance of kind `alertmanager`
 * becomes the provider `alertmanager`, reading active alerts and silences. The kind is not
 * bindable: a host or service binding of it is reported (`PROVIDER_BINDING_UNSUPPORTED`) and
 * ignored.
 */
export const ALERTMANAGER_MANIFEST: ModuleManifest = {
  id: "alertmanager",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [{ kind: "alertmanager", instanceSchema: instanceSchema as JsonSchema, statusCapable: false }],
};

export const alertmanagerModule = defineServerModule(ALERTMANAGER_MANIFEST, () => {}, {
  kinds: {
    alertmanager: {
      instances: ([first], { envFor }) => {
        if (first === undefined) return [];
        const config = {
          baseUrl: first.baseUrl as string,
          // Only this instance's credential: a later same-kind instance is never read.
          ...(typeof first.credentialEnv === "string"
            ? { credentialEnv: first.credentialEnv, env: envFor(first) }
            : { env: envFor(first) }),
        };
        // The web polls `alertmanager` by id: no other provider may take it.
        return [{ provider: new AlertmanagerProvider("alertmanager", config), fixedId: true }];
      },
    },
  },
});

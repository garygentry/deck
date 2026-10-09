import { BootFatalError, defineServerModule, type ModuleManifest } from "@deck/module-sdk";
import type { DeckConfigDocument } from "@deck/schema";

import { SNAPSHOT_CONTENT } from "./content.js";
import { SnapshotReadFailure } from "./errors.js";
import { SNAPSHOT_TIMING, SnapshotProvider } from "./index.js";
import { createSnapshotSource } from "./source.js";

/** The variable naming the snapshot document: a file path or an HTTP(S) URL. */
export const SNAPSHOT_SOURCE_ENV = "DECK_SNAPSHOT_SOURCE";

/**
 * The `snapshot` data source: the observed-reality snapshot named by `DECK_SNAPSHOT_SOURCE`
 * becomes the singleton provider `snapshot`, validated against the estate on every changed
 * read. It is set at deploy time, not in the estate document, so the kind has no instances
 * and is not bindable (a binding of it is reported with `PROVIDER_BINDING_UNSUPPORTED` and
 * ignored). Unset, no provider is registered. A malformed value (an unsupported protocol, an
 * empty value) fails boot; a well-formed but unreadable one registers and fails on its polls.
 * With a provider registered, the module offers the `snapshot/content` service: when the last
 * successfully read snapshot was generated, which the metrics module exposes.
 */
export const SNAPSHOT_MANIFEST: ModuleManifest = {
  id: "snapshot",
  version: "1.0.0",
  deckApi: "^0.1",
  env: [SNAPSHOT_SOURCE_ENV],
  providerKinds: [{ kind: "snapshot", fixedId: "snapshot", statusCapable: false }],
  services: { provides: [SNAPSHOT_CONTENT.name] },
};

export const snapshotModule = defineServerModule(SNAPSHOT_MANIFEST, () => {}, {
  kinds: {
    snapshot: {
      instances: (_instances, { env, estate, logger, services }) => {
        const value = env.get(SNAPSHOT_SOURCE_ENV);
        if (value === undefined) return [];
        let source;
        try {
          source = createSnapshotSource(value);
        } catch (error) {
          // The failure's message is sanitized: it never carries the configured value.
          if (error instanceof SnapshotReadFailure) throw new BootFatalError(error.message, { cause: error });
          throw error;
        }
        const config = estate as unknown as DeckConfigDocument;
        const provider = new SnapshotProvider("snapshot", { source, config, logger });
        services.provide(SNAPSHOT_CONTENT, { generatedAtMs: () => provider.generatedAtMs() });
        // The web polls `snapshot` by id: no other provider may take it.
        return [{ provider, timing: SNAPSHOT_TIMING, fixedId: true }];
      },
    },
  },
});

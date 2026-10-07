import { fileURLToPath } from "node:url";
import type { DeckConfigDocument, InvalidFixture, JsonObject, SnapshotDocument } from "../types.js";
import { base } from "./generated/primary.base.js";
import { merged } from "./generated/primary.merged.js";
import { overlay } from "./generated/primary.overlay.js";
import { combined, fresh, partial, stale, unreachable } from "./generated/primary.snapshots.js";
import { invalid as invalidManifest } from "./invalid/index.js";
import { config as minimalConfig, snapshot as minimalSnapshot } from "./minimal/estate.js";

export { benchmarkEstate } from "./benchmark.js";

const srcPath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
type SnapshotKey = "combined" | "fresh" | "stale" | "partial" | "unreachable";

export const primary: {
  base: JsonObject;
  overlay: JsonObject;
  merged: DeckConfigDocument;
  snapshots: Record<SnapshotKey, SnapshotDocument>;
  paths: { base: string; overlay: string; snapshots: Record<SnapshotKey, string> };
} = {
  base: base as unknown as JsonObject,
  overlay: overlay as unknown as JsonObject,
  merged: merged as DeckConfigDocument,
  snapshots: { combined, fresh, stale, partial, unreachable } as Record<SnapshotKey, SnapshotDocument>,
  paths: {
    base: srcPath("./primary/00-base.yaml"),
    overlay: srcPath("./primary/10-overlay.yaml"),
    snapshots: {
      combined: srcPath("./primary/snapshot.combined.json"),
      fresh: srcPath("./primary/snapshot.fresh.json"),
      stale: srcPath("./primary/snapshot.stale.json"),
      partial: srcPath("./primary/snapshot.partial.json"),
      unreachable: srcPath("./primary/snapshot.unreachable.json"),
    },
  },
};

export const minimal: { config: DeckConfigDocument; snapshot: SnapshotDocument } = { config: minimalConfig, snapshot: minimalSnapshot };
export const invalid: readonly InvalidFixture[] = invalidManifest;

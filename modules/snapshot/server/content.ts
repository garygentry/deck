import type { ServiceRef } from "@deck/module-sdk";

/**
 * What the snapshot module tells other modules about the snapshot's content, without handing
 * over the document: the `snapshot/content` service ({@link SNAPSHOT_CONTENT}).
 */
export interface SnapshotContent {
  /**
   * The `generatedAt` of the last successfully read snapshot, in epoch ms: null before the
   * first successful read, or when that snapshot's `generatedAt` is missing or unparseable.
   */
  generatedAtMs(): number | null;
}

export const SNAPSHOT_CONTENT: ServiceRef<SnapshotContent> = { name: "snapshot/content" };

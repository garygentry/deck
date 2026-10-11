import type { Source } from "@deck/schema";

import type { Provider, ProviderFetchContext, ProviderHealth } from "../../../apps/server/src/contract/index.js";
import { normalizeSourceFailure } from "../../sources/server/errors.js";
import type { SourceStore } from "../../sources/server/store.js";
import type { SourceManifest } from "../../sources/server/tree.js";

/** The provider kind of the `file-tree` data-source module. */
export const FILE_TREE_KIND = "file-tree";

/**
 * The `file-tree` provider. Byte-for-byte identical to `MarkdownTreeProvider`
 * except the class name, and the `kind` literal — the shared core (the
 * store) does all the work; the kinds differ only in which web surface consumes
 * `SourceManifest.kind` (Docs vs Configs). See `MarkdownTreeProvider` for
 * method-level docs.
 */
export class FileTreeProvider implements Provider<SourceManifest> {
  readonly kind = FILE_TREE_KIND; // ← the only divergence from MarkdownTreeProvider
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: Source,
    private readonly store: SourceStore,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(context?: ProviderFetchContext): Promise<SourceManifest> {
    try {
      const manifest = await this.store.buildManifest(context?.signal);
      this.latestHealth = {
        ok: true,
        detail:
          manifest.fileCount === 0
            ? "Acquired; 0 files after include/exclude"
            : `${manifest.fileCount} files`,
      };
      return manifest;
    } catch (cause) {
      const failure = normalizeSourceFailure(cause, { sourceId: this.id });
      this.latestHealth = { ok: false, detail: failure.message };
      throw failure;
    }
  }

  onFetchError(
    _error: unknown,
    retained: Readonly<SourceManifest> | null,
  ): SourceManifest | null {
    return retained === null ? null : { ...retained };
  }
}

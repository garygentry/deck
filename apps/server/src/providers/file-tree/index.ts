import type { Source } from "@deck/schema";

import type { Provider, ProviderFetchContext, ProviderHealth } from "../../contract/index.js";
import { normalizeSourceFailure } from "../../sources/errors.js";
import type { SourceStore } from "../../sources/store.js";
import type { SourceManifest } from "../../sources/tree.js";
import { register } from "../registry.js";

/**
 * The `file-tree` provider (REQ-SRC-02). Byte-for-byte identical to `MarkdownTreeProvider`
 * except the class name, the `kind` literal, and the factory name — the shared core (the
 * store) does all the work; the kinds differ only in which web surface consumes
 * `SourceManifest.kind` (Docs vs Configs, tech-spec §3.1). See `MarkdownTreeProvider` for
 * method-level docs.
 */
export class FileTreeProvider implements Provider<SourceManifest> {
  readonly kind = "file-tree"; // ← the only divergence from MarkdownTreeProvider
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

/** Factory — see registerMarkdownTree for the no-timing / duplicate-id / codegen-name notes. */
export function registerFileTree(id: string, cfg: Source, store: SourceStore): void {
  register(new FileTreeProvider(id, cfg, store));
}

import type { Source } from "@deck/schema";

import type { Provider, ProviderFetchContext, ProviderHealth } from "../../../apps/server/src/contract/index.js";
import { normalizeSourceFailure } from "../../sources/server/errors.js";
import type { SourceStore } from "../../sources/server/store.js";
import type { SourceManifest } from "../../sources/server/tree.js";

/** The provider kind of the `markdown-tree` data-source module. */
export const MARKDOWN_TREE_KIND = "markdown-tree";

/**
 * The `markdown-tree` provider: a thin adapter that turns a shared
 * `SourceStore` into a `Provider<SourceManifest>`. It implements ONLY the five Provider
 * members — polling, TTL, timeout, atomic envelope publish, and freshness are
 * registry-owned. All acquisition/read work lives in the store
 * (02 + 03); this class never touches the filesystem or `git` directly.
 */
export class MarkdownTreeProvider implements Provider<SourceManifest> {
  /** Literal kind — the ONLY thing that differs from FileTreeProvider. */
  readonly kind = MARKDOWN_TREE_KIND;
  /** Cached health from the last fetch(); health() returns a copy with no live I/O. */
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: Source,
    private readonly store: SourceStore,
  ) {}

  /** Cached health only (no live I/O), mirroring the HTTP providers. */
  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  /**
   * Refresh the source and produce its manifest. Delegates to
   * store.buildManifest, which acquires (git/local + atomic swap) then walks the
   * freshly-published confined root. Honors ctx.signal (the registry's per-poll
   * timeout AbortSignal). Sets latestHealth as a side effect. On failure it THROWS — the
   * registry then retains the last-good envelope and flips freshness;
   * onFetchError (below) decides data retention.
   */
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
      // Normalize to the closed-code SourceFailure; the message is credential-safe
      // and path-safe. Health detail carries no secret.
      const failure = normalizeSourceFailure(cause, { sourceId: this.id });
      this.latestHealth = { ok: false, detail: failure.message };
      throw failure;
    }
  }

  /**
   * Retain the last-good manifest on a refresh failure: returning `retained`
   * keeps the registry serving the previous tree with a stale/unreachable freshness stamp.
   * On a FIRST-EVER acquisition failure `retained` is null, so this returns null and the
   * envelope's `data` stays null → web renders the explicit error state.
   */
  onFetchError(
    _error: unknown,
    retained: Readonly<SourceManifest> | null,
  ): SourceManifest | null {
    return retained === null ? null : { ...retained };
  }
}

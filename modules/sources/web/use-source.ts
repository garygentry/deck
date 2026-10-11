/**
 * React hooks over the singleton browse store (`sources-store.ts`).
 *
 * Mirrors `use-drift-generation.ts` / `use-run.ts`: subscribe in `useEffect`, re-read once
 * after subscribing to close the render/effect race, and compare references before `setState`.
 * The hooks start no work of their own — the page owns the `client.load*` effects — so every
 * source surface shares the one lazy subscription through `useSourceBrowse`.
 */

import { useEffect, useState } from "react";
import { getSourceBrowse, subscribeSourceBrowse } from "./sources-store.js";
import type { SourceBrowseState } from "./sources-store.js";
import { loadFile, loadManifest, runSearch } from "./client.js";
import type { FileState, ManifestState, SearchState } from "./client.js";

/** Debounce for the content-search input so a keystroke burst issues one request. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * Subscribe a component to the singleton browse store; returns one atomic publication.
 *
 * The returned reference always represents one atomic store publication. Consumers re-render
 * only when the whole-reference changes.
 */
export function useSourceBrowse(): SourceBrowseState {
  const [state, setState] = useState<SourceBrowseState>(getSourceBrowse);

  useEffect(() => {
    // Compare against the component's OWN last state (`prev`), not a captured snapshot: a sibling
    // effect (e.g. the page's `selectSource`) may publish between this component's render and this
    // effect running, so the baseline must be what the component rendered with — otherwise that
    // first update is silently dropped and the component never re-renders to drive its loads.
    const sync = (): void => {
      setState((prev) => {
        const next = getSourceBrowse();
        return prev === next ? prev : next;
      });
    };
    const unsubscribe = subscribeSourceBrowse(sync);
    // Re-read once after subscribing to close the render/effect race without starting any
    // independent work.
    sync();
    return unsubscribe;
  }, []);

  return state;
}

/** The active source's manifest+freshness slice — a thin selector over {@link useSourceBrowse}. */
export function useSourceManifest(): ManifestState {
  return useSourceBrowse().manifest;
}

/** The selected file/document read slice — a thin selector over {@link useSourceBrowse}. */
export function useSelectedFile(): FileState {
  return useSourceBrowse().file;
}

/** The server content-search slice — a thin selector over {@link useSourceBrowse}. */
export function useSourceSearch(): SearchState {
  return useSourceBrowse().search;
}

// ---------------------------------------------------------------------------
// Load-driving effects. The only places `client.load*` is called from a source
// surface. Each cancels the prior in-flight load via an `AbortController` when its key changes, so
// a stale response can never clobber a newer selection (belt-and-braces with the store guards).
// ---------------------------------------------------------------------------

/**
 * Load the manifest whenever the active source id changes; no-op when null. Bumping `attempt`
 * reloads the same source (the error state's Retry).
 */
export function useManifestLoad(id: string | null, attempt = 0): void {
  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController();
    void loadManifest(id, controller.signal);
    return () => controller.abort();
  }, [id, attempt]);
}

/** Load the selected file whenever the source id or selected path changes; no-op when either is null. */
export function useFileLoad(id: string | null, path: string | null): void {
  useEffect(() => {
    if (id === null || path === null) return;
    const controller = new AbortController();
    void loadFile(id, path, controller.signal);
    return () => controller.abort();
  }, [id, path]);
}

/** Run a debounced server search whenever the source id or query changes; no-op when id is null. */
export function useSearchLoad(id: string | null, query: string): void {
  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      void runSearch(id, query, controller.signal);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [id, query]);
}

/**
 * Module-singleton browse state for the sources feature (Docs + Configs).
 *
 * Mirrors `modules/drift/web/store.ts` and `modules/actions/web/run-store.ts`: a
 * module-scoped `Object.freeze`d state value replaced atomically, a `Set` of listener records,
 * an isolating `notify()` that iterates a **copy** and swallows a throwing listener, a
 * `getSourceBrowse()` snapshot reader, and a `subscribeSourceBrowse(listener) => () => void`
 * returning an idempotent unsubscribe.
 *
 * It holds **no HTTP logic** — that lives in `client.ts`. The UI-selection mutators
 * (`selectSource`/`selectPath`/`setFilter`/`resetBrowse`) are written by the page; the
 * network-derived mutators (`setManifest`/`setFile`/`setSearch`) are written **only** by the
 * client's `load*` wrappers (a later item), which is why each carries a stale-response guard.
 *
 * The SPA mounts only one page at a time, so this singleton models the single active browsing
 * session; a page calls `resetBrowse()` / `selectSource()` on mount to clear the other page's
 * stale session.
 */

import type { FileState, ManifestState, SearchState } from "./client.js";

/**
 * The one active browsing session (Docs or Configs). A frozen value replaced atomically on
 * each mutation. `manifest`/`file`/`search` are the network-derived slices written only by
 * `client.ts`; `activeSourceId`/`selectedPath`/`filter` are UI selection written by the page.
 */
export interface SourceBrowseState {
  /** The source currently in view (from the switcher / URL query), or null before selection. */
  readonly activeSourceId: string | null;
  /** Manifest+freshness of the active source. "loading" before the first load. */
  readonly manifest: ManifestState;
  /** The selected file/document path (POSIX, relative to root), or null when none is open. */
  readonly selectedPath: string | null;
  /** Read state of the selected path. */
  readonly file: FileState;
  /** Live client-side tree filter text; "" ⇒ no filter. */
  readonly filter: string;
  /** Server content-search state. */
  readonly search: SearchState;
}

/** The initial and reset browse state: nothing selected, manifest awaiting its first load. */
export const INITIAL_BROWSE_STATE: SourceBrowseState = Object.freeze({
  activeSourceId: null,
  manifest: { status: "loading" as const },
  selectedPath: null,
  file: { status: "idle" as const },
  filter: "",
  search: { status: "idle" as const },
});

// ---------------------------------------------------------------------------
// Module-scoped singleton state.
// A single frozen object replaced atomically; the page and client.ts are the only
// writers, through the exported mutators below.
// ---------------------------------------------------------------------------

let state: SourceBrowseState = INITIAL_BROWSE_STATE;

const listeners = new Set<{ readonly listener: () => void }>();

/**
 * Notify every currently-registered subscriber from a stable snapshot. One listener throwing
 * must not stop later subscribers; the caught value is discarded and never logged.
 */
function notify(): void {
  for (const record of [...listeners]) {
    try {
      record.listener();
    } catch {
      // Isolate a faulty surface or unmount race from other subscribers.
    }
  }
}

/** Read the current frozen browse-state reference. */
export function getSourceBrowse(): SourceBrowseState {
  return state;
}

/**
 * Subscribe to whole-reference browse-state changes (drift-store pattern). The listener is a
 * synchronous invalidation callback; consumers re-read with `getSourceBrowse()`.
 *
 * @returns An idempotent unsubscribe function.
 */
export function subscribeSourceBrowse(listener: () => void): () => void {
  const record = { listener };
  listeners.add(record);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(record);
  };
}

/** Extract the path a `FileState` pertains to, or null when it carries none ("idle"). */
function fileStatePath(fileState: FileState): string | null {
  switch (fileState.status) {
    case "idle":
      return null;
    case "loading":
    case "error":
      return fileState.path;
    case "ready":
      return fileState.result.path;
  }
}

/** Extract the query a `SearchState` pertains to, or null when it carries none. */
function searchStateQuery(searchState: SearchState): string | null {
  switch (searchState.status) {
    case "idle":
    case "ready":
      return null;
    case "loading":
    case "error":
      return searchState.query;
  }
}

// ---------------------------------------------------------------------------
// UI-selection mutators (called by the page).
// ---------------------------------------------------------------------------

/**
 * Reset to a clean session for a given source id (called on page mount / source switch): set
 * `activeSourceId`, clear `selectedPath`/`file`/`filter`/`search`, and set `manifest` to
 * "loading" so the load hook fetches it fresh.
 */
export function selectSource(id: string): void {
  state = Object.freeze({
    activeSourceId: id,
    manifest: { status: "loading" as const },
    selectedPath: null,
    file: { status: "idle" as const },
    filter: "",
    search: { status: "idle" as const },
  });
  notify();
}

/**
 * Select a file/document node: set `selectedPath` and `file` to "loading" for that path. The
 * client's file-load wrapper follows and publishes the resolved `FileState` via `setFile`.
 */
export function selectPath(path: string): void {
  if (state.selectedPath === path && state.file.status === "loading") return;
  state = Object.freeze({
    ...state,
    selectedPath: path,
    file: { status: "loading" as const, path },
  });
  notify();
}

/** Update the live tree-filter text. Pure UI selection; triggers no fetch. */
export function setFilter(text: string): void {
  if (state.filter === text) return;
  state = Object.freeze({ ...state, filter: text });
  notify();
}

/** Clear any prior session (called on unmount / route change): back to the initial state. */
export function resetBrowse(): void {
  if (state === INITIAL_BROWSE_STATE) return;
  state = INITIAL_BROWSE_STATE;
  notify();
}

// ---------------------------------------------------------------------------
// Network-derived mutators (called ONLY by client.ts).
// Each carries a stale-response guard so a slow earlier response can never overwrite a newer
// selection — this closes the render/effect/async race.
// ---------------------------------------------------------------------------

/** Publish the manifest state for `id`; ignored when `id` is not the active source (stale). */
export function setManifest(id: string, manifest: ManifestState): void {
  if (id !== state.activeSourceId) return;
  state = Object.freeze({ ...state, manifest });
  notify();
}

/**
 * Publish the file state; ignored unless it matches the current `selectedPath` (an "idle" state
 * always applies, since it clears the selection). Guards a stale earlier file response.
 */
export function setFile(file: FileState): void {
  const path = fileStatePath(file);
  if (path !== null && path !== state.selectedPath) return;
  state = Object.freeze({ ...state, file });
  notify();
}

/**
 * Publish the search state, guarding a stale earlier search response. A "loading" state always
 * applies and establishes the latest requested query; an "error" whose query no longer matches
 * that in-flight query is dropped so a superseded response cannot clobber a newer one.
 */
export function setSearch(search: SearchState): void {
  if (search.status === "error") {
    const inFlightQuery = searchStateQuery(state.search);
    if (inFlightQuery !== null && search.query !== inFlightQuery) return;
  }
  state = Object.freeze({ ...state, search });
  notify();
}

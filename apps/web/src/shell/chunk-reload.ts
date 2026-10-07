/**
 * Recover from a stale code-split chunk. After a deck upgrade, an open tab still
 * requests the old hashed chunk names; the server answers them with index.html,
 * so the dynamic import fails. React caches a failed `lazy` import, so neither
 * Retry nor navigating away and back can recover it: only a fresh document can.
 *
 * Vite dispatches `vite:preloadError` for a failed dynamic import or preload.
 * Reload once; if the reload itself hits the same failure soon after (the
 * server is down, not upgraded), let the error reach the page error boundary
 * instead of looping.
 */

const KEY = "deck:chunk-reload-at";
const WINDOW_MS = 10_000;

export function installChunkReload(win: Window = window): void {
  win.addEventListener("vite:preloadError", (event) => {
    const now = Date.now();
    let last = 0;
    try {
      last = Number(win.sessionStorage.getItem(KEY)) || 0;
      win.sessionStorage.setItem(KEY, String(now));
    } catch {
      // Storage blocked: reloading without a guard could loop, so don't.
      return;
    }
    if (now - last < WINDOW_MS) return;
    event.preventDefault();
    win.location.reload();
  });
}

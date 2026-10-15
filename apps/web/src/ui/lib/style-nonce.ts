import { readStyleNonce } from "@deck/contract";
import { setNonce } from "get-nonce";

/**
 * The page's style nonce. The shell's Content-Security-Policy allows a `<style>` element only
 * when it carries this nonce (and no `style` attribute in markup at all), so every `<style>` the
 * UI library injects must carry it: the scroll lock behind modal overlays (react-remove-scroll,
 * which reads it through `get-nonce`), and the scrollbar rules of the scroll area's and the
 * select list's viewports (Radix renders those with the `nonce` prop the primitives pass).
 * Styles set through the CSSOM (`element.style`, as React and overlay positioning do) need none.
 *
 * `undefined` where the page carries no nonce: the dev server and tests, which send no policy.
 */
let nonce: string | null | undefined = null;

/** The page's style nonce, read once from the document; `undefined` when it carries none. */
export function styleNonce(): string | undefined {
  if (nonce === null) nonce = typeof document === "undefined" ? undefined : readStyleNonce(document);
  return nonce;
}

/** Hand the page's style nonce to the libraries that read it globally. Call once, before the first render. */
export function installStyleNonce(): void {
  const value = styleNonce();
  if (value !== undefined) setNonce(value);
}

/**
 * Shared render helpers for unit tests.
 *
 * - `renderHtml` renders an element to a static HTML string (no hydration
 *   markers) for string-level assertions.
 * - `mount` renders an element into a DOM container synchronously, flushing
 *   effects through `act`. Passing `null` unmounts whatever is mounted in the
 *   container, so a test can call `mount(null, container)` in teardown.
 *
 * New tests should prefer Testing Library (`@testing-library/react`) role and
 * text queries over HTML-string assertions.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

export { act };

export function renderHtml(element: ReactNode): string {
  return renderToStaticMarkup(element);
}

const roots = new WeakMap<Element | DocumentFragment, Root>();

export function mount(element: ReactNode, container: Element | DocumentFragment): void {
  let root = roots.get(container);
  if (element === null) {
    if (root) {
      act(() => root!.unmount());
      roots.delete(container);
    }
    return;
  }
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  const active = root;
  act(() => active.render(element));
}

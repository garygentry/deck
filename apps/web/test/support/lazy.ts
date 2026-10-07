import type { ComponentType } from "react";

interface LazyComponent {
  $$typeof: symbol;
  _payload: unknown;
  _init: (payload: unknown) => unknown;
}

/**
 * The component a registration renders: a plain component as-is, or the
 * module export a `React.lazy` wrapper resolves to (pages load lazily). Uses
 * React's lazy protocol: `_init` throws the pending promise until it settles.
 */
export async function resolveComponent(component: unknown): Promise<ComponentType<never>> {
  if (typeof component === "function") return component as ComponentType<never>;
  const lazy = component as LazyComponent;
  for (;;) {
    try {
      return lazy._init(lazy._payload) as ComponentType<never>;
    } catch (thrown) {
      if (thrown instanceof Promise || typeof (thrown as PromiseLike<unknown>)?.then === "function") {
        await thrown;
      } else {
        throw thrown;
      }
    }
  }
}

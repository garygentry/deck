import type { UiManifest } from "@deck/module-sdk";

import type { Extension } from "../../src/registry/registry.js";

/**
 * A UI manifest that places exactly `extensions`, at their registered slots and orders, as
 * `/api/ui` would for modules that are all on. Seed it with
 * `getQueryClient().setQueryData(queryKeys.uiManifest, …)` for slot hosts under test.
 */
export function manifestPlacing(extensions: readonly Extension[]): UiManifest {
  return {
    uiApi: 1,
    brand: { title: "Deck" },
    modules: [],
    slots: [],
    pages: [],
    navGroups: [],
    nav: [],
    providers: [],
    findings: [],
    extensions: extensions
      .filter(({ kind, enabled }) => kind !== "page" && kind !== "nav" && enabled)
      .map(({ id, kind, module, attachTo }) => ({ id, kind, module, slot: attachTo.slot, order: attachTo.order })),
  };
}

import type { JsonObject, UiManifest } from "@deck/module-sdk";

import type { Extension } from "../../src/registry/registry.js";

/**
 * A UI manifest that places exactly `extensions`, at their registered slots and orders, as
 * `/api/ui` would for modules that are all on (with their registered config as the resolved one). Seed it with
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
      .map(({ id, kind, module, attachTo, config }) => ({
        id,
        kind,
        module,
        slot: attachTo.slot,
        order: attachTo.order,
        ...(Object.keys(config).length === 0 ? {} : { config: config as JsonObject }),
      })),
  };
}

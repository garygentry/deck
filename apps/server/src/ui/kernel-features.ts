import { CORE_WIDGET_TYPES, SHELL_SLOTS } from "@deck/contract/modules/core";
import { DECK_API_VERSION, type ModuleManifest } from "@deck/module-sdk";

/**
 * UI contributions of features still wired into the kernel, so the UI manifest lists every
 * page, nav entry, slot and extension today. Each entry is the `contributes` block its
 * feature's `module.ts` will declare once the feature becomes a module; the module then
 * takes precedence and the entry here is deleted.
 */
export interface KernelFeature {
  manifest: ModuleManifest;
  /** A kernel capability the feature needs; without it the feature is disabled. */
  requires?: string;
}

// The kernel-reserved slots are shared with the web registry, which declares them all.
export { SHELL_SLOTS };

function feature(id: string, contributes: ModuleManifest["contributes"], requires?: string): KernelFeature {
  return {
    manifest: { id, version: DECK_API_VERSION, deckApi: `^${DECK_API_VERSION}`, contributes },
    ...(requires === undefined ? {} : { requires }),
  };
}

export const KERNEL_FEATURES: readonly KernelFeature[] = [
  feature("core", {
    slots: [...SHELL_SLOTS],
    // The shell's own top-bar control, an extension like any other so config can move it.
    extensions: [
      { id: "action:core/theme-menu", kind: "action", attachTo: { slot: "app/topbar.actions" }, component: "ThemeMenu" },
    ],
    // The kernel's own widget types, which config pages may use.
    widgetTypes: [...CORE_WIDGET_TYPES],
  }),
];

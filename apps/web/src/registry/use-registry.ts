import { useMemo, useSyncExternalStore } from "react";
import { getExtensions, getRegistryVersion, subscribeRegistry, type Extension } from "./registry.js";

/**
 * The registry's version, re-rendering the caller whenever an extension is registered. Slot
 * hosts read their blueprint view (`getPages`, `getCards`, …) after calling it, so a late
 * registration (a lazily loaded module) shows up without a reload.
 */
export function useRegistryVersion(): number {
  return useSyncExternalStore(subscribeRegistry, getRegistryVersion, getRegistryVersion);
}

/** The enabled extensions attached to `slot`, by order then id; stable between registrations. */
export function useSlot(slot: string): readonly Extension[] {
  const version = useRegistryVersion();
  // `version` is the change signal: the memo re-reads the slot after every registration.
  return useMemo(() => getExtensions(slot), [slot, version]);
}

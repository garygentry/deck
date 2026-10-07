import { POLL_DEFAULTS } from "@deck/server";
import type { ReactNode, JSX } from "react";
import { createContext } from "react";
import { useContext, useEffect, useState } from "react";
import {
  getInventoryGeneration,
  subscribeInventoryGenerationAtInterval,
} from "./inventory-store.js";
import type { InventoryData } from "./inventory-store.js";

// The singleton store owns polling, decode classification, immutable publication,
// and browser-local generation numbering. This module remains the authoritative
// compatibility home for the inventory hook, provider, and context: it re-exports
// the store-owned value/type surface and adds only the React adapters.
export {
  INVENTORY_ENDPOINTS,
  INITIAL_SNAPSHOT_ENVELOPE,
} from "./inventory-store.js";
export type {
  InventoryData,
  InventoryGeneration,
  SnapshotClientState,
} from "./inventory-store.js";

/** Programmer error raised when a child reads inventory data outside its provider. */
export class InventoryContextError extends Error {
  readonly name = "InventoryContextError";
  readonly code = "INVENTORY_CONTEXT_MISSING" as const;

  constructor() {
    super("Inventory data context is unavailable.");
  }
}

/** Nullable default prevents a missing provider from masquerading as valid inventory data. */
export const InventoryDataContext = createContext<InventoryData | null>(null);

export interface InventoryDataProviderProps {
  children: ReactNode;
  intervalMs?: number;
}

/**
 * Subscribe to the shared inventory generation using the legacy interval option.
 * The hook owns no timer or `AbortController`; the singleton store owns network
 * lifetime. A store refresh failure is represented by the store's `transientError`
 * while the inherited `InventoryData` fields remain the last accepted bundle.
 *
 * @param intervalMs - Positive finite interval. Simultaneous subscribers must agree.
 * @returns The current generation narrowed to the existing `InventoryData` contract.
 * @throws {RangeError} If `intervalMs` is non-finite or not greater than zero.
 * @throws {RangeError} If another active subscriber owns a different interval.
 */
export function useInventoryData(
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): InventoryData {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive finite number.");
  }

  const [data, setData] = useState<InventoryData>(getInventoryGeneration);

  useEffect(() => {
    let seen = getInventoryGeneration();
    const sync = (): void => {
      const next = getInventoryGeneration();
      if (next !== seen) {
        seen = next;
        setData(next);
      }
    };
    const unsubscribe = subscribeInventoryGenerationAtInterval(sync, intervalMs);
    // Re-read immediately after subscribing to close the render/effect race.
    sync();
    return unsubscribe;
  }, [intervalMs]);

  return data;
}

/** Start/reuse the singleton poll and provide its current compatible value. */
export function InventoryDataProvider(
  props: InventoryDataProviderProps,
): JSX.Element {
  const data = useInventoryData(props.intervalMs);
  return (
    <InventoryDataContext.Provider value={data}>
      {props.children}
    </InventoryDataContext.Provider>
  );
}

/**
 * Read the nearest page-owned aggregate inventory context.
 *
 * @throws {InventoryContextError} If no `InventoryDataProvider` is mounted.
 */
export function useInventoryDataContext(): InventoryData {
  const data = useContext(InventoryDataContext);
  if (data === null) throw new InventoryContextError();
  return data;
}

import { useEffect, useState } from "react";
import { getDriftGeneration, subscribeDriftGeneration } from "./store.js";
import type { DriftGenerationState } from "./store.js";

/**
 * Subscribe a React component to the singleton drift generation store.
 *
 * The returned reference always represents one atomic store publication. The hook
 * starts no poll and performs no projection derivation; every drift surface shares
 * one lazy store subscription through it.
 *
 * @returns Current inventory status, matching accepted drift bundle, and safe
 * derivation failure state.
 */
export function useDriftGeneration(): DriftGenerationState {
  const [state, setState] = useState<DriftGenerationState>(getDriftGeneration);

  useEffect(() => {
    let seen = getDriftGeneration();
    const sync = (): void => {
      const next = getDriftGeneration();
      if (next !== seen) {
        seen = next;
        setState(next);
      }
    };
    const unsubscribe = subscribeDriftGeneration(sync);
    // Re-read once after subscribing to close the render/effect race without
    // starting any independent work.
    sync();
    return unsubscribe;
  }, []);

  return state;
}

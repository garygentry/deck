import { useEffect, useState } from "react";
import { getRunState, subscribeRunState } from "./run-store.js";
import type { RunState } from "./run-store.js";

/**
 * Subscribe a React component to the singleton run store.
 *
 * The returned reference always represents one atomic store publication. The hook
 * starts no work of its own; every run surface shares the one lazy subscription
 * through it. Mirrors `use-drift-generation.ts` (subscribe in `useEffect`, re-read
 * once after subscribing to close the render/effect race, compare references before
 * `setState`).
 *
 * @returns The current run-state reference.
 */
export function useRun(): RunState {
  const [state, setState] = useState<RunState>(getRunState);

  useEffect(() => {
    let seen = getRunState();
    const sync = (): void => {
      const next = getRunState();
      if (next !== seen) {
        seen = next;
        setState(next);
      }
    };
    const unsubscribe = subscribeRunState(sync);
    // Re-read once after subscribing to close the render/effect race without
    // starting any independent work.
    sync();
    return unsubscribe;
  }, []);

  return state;
}

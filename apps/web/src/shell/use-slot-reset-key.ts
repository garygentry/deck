import { POLL_DEFAULTS } from "@deck/contract";
import { useNow } from "@/ui";
import { useLocation } from "./router.js";

/**
 * A reset key that changes on every provider poll tick: a slot host's boundary keyed by it
 * gives an extension that threw another try once its data may have recovered, without
 * remounting healthy ones. For hosts that persist across routes (the top bar).
 */
export function usePollResetKey(intervalMs: number = POLL_DEFAULTS.pollIntervalMs): number {
  return Math.floor(useNow(intervalMs) / intervalMs);
}

/** The reset key for a page's slot host: the current path plus the poll tick. */
export function useSlotResetKey(intervalMs: number = POLL_DEFAULTS.pollIntervalMs): string {
  const { path } = useLocation();
  return `${path}#${usePollResetKey(intervalMs)}`;
}

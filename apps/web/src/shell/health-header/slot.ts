import { defineSummarySlot } from "../../registry/registry.js";
import type { HealthSummary } from "./health-summary.js";

/**
 * The single `health-header` slot declaration. Declared once, by the
 * shell — `main.tsx` imports this module before `registry/discover.ts` so the slot
 * exists before any feature fills it (else `UNKNOWN_SLOT`). A second declaration
 * anywhere would throw `DUPLICATE_SLOT`.
 */
export const HealthHeaderSlot = defineSummarySlot<HealthSummary>({
  slotId: "health-header",
});

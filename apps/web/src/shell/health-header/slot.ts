import { summarySlot } from "../../registry/registry.js";
import type { HealthSummary } from "./health-summary.js";

/**
 * The top bar's status slot (`app/topbar.status`), rendered by the health-header region. The
 * registry declares it with every other core slot; this is the handle that types its pills'
 * payload as {@link HealthSummary}.
 */
export const HealthHeaderSlot = summarySlot<HealthSummary>("app/topbar.status");

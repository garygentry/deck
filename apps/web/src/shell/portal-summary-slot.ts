import { defineSlot } from "../registry/registry.js";

/**
 * Widget slot rendered on the portal page under its header, above the filters, hosted by the
 * portal. Features register summary cards here with `registerCard({ slot: PORTAL_SUMMARY_SLOT, … })`;
 * a card that has nothing to show renders nothing, leaving the portal unchanged.
 */
export const PORTAL_SUMMARY_SLOT = defineSlot({ id: "portal/summary", accepts: "widget", module: "portal" }).id;

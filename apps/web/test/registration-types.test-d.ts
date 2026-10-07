import type { ComponentType } from "react";
import { defineSummarySlot, registerSummaryFragment } from "../src/registry/registry.js";

interface HealthSummary {
  label: string;
}

const slot = defineSummarySlot<HealthSummary>({ slotId: "health" });
const WrongComponent: ComponentType<{ count: number }> = () => null;

// @ts-expect-error The summary slot token fixes the component payload type.
registerSummaryFragment(slot, { id: "wrong", component: WrongComponent });

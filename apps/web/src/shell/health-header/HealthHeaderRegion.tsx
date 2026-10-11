import type { ComponentType, JSX } from "react";
import { FragmentBoundary } from "@/ui";
import { useManifestSlot } from "../manifest-slot.js";
import { usePollResetKey } from "../use-slot-reset-key.js";
import { HealthHeaderSlot } from "./slot.js";

/**
 * The persistent HealthHeader region, the `app/topbar.status` slot. Renders an UNCONDITIONAL
 * `<div data-slot="health-header">` — present on every route even with zero
 * fragments — wrapping each self-sufficient summary fragment rendered with NO
 * props, each isolated so one that throws cannot blank the header. Which pills render,
 * and in what order, is the UI manifest's. Mounted by the `Topbar` inside the global
 * `<header>`.
 */
export function HealthHeaderRegion(): JSX.Element {
  const pills = useManifestSlot(HealthHeaderSlot.slotId);
  // The header persists across routes: a pill that threw tries again at the next poll.
  const resetKey = usePollResetKey();
  return (
    <div data-slot="health-header" className="flex min-w-0 items-center gap-1.5">
      {pills.map((fragment) => {
        const Fragment = fragment.component as ComponentType;
        return (
          <FragmentBoundary key={fragment.id} label="Status summary" resetKey={resetKey}>
            <Fragment />
          </FragmentBoundary>
        );
      })}
    </div>
  );
}

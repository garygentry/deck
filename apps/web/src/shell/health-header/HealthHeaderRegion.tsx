import type { ComponentType, JSX } from "react";
import { getSummaryFragments } from "../../registry/registry.js";
import { HealthHeaderSlot } from "./slot.js";

/**
 * The persistent HealthHeader region. Renders an UNCONDITIONAL
 * `<div data-slot="health-header">` — present on every route even with zero
 * fragments — wrapping each self-sufficient summary fragment rendered with NO
 * props. Mounted by `App.tsx` inside the global `<header>`.
 */
export function HealthHeaderRegion(): JSX.Element {
  return (
    <div data-slot="health-header" className="flex min-w-0 items-center gap-1.5">
      {getSummaryFragments(HealthHeaderSlot).map((fragment) => {
        const Fragment = fragment.component as ComponentType;
        return <Fragment key={fragment.id} />;
      })}
    </div>
  );
}

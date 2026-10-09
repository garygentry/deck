import type { ComponentType } from "react";
import { EmptyState, FragmentBoundary } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";
import { HealthHeaderSlot } from "../../shell/health-header/slot.js";
import { useManifestSlot } from "../../shell/manifest-slot.js";
import { usePollResetKey } from "../../shell/use-slot-reset-key.js";

/**
 * `core/health-pills`: the top bar's health pills (`app/topbar.status`, as the UI manifest
 * places them), on a dashboard. `options.pills` picks some by id, in the top bar's order. Each
 * pill reads its own data, so the widget reads no source.
 */
export function HealthPillsWidget({ options }: WidgetProps<{ pills?: string[] }>) {
  const placed = useManifestSlot(HealthHeaderSlot.slotId);
  const resetKey = usePollResetKey();
  const pills = options.pills === undefined ? placed : placed.filter((pill) => options.pills!.includes(pill.id));
  if (pills.length === 0) return <EmptyState compact title="No health pills to show" />;
  return (
    <div data-slot="health-pills" className="flex flex-wrap items-center gap-2">
      {pills.map((pill) => {
        const Pill = pill.component as ComponentType;
        return (
          <FragmentBoundary key={pill.id} label="Status summary" resetKey={resetKey}>
            <Pill />
          </FragmentBoundary>
        );
      })}
    </div>
  );
}

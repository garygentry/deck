import { DRIFT_UI } from "@deck/contract/modules/drift";
import { defineWebModule } from "@deck/module-sdk";
import type { ComponentType } from "react";

import type { EntityFragmentRegistration } from "../../registry/registry.js";
import { registerWebModule } from "../../registry/web-module.js";
import type { HealthSummary } from "../../shell/health-header/health-summary.js";
import { DriftHealthSummary } from "./DriftHealthSummary.js";
import { DriftPage, FindingsFragment } from "./pages.js";

// Where each component attaches (the page's path, the pill's slot, the findings sections' slots,
// order and config) is the drift module's manifest data; the UI manifest decides at runtime what
// renders. Every surface reads the shared drift generation store; none polls or derives on its own.
export const driftWebModule = defineWebModule(DRIFT_UI, {
  // The pill keeps the health-header slot's component contract, the findings sections the entity
  // sections' one.
  components: { DriftPage, DriftHealthSummary, FindingsFragment } satisfies {
    DriftPage: ComponentType;
    DriftHealthSummary: ComponentType<HealthSummary>;
    FindingsFragment: EntityFragmentRegistration["component"];
  },
});

// Registration errors are deliberately uncaught: eager discovery fails loudly rather than drop a surface.
registerWebModule(driftWebModule);

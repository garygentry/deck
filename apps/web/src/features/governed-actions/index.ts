import { ACTIONS_UI } from "@deck/contract/modules/actions";
import { defineWebModule } from "@deck/module-sdk";
import type { ComponentType } from "react";

import { registerWebModule } from "../../registry/web-module.js";
import { ActionsPage } from "./pages.js";

// Where the Actions page routes and which nav group lists it are the actions module's manifest
// data; the UI manifest decides at runtime what renders. It is a standalone page: no cards,
// entity sections or pills, so it attaches to no shell slot.
export const actionsWebModule = defineWebModule(ACTIONS_UI, {
  components: { ActionsPage } satisfies { ActionsPage: ComponentType },
});

registerWebModule(actionsWebModule);

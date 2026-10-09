import { CORE_WIDGET_TYPES } from "@deck/contract/modules/core";
import { DECK_API_VERSION, defineWebModule } from "@deck/module-sdk";

import { registerWebModule } from "../../registry/web-module.js";
import { JsonWidget } from "./JsonWidget.js";

// The kernel's own widget types (`core/…`), which config pages place like any module's.
export const coreWidgetsWebModule = defineWebModule(
  { id: "core", version: DECK_API_VERSION, deckApi: `^${DECK_API_VERSION}`, contributes: { widgetTypes: [...CORE_WIDGET_TYPES] } },
  { components: { JsonWidget } },
);

registerWebModule(coreWidgetsWebModule);

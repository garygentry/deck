import { CORE_WIDGET_TYPES } from "@deck/contract/modules/core";
import { DECK_API_VERSION, defineWebModule } from "@deck/module-sdk";
import { lazy } from "react";

import { registerWebModule } from "../../registry/web-module.js";
import { HealthPillsWidget } from "./HealthPillsWidget.js";
import { JsonWidget } from "./JsonWidget.js";
import { LinkTilesWidget, ListWidget, StatusGridWidget } from "./ListWidgets.js";
import { KeyValueWidget, MeterWidget, StatGridWidget, StatWidget } from "./ValueWidgets.js";

// Heavy widgets load on first use, so TanStack Table and the markdown pipeline (markdown-it,
// DOMPurify, highlight.js) stay out of the main bundle; WidgetHost suspends meanwhile.
const TableWidget = lazy(() => import("./TableWidget.js"));
const MarkdownWidget = lazy(() => import("./MarkdownWidget.js"));

// The kernel's own widget types (`core/…`), which config pages place like any module's.
export const coreWidgetsWebModule = defineWebModule(
  { id: "core", version: DECK_API_VERSION, deckApi: `^${DECK_API_VERSION}`, contributes: { widgetTypes: [...CORE_WIDGET_TYPES] } },
  {
    components: {
      StatWidget,
      StatGridWidget,
      MeterWidget,
      KeyValueWidget,
      ListWidget,
      TableWidget,
      StatusGridWidget,
      LinkTilesWidget,
      MarkdownWidget,
      HealthPillsWidget,
      JsonWidget,
    },
  },
);

registerWebModule(coreWidgetsWebModule);

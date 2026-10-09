import type { ComposedConfig } from "../../compose/compose.js";
import { finding, type Finding } from "../../findings.js";
import type { DeckConfigDocument } from "../../types.js";

/**
 * Check the widgets of config pages (`ui.pages[].sections[].widgets[]`) beyond their shape:
 * - a type no contribution declares (UI_WIDGET_TYPE_UNKNOWN, a warning), or that only a module
 *   that is not running declares (UI_WIDGET_TYPE_DISABLED: info unless `strict`, so an off
 *   module never fails boot); either widget renders as unavailable;
 * - a `select` that is not a JMESPath expression (UI_WIDGET_SELECT_INVALID), when composition
 *   was given the check;
 * - a widget id used twice on one page (ID_DUPLICATE), over every widget's resolved id: its
 *   `id`, else its positional `s<N>w<M>` (which the schema keeps an explicit id from taking).
 *   It names the widget's extension id, `widget:ui/<page>.<id>`.
 * A widget's options are checked by the composed schema, against its type's options schema.
 */
export function uiWidgets(
  doc: DeckConfigDocument,
  composed: Pick<ComposedConfig, "widgetTypes" | "disabledWidgetTypes" | "selectProblem">,
  strict: boolean,
): Finding[] {
  const findings: Finding[] = [];
  for (const [pageIndex, page] of (doc.ui?.pages ?? []).entries()) {
    const ids = new Set<string>();
    for (const [sectionIndex, section] of (page.sections ?? []).entries()) {
      for (const [widgetIndex, widget] of (section.widgets ?? []).entries()) {
        const path = `/ui/pages/${pageIndex}/sections/${sectionIndex}/widgets/${widgetIndex}`;
        // Its id as resolved: the explicit one, else positional (a form an explicit id may not take).
        const id = widget.id ?? `s${sectionIndex + 1}w${widgetIndex + 1}`;
        if (ids.has(id)) {
          findings.push(finding("ID_DUPLICATE", path, `Widget id ${JSON.stringify(id)} is used more than once on page ${JSON.stringify(page.id)}.`));
        }
        ids.add(id);
        if (!composed.widgetTypes.has(widget.type)) {
          const owner = composed.disabledWidgetTypes.get(widget.type);
          if (owner === undefined) {
            findings.push(finding(
              "UI_WIDGET_TYPE_UNKNOWN",
              `${path}/type`,
              `widget type '${widget.type}' is not provided by any module; the widget renders as unavailable`,
              "Use a widget type a module provides, or install the module that provides it.",
            ));
          } else {
            const disabled = finding(
              "UI_WIDGET_TYPE_DISABLED",
              `${path}/type`,
              `widget type '${widget.type}' is provided by module "${owner}", which is not enabled; the widget renders as unavailable`,
              `Enable or fix module "${owner}", or remove the widget.`,
            );
            findings.push(strict ? disabled : { ...disabled, severity: "info" });
          }
        }
        const problem = widget.select === undefined ? null : composed.selectProblem?.(widget.select) ?? null;
        if (problem !== null) {
          findings.push(finding("UI_WIDGET_SELECT_INVALID", `${path}/select`, `select is not a JMESPath expression: ${problem}`));
        }
      }
    }
  }
  return findings;
}

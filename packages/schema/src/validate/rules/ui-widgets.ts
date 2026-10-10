import type { ComposedConfig } from "../../compose/compose.js";
import { finding, type Finding } from "../../findings.js";
import { embedUrlProblem, frameOriginOf } from "../../embed.js";
import type { DeckConfigDocument, ValidateLayer } from "../../types.js";

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
 * - a `statusMap` a core widget's options name (at any depth: a table column's, a stat-grid
 *   item's) that `ui.statusMaps` does not declare (UI_STATUS_MAP_UNKNOWN, a warning); the widget
 *   shows those values without a tone.
 * - a `core/embed` widget while `ui.allowUnsafeEmbeds` is not `true` (UI_EMBED_DISALLOWED, info:
 *   the widget shows that embeds are off), on the merged document only, since the gate and the
 *   widget may sit in different layers;
 * - a `core/embed` url the URL parser refuses, or that carries user:password@
 *   (UI_EMBED_URL_INVALID, an error), on the merged document: the same check the web makes
 *   before it frames anything (the options schema checks only the url's loose shape);
 * - while embeds are on, a valid `core/embed` url whose origin no Content-Security-Policy can
 *   name (UI_EMBED_NOT_FRAMEABLE, a warning): the widget says it can't be embedded.
 * A widget's options are checked by the composed schema, against its type's options schema.
 */
export function uiWidgets(
  doc: DeckConfigDocument,
  composed: Pick<ComposedConfig, "widgetTypes" | "disabledWidgetTypes" | "selectProblem">,
  strict: boolean,
  layer: ValidateLayer = "merged",
): Finding[] {
  const findings: Finding[] = [];
  const statusMaps = doc.ui?.statusMaps ?? {};
  // Whether a layer alone shuts the gate is unknowable: an earlier or later layer may open it.
  const checkEmbeds = layer === "merged" && doc.ui?.allowUnsafeEmbeds !== true;
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
        if (widget.type.startsWith("core/") && widget.options !== undefined) {
          for (const { pointer, name } of statusMapRefs(widget.options, `${path}/options`)) {
            if (Object.hasOwn(statusMaps, name)) continue;
            findings.push(finding(
              "UI_STATUS_MAP_UNKNOWN",
              pointer,
              `status map '${name}' is not declared in ui.statusMaps; the widget shows these values without a tone`,
            ));
          }
        }
        const url = (widget.options as { url?: unknown } | undefined)?.url;
        if (widget.type === "core/embed" && layer === "merged" && typeof url === "string") {
          const urlProblem = embedUrlProblem(url);
          if (urlProblem !== null) findings.push(finding("UI_EMBED_URL_INVALID", `${path}/options/url`, `core/embed url ${JSON.stringify(url)}: ${urlProblem}`));
          else if (doc.ui?.allowUnsafeEmbeds === true && frameOriginOf(url) === null) {
            findings.push(finding("UI_EMBED_NOT_FRAMEABLE", `${path}/options/url`, `core/embed url ${JSON.stringify(url)}: deck's Content-Security-Policy cannot name its origin, so the page never frames it`));
          }
        }
        if (widget.type === "core/embed" && checkEmbeds) {
          findings.push(finding(
            "UI_EMBED_DISALLOWED",
            `${path}/type`,
            "core/embed shows another site's page in a frame only when ui.allowUnsafeEmbeds is true; until then it shows that embeds are off",
          ));
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

/** Every `statusMap` name in a core widget's options, with its JSON pointer. */
function statusMapRefs(value: unknown, pointer: string): Array<{ pointer: string; name: string }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => statusMapRefs(item, `${pointer}/${index}`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const at = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    return key === "statusMap" && typeof item === "string" ? [{ pointer: at, name: item }] : statusMapRefs(item, at);
  });
}

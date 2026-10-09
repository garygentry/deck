import type { PageDecl, UiPageLayout, UiWidgetInstance } from "@deck/module-sdk";
import { modulePageWidgetId } from "@deck/module-sdk";
import { Fragment, type JSX } from "react";
import { FragmentBoundary } from "@/ui";
import type { FreshnessStamp } from "@deck/contract";

import { useUiManifest } from "../../data/index.js";
import type { WidgetPlacement } from "../../registry/registry-types.js";
import { useManifestSlot } from "../manifest-slot.js";
import { useSlotResetKey } from "../use-slot-reset-key.js";
import { WidgetHost } from "./WidgetHost.js";

const STATIC_STAMP: FreshnessStamp = { state: "static", observedAt: null, ageMs: null, ttlMs: null };

/** Declared layouts by page id: built once, so their widgets keep their identity across renders. */
const declaredLayouts = new Map<string, UiPageLayout>();

/**
 * A module page's declared dashboard as the UI manifest would list it with no overrides: its
 * widgets read no provider and take no options. What the page renders before the manifest
 * loads, or when it cannot be read. Built once per page, so a widget's boundary (keyed on the
 * widget) keeps its state across renders.
 */
export function declaredLayout(page: Pick<PageDecl, "id" | "layout">): UiPageLayout {
  let layout = declaredLayouts.get(page.id);
  if (layout === undefined) {
    layout = {
      sections: (page.layout?.sections ?? []).map((section) =>
        "slot" in section
          ? { slot: section.slot }
          : {
              columns: 1,
              widgets: section.widgets.flatMap((widget): UiWidgetInstance[] => {
                const id = modulePageWidgetId(page.id, widget.id);
                return id === null ? [] : [{ id, type: widget.type, source: null, options: {}, span: 1, rows: 1 }];
              }),
            },
      ),
    };
    declaredLayouts.set(page.id, layout);
  }
  return layout;
}

/**
 * Whether a manifest's layout is one the shell can render: a list of sections, each a widget
 * section (a list of widgets, each with an id and a type) or, when `slots` is set, a slot
 * section. The manifest is read leniently: a malformed one is not trusted.
 */
export function isRenderableLayout(layout: unknown, options: { slots: boolean }): layout is UiPageLayout {
  const sections = (layout as { sections?: unknown } | null | undefined)?.sections;
  return (
    Array.isArray(sections) &&
    sections.every((section) => {
      if (section === null || typeof section !== "object") return false;
      if ("slot" in section) return options.slots && typeof section.slot === "string";
      const widgets = (section as { widgets?: unknown }).widgets;
      return (
        Array.isArray(widgets) &&
        widgets.every((widget) => widget !== null && typeof widget === "object" && typeof widget.id === "string" && typeof widget.type === "string")
      );
    })
  );
}

/**
 * A module page's layout: the ready manifest's (with overrides applied), else the page's
 * declared one, so the page renders the same while the manifest loads, cannot be read, or
 * lists a layout of a shape the shell cannot render.
 */
export function usePageLayout(page: Pick<PageDecl, "id" | "layout">): UiPageLayout {
  const manifest = useUiManifest();
  if (manifest.status === "ready" && Array.isArray(manifest.manifest.pages)) {
    const layout: unknown = manifest.manifest.pages.find((candidate) => candidate?.id === page.id)?.layout;
    if (isRenderableLayout(layout, { slots: true })) return layout;
  }
  return declaredLayout(page);
}

/**
 * The widgets the UI manifest places in a `widget` slot, in its order (none of a module that
 * is off). Each renders in its own boundary, keyed to the path and the poll tick, so one that
 * throws leaves the page working and retries.
 */
export function SlotWidgets({ slot }: { slot: string }): JSX.Element {
  const cards = useManifestSlot(slot);
  const resetKey = useSlotResetKey();
  return (
    <>
      {cards.map(({ id, component: Card }) =>
        Card === undefined ? null : (
          <FragmentBoundary key={id} label="Summary card" resetKey={resetKey}>
            <Card data={null} freshness={STATIC_STAMP} />
          </FragmentBoundary>
        ),
      )}
    </>
  );
}

/**
 * A module page's dashboard, in reading order, as direct children of the page: each slot's
 * widgets, then each widget without card chrome (`placement`), as the page's own content.
 */
export function PageLayoutSections({ layout, placement }: { layout: UiPageLayout; placement: WidgetPlacement }): JSX.Element {
  return (
    <>
      {layout.sections.map((section, index) => (
        <Fragment key={index}>
          {"slot" in section
            ? <SlotWidgets slot={section.slot} />
            : section.widgets.map((widget) => <WidgetHost key={widget.id} widget={widget} placement={placement} />)}
        </Fragment>
      ))}
    </>
  );
}

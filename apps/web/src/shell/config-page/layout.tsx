import type { PageDecl, UiPageLayout, UiWidgetInstance } from "@deck/module-sdk";
import { parseExtensionId } from "@deck/module-sdk";
import { Fragment, type JSX } from "react";
import { FragmentBoundary } from "@/ui";
import type { FreshnessStamp } from "@deck/contract";

import { useUiManifest } from "../../data/index.js";
import type { WidgetPlacement } from "../../registry/registry-types.js";
import { useManifestSlot } from "../manifest-slot.js";
import { useSlotResetKey } from "../use-slot-reset-key.js";
import { WidgetHost } from "./WidgetHost.js";

const STATIC_STAMP: FreshnessStamp = { state: "static", observedAt: null, ageMs: null, ttlMs: null };

/**
 * A module page's declared dashboard as the UI manifest would list it with no overrides: its
 * widgets read no provider and take no options. What the page renders before the manifest
 * loads, or when it cannot be read.
 */
export function declaredLayout(page: Pick<PageDecl, "id" | "layout">): UiPageLayout {
  const parts = parseExtensionId(page.id);
  return {
    sections: (page.layout?.sections ?? []).map((section) =>
      "slot" in section
        ? { slot: section.slot }
        : {
            columns: 1,
            widgets: section.widgets.map((widget): UiWidgetInstance => ({
              id: `widget:${parts?.module ?? ""}/${parts?.name ?? ""}.${widget.id}`,
              type: widget.type,
              source: null,
              options: {},
              span: 1,
              rows: 1,
            })),
          },
    ),
  };
}

/**
 * A module page's layout: the ready manifest's (with overrides applied), else the page's
 * declared one, so the page renders the same while the manifest loads or cannot be read.
 */
export function usePageLayout(page: Pick<PageDecl, "id" | "layout">): UiPageLayout {
  const manifest = useUiManifest();
  if (manifest.status === "ready" && Array.isArray(manifest.manifest.pages)) {
    const layout = manifest.manifest.pages.find((candidate) => candidate?.id === page.id)?.layout;
    if (Array.isArray(layout?.sections)) return layout;
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

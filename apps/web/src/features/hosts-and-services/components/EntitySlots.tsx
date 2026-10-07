import { Suspense, type JSX } from "react";
import { Callout, EmptyState, ErrorState, FragmentBoundary, LoadingState, Section } from "@/ui";
import {
  getEntityFragments,
  type EntityFragmentRegistration,
  type EntityRef,
} from "../../../registry/registry.js";

/** Stable detail-slot order: findings render before configs on every page. */
export const INVENTORY_SLOTS = ["findings", "configs"] as const;

/** Stable detail-slot name owned by `components/EntitySlots.tsx`. */
export type InventorySlot = (typeof INVENTORY_SLOTS)[number];

/** Fixed visible heading for each stable slot. */
const SLOT_HEADINGS: Record<InventorySlot, string> = {
  findings: "Findings",
  configs: "Configs",
};

/** Props owned and exported by `components/EntitySlots.tsx`. */
export interface EntitySlotsProps {
  /** Exact frozen shell entity reference passed unchanged to every fragment. */
  entity: EntityRef;
}

/**
 * Render both stable inventory fragment slots in contract order.
 *
 * This host declares the `findings` then `configs` surfaces by rendering them;
 * it never calls `registerEntityFragment`, inspects `snapshot.drift`, or renders
 * owned config-file contents. Sibling features register the fragments that fill
 * these slots. Each slot resolves its fragments once through the shared accessor,
 * isolates a registry-read failure, and isolates each fragment render behind its
 * own error boundary so one sibling cannot blank the page or the other slot.
 */
export function EntitySlots({ entity }: EntitySlotsProps): JSX.Element {
  return (
    <>
      {INVENTORY_SLOTS.map((slot) => (
        <EntitySlotSection key={slot} slot={slot} entity={entity} />
      ))}
    </>
  );
}

interface EntitySlotSectionProps {
  slot: InventorySlot;
  entity: EntityRef;
}

/** Fixed fallback when one fragment throws: never the sibling's exception text. */
const FRAGMENT_FAILED = (
  <Callout tone="danger" icon="cloud-off" compact>
    Attached content could not be displayed.
  </Callout>
);

/** One labelled slot: its ordered fragments, a placeholder, or a read alert. */
function EntitySlotSection({ slot, entity }: EntitySlotSectionProps): JSX.Element {
  let fragments: readonly EntityFragmentRegistration[] | null;
  try {
    fragments = getEntityFragments(entity.entity, slot);
  } catch {
    // Never expose the accessor exception text; the next slot still renders.
    fragments = null;
  }

  return (
    <Section title={SLOT_HEADINGS[slot]} headingId={`entity-slot-${slot}`} data-entity-slot={slot}>
      {fragments === null ? (
        <ErrorState compact title="Unable to load attached fragments." />
      ) : fragments.length === 0 ? (
        <EmptyState compact title="Nothing is attached to this slot." />
      ) : (
        fragments.map((fragment) => {
          const Fragment = fragment.component;
          return (
            <FragmentBoundary
              key={boundaryKey(entity, slot, fragment.id)}
              label={SLOT_HEADINGS[slot]}
              fallback={FRAGMENT_FAILED}
            >
              {/* Fragments may be lazy components; each loads on first use. */}
              <Suspense fallback={<LoadingState label="Loading…" rows={2} />}>
                <Fragment entity={entity} />
              </Suspense>
            </FragmentBoundary>
          );
        })
      )}
    </Section>
  );
}

/**
 * Serialize the full entity tuple, slot, and fragment id collision-safely so a
 * boundary keyed here is remounted (and re-attempts render) when client-side
 * navigation moves to a different entity, rather than retaining a stale failure.
 * `JSON.stringify` over a tuple escapes each part; string concatenation with a
 * bare delimiter could collide across values containing that delimiter.
 */
function boundaryKey(entity: EntityRef, slot: InventorySlot, fragmentId: string): string {
  return JSON.stringify([entity.entity, entity.host, entity.name ?? null, slot, fragmentId]);
}

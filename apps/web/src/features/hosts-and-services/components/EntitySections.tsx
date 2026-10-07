import { Suspense, type JSX } from "react";
import { Callout, ErrorState, FragmentBoundary, LoadingState, Section } from "@/ui";
import { getEntitySections, type EntityRef, type EntitySection } from "../../../registry/registry.js";
import { useRegistryVersion } from "../../../registry/use-registry.js";

/** Props owned and exported by `components/EntitySections.tsx`. */
export interface EntitySectionsProps {
  /** Exact frozen shell entity reference passed unchanged to every fragment. */
  entity: EntityRef;
}

/** Fixed fallback when one fragment throws: never the sibling's exception text. */
const FRAGMENT_FAILED = (
  <Callout tone="danger" icon="cloud-off" compact>
    Attached content could not be displayed.
  </Callout>
);

/**
 * Render the sections attached to the entity's page (`entity:<entity>/sections`), in order.
 *
 * The page is open: this host owns no section list. Each module attaches its sections by
 * extension id, with its own heading (drift's findings, sources' owned configs, or any other
 * module's), and fragments naming the same section render together under one heading. The
 * host never inspects `snapshot.drift` or renders owned config-file contents. A registry-read
 * failure shows one alert in place of the sections, and each fragment renders behind its own
 * error boundary so one sibling cannot blank the page or another section.
 */
export function EntitySections({ entity }: EntitySectionsProps): JSX.Element | null {
  useRegistryVersion();
  let sections: readonly EntitySection[];
  try {
    sections = getEntitySections(entity.entity);
  } catch {
    // Never expose the accessor exception text.
    return <ErrorState compact title="Unable to load attached sections." />;
  }
  if (sections.length === 0) return null;
  return (
    <>
      {sections.map((section) => (
        <EntitySectionView key={section.section} section={section} entity={entity} />
      ))}
    </>
  );
}

/** One labelled section and its ordered fragments. */
function EntitySectionView({ section, entity }: { section: EntitySection; entity: EntityRef }): JSX.Element {
  return (
    <Section title={section.title} headingId={`entity-slot-${section.section}`} data-entity-slot={section.section}>
      {section.fragments.map((fragment) => {
        const Fragment = fragment.component;
        return (
          <FragmentBoundary
            key={boundaryKey(entity, section.section, fragment.id)}
            label={section.title}
            fallback={FRAGMENT_FAILED}
          >
            {/* Fragments may be lazy components; each loads on first use. */}
            <Suspense fallback={<LoadingState label="Loading…" rows={2} />}>
              <Fragment entity={entity} />
            </Suspense>
          </FragmentBoundary>
        );
      })}
    </Section>
  );
}

/**
 * Serialize the full entity tuple, section, and fragment id collision-safely so a
 * boundary keyed here is remounted (and re-attempts render) when client-side
 * navigation moves to a different entity, rather than retaining a stale failure.
 * `JSON.stringify` over a tuple escapes each part; string concatenation with a
 * bare delimiter could collide across values containing that delimiter.
 */
function boundaryKey(entity: EntityRef, section: string, fragmentId: string): string {
  return JSON.stringify([entity.entity, entity.host, entity.name ?? null, section, fragmentId]);
}

import type { ObservedService, Service } from "@deck/schema";
import type { JSX, ReactNode } from "react";
import { PageHeader, SafeRouteLink } from "@/ui";
import { useRoute } from "@/shell/router";
import { EntitySlots } from "../components/EntitySlots.js";
import { SERVICE_STATE_UI, SERVICE_STATUS_UI, renderMarker } from "../components/HostStateChip.js";
import { InventoryNotFound } from "../components/InventoryNotFound.js";
import { SnapshotStatus } from "../components/SnapshotStatus.js";
import {
  ABSENT,
  BackupSection,
  DetailFrame,
  FactList,
  Fields,
  FreshnessSection,
  HEADER_MARKERS,
  IntentReality,
  LinksSection,
  SecretsSection,
  realitySide,
} from "../components/detail-shared.js";
import { compareOrdinal, findService, hostHref, type ServiceRow } from "../model.js";
import {
  InventoryDataProvider,
  useInventoryDataContext,
  type SnapshotClientState,
} from "../use-inventory-data.js";
import type { EntityRef } from "../../../registry/registry.js";

/** Registered `/services/:host/:name` page with one aggregate inventory poll. */
export function ServiceDetailPage(): JSX.Element {
  return (
    <InventoryDataProvider>
      <ServiceDetail />
    </InventoryDataProvider>
  );
}

/**
 * Resolve the routed service from the one committed model generation using its two
 * independent identity segments and render its ordered core sections beside observed
 * reality, then the stable fragment slots.
 *
 * The lookup is a single O(1) nested-index read keyed by the already-decoded host
 * and name params independently — the identity is never concatenated or split.
 * Loading never claims not-found: only a settled non-null model whose indexed key
 * is absent renders the feature-owned unknown-service page, so a background poll
 * cannot flash a false negative.
 */
function ServiceDetail(): JSX.Element {
  const data = useInventoryDataContext();
  const route = useRoute();
  const host = route.params?.host ?? "";
  const name = route.params?.name ?? "";

  return (
    <DetailFrame slot="service-detail-page" configErrorId="service-detail-config-error" data={data}>
      {(model) => {
        const row = findService(model, host, name);
        if (row === undefined) return <InventoryNotFound kind="service" />;
        return <FoundServiceDetail row={row} snapshot={data.snapshot} />;
      }}
    </DetailFrame>
  );
}

interface FoundServiceDetailProps {
  row: ServiceRow;
  snapshot: SnapshotClientState;
}

/** The full service detail body once an indexed row has been resolved. */
function FoundServiceDetail({ row, snapshot }: FoundServiceDetailProps): JSX.Element {
  const declared = row.declared;
  const undeclared = declared === null;
  const hidden = declared?.hidden === true;
  const entityRef = Object.freeze({
    entity: "service",
    host: row.key.host,
    name: row.key.name,
  } satisfies EntityRef);

  return (
    <section aria-labelledby="service-detail-heading" className="flex flex-col gap-6">
      <PageHeader
        id="service-detail-heading"
        title={`Service: ${row.key.name}`}
        description={
          <>
            {"On host: "}
            <SafeRouteLink build={() => hostHref(row.key.host)}>{row.key.host}</SafeRouteLink>
          </>
        }
        meta={
          undeclared || hidden ? (
            <>
              {undeclared ? HEADER_MARKERS.undeclared : null}
              {hidden ? HEADER_MARKERS.hidden : null}
            </>
          ) : undefined
        }
      />
      <SnapshotStatus snapshot={snapshot} />

      <IdentitySection row={row} />
      <FreshnessSection entity="service" hostState={row.hostState} />
      <ObservedStateSection row={row} />
      <BackupSection backup={declared?.backup} reality={row.reality} />
      <SecretsSection secrets={declared?.secrets} reality={row.reality} />
      <LinksSection links={declared?.links} reality={row.reality} />

      <EntitySlots entity={entityRef} />
    </section>
  );
}

/** A host name linking to its (independently encoded) detail route. */
function hostLink(host: string): JSX.Element {
  return <SafeRouteLink build={() => hostHref(host)}>{host}</SafeRouteLink>;
}

// ---------------------------------------------------------------------------
// Identity.
// ---------------------------------------------------------------------------

/** Always-present identity: declared intent beside the observed name/host. */
function IdentitySection({ row }: { row: ServiceRow }): JSX.Element | null {
  const observed = row.observed;
  return (
    <IntentReality
      label="Identity"
      intent={row.declared === null ? null : <DeclaredIdentity service={row.declared} />}
      reality={realitySide(
        row.reality,
        observed !== null ? (
          <Fields
            fields={[
              ["Name", observed.name],
              ["Host", hostLink(observed.host)],
            ]}
          />
        ) : null,
      )}
    />
  );
}

/** Declared service identity fields; lifecycle is Unspecified when omitted. */
function DeclaredIdentity({ service }: { service: Service }): JSX.Element {
  return (
    <Fields
      fields={[
        ["Name", service.name],
        ["Host", hostLink(service.host)],
        ["Kind", service.kind],
        [
          "Lifecycle",
          service.status !== undefined ? renderMarker(SERVICE_STATUS_UI[service.status]) : ABSENT.unspecified,
        ],
        ["Purpose", service.purpose],
        ["Stack", service.stack],
        ["Hidden", service.hidden === true ? "Hidden from default views" : undefined],
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Observed state and facts (reality-only; never coerced to Stopped/Unknown).
// ---------------------------------------------------------------------------

/** Observed service state and open facts; the declared side has no counterpart. */
function ObservedStateSection({ row }: { row: ServiceRow }): JSX.Element {
  let reality: ReactNode;
  if (row.reality === "no-snapshot") {
    reality = ABSENT.noSnapshot;
  } else if (row.observed !== null) {
    reality = <ObservedStateBody observed={row.observed} />;
  } else {
    reality = ABSENT.notObserved;
  }
  return <IntentReality label="Observed state" intent={null} reality={reality} />;
}

/** Observed state marker plus deterministically ordered, escaped open facts. */
function ObservedStateBody({ observed }: { observed: ObservedService }): JSX.Element {
  const factEntries = Object.entries(observed.facts ?? {}).sort((a, b) => compareOrdinal(a[0], b[0]));
  return (
    <div className="flex flex-col items-start gap-4">
      {renderMarker(SERVICE_STATE_UI[observed.state])}
      {factEntries.length > 0 ? <FactList entries={factEntries} /> : null}
    </div>
  );
}

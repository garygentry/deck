import type { Access, Host, ObservedHost } from "@deck/schema";
import type { JSX, ReactNode } from "react";
import {
  Callout,
  DataTable,
  EmptyState,
  PageHeader,
  SafeRouteLink,
  Section,
  type ColumnDef,
} from "@/ui";
import { useRoute } from "@/shell/router";
import { EntitySections } from "../components/EntitySections.js";
import { HOST_STATUS_UI, renderHostState, renderMarker } from "../components/HostStateChip.js";
import { InventoryNotFound } from "../components/InventoryNotFound.js";
import {
  LIST_CELLS,
  renderServiceLifecycle,
  renderServiceObservedState,
} from "../components/InventoryList.js";
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
  realityCell,
  realitySide,
  renderSync,
  yesNo,
} from "../components/detail-shared.js";
import {
  compareOrdinal,
  findHost,
  hostHref,
  serviceHref,
  type HostRow,
  type InventoryModel,
  type ServiceRow,
} from "../model.js";
import {
  InventoryDataProvider,
  useInventoryDataContext,
  type SnapshotClientState,
} from "../use-inventory-data.js";
import type { EntityRef } from "@/registry/registry.js";

/** Registered `/hosts/:name` page with one aggregate inventory poll. */
export function HostDetailPage(): JSX.Element {
  return (
    <InventoryDataProvider>
      <HostDetail />
    </InventoryDataProvider>
  );
}

/**
 * Resolve the routed host from the one committed model generation and render its
 * ordered core sections beside observed reality, then the sections modules attach.
 *
 * The lookup is a single O(1) index read. Loading never claims not-found: only a
 * settled non-null model whose indexed key is absent renders the feature-owned
 * unknown-host page, so a background poll cannot flash a false negative.
 */
function HostDetail(): JSX.Element {
  const data = useInventoryDataContext();
  const route = useRoute();
  const name = route.params?.name ?? "";

  return (
    <DetailFrame slot="host-detail-page" configErrorId="host-detail-config-error" data={data}>
      {(model) => {
        const row = findHost(model, name);
        if (row === undefined) return <InventoryNotFound kind="host" />;
        return <FoundHostDetail row={row} model={model} snapshot={data.snapshot} />;
      }}
    </DetailFrame>
  );
}

interface FoundHostDetailProps {
  row: HostRow;
  model: InventoryModel;
  snapshot: SnapshotClientState;
}

/** The full host detail body once an indexed row has been resolved. */
function FoundHostDetail({ row, model, snapshot }: FoundHostDetailProps): JSX.Element {
  const declared = row.declared;
  const status = declared?.status;
  const entityRef = Object.freeze({
    entity: "host",
    host: row.key,
  } satisfies EntityRef);
  const hidden = declared?.hidden === true;

  return (
    <section aria-labelledby="host-detail-heading" className="flex flex-col gap-6">
      <PageHeader
        id="host-detail-heading"
        title={`Host: ${row.key}`}
        meta={
          declared === null || status !== undefined || hidden ? (
            <>
              {declared === null ? HEADER_MARKERS.undeclared : null}
              {status !== undefined ? renderMarker(HOST_STATUS_UI[status]) : null}
              {hidden ? HEADER_MARKERS.hidden : null}
            </>
          ) : undefined
        }
      />
      <SnapshotStatus snapshot={snapshot} />

      <IdentitySection row={row} />
      <FreshnessSection entity="host" hostState={row.hostState}>
        {row.observed?.coverage === "partial" ? <Collectors observed={row.observed} /> : null}
      </FreshnessSection>
      <AddressesSection row={row} />
      <AccessSection row={row} />
      <BackupSection backup={declared?.backup} reality={row.reality} />
      <ManagedConfigsSection row={row} />
      <SecretsSection secrets={declared?.secrets} reality={row.reality} />
      <LinksSection links={declared?.links} reality={row.reality} />
      <ObservedFactsSection observed={row.observed} reality={row.reality} />
      <ServicesOnHostSection row={row} model={model} />

      <EntitySections entity={entityRef} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Identity.
// ---------------------------------------------------------------------------

/** Always-present identity section: declared intent beside the observed name. */
function IdentitySection({ row }: { row: HostRow }): JSX.Element | null {
  const observed = row.observed;
  return (
    <IntentReality
      label="Identity"
      intent={row.declared === null ? null : <DeclaredIdentity host={row.declared} />}
      reality={realitySide(row.reality, observed !== null ? <Fields fields={[["Name", observed.name]]} /> : null)}
    />
  );
}

/** Declared host identity fields; the guest pair renders only when both exist. */
function DeclaredIdentity({ host }: { host: Host }): JSX.Element {
  const hasGuest = host.hypervisor !== undefined && host.vmid !== undefined;
  return (
    <Fields
      fields={[
        ["Name", host.name],
        ["Kind", host.kind],
        ["Lifecycle", host.status !== undefined ? renderMarker(HOST_STATUS_UI[host.status]) : undefined],
        ["Purpose", host.purpose],
        ["Hypervisor", hasGuest ? host.hypervisor : undefined],
        ["Guest vmid", hasGuest ? String(host.vmid) : undefined],
        ["Hidden", host.hidden === true ? "Hidden from default views" : undefined],
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Freshness: partial collector outcomes.
// ---------------------------------------------------------------------------

/** Partial-coverage collector outcomes, or a safe alert when they are missing. */
function Collectors({ observed }: { observed: ObservedHost }): JSX.Element {
  const collectors = observed.collectors;
  if (collectors === undefined) {
    return (
      <Callout tone="danger" compact>
        Collector outcomes unavailable.
      </Callout>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <CollectorList
        title="Collectors succeeded"
        items={collectors.succeeded.map((collectorName, index) => ({
          key: `${collectorName}:${index}`,
          text: collectorName,
        }))}
      />
      <CollectorList
        title="Collectors failed"
        items={collectors.failed.map((failure, index) => ({
          key: `${failure.name}:${index}`,
          text: `${failure.name}: ${failure.reason}`,
        }))}
      />
    </div>
  );
}

/** One titled collector outcome list; `None reported` when empty. */
function CollectorList({ title, items }: { title: string; items: { key: string; text: string }[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">None reported</p>
      ) : (
        <ul className="flex list-disc flex-col gap-1 ps-5 text-sm break-words">
          {items.map((item) => (
            <li key={item.key}>{item.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paired tables: addresses (by network) and managed configs (by path).
// ---------------------------------------------------------------------------

/** One paired row: a key cell, then an optional declared and observed side. */
interface PairRow<D, O> {
  id: string;
  key: string;
  declared: D | null;
  observed: O | null;
}

/**
 * Pair declared and observed entries by an exact key without dropping data:
 * keys in first-seen order (declared first), and duplicate entries under one key
 * paired by position.
 */
function pairByKey<D, O>(
  declared: readonly D[],
  observed: readonly O[],
  declaredKey: (entry: D) => string,
  observedKey: (entry: O) => string,
): PairRow<D, O>[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of [...declared.map(declaredKey), ...observed.map(observedKey)]) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  const rows: PairRow<D, O>[] = [];
  for (const key of keys) {
    const declaredForKey = declared.filter((entry) => declaredKey(entry) === key);
    const observedForKey = observed.filter((entry) => observedKey(entry) === key);
    const count = Math.max(declaredForKey.length, observedForKey.length);
    for (let index = 0; index < count; index++) {
      rows.push({
        id: `${rows.length}`,
        key,
        declared: declaredForKey[index] ?? null,
        observed: observedForKey[index] ?? null,
      });
    }
  }
  return rows;
}

const pairRowId = (row: { id: string }): string => row.id;

/** A declared or observed address. */
interface AddressValue {
  network: string;
  address: string;
  primary?: boolean;
}

/** The address text plus a primary marker when applicable. */
function addressText(address: AddressValue): string {
  return address.primary === true ? `${address.address} (primary)` : address.address;
}

/** Address table columns for a given reality (the reality cell depends on it). */
function addressColumns(reality: HostRow["reality"]): ColumnDef<PairRow<AddressValue, AddressValue>>[] {
  return [
    { id: "network", header: "Network", cell: ({ row }) => row.original.key },
    {
      id: "declared",
      header: "Declared intent",
      cell: ({ row }) =>
        row.original.declared !== null ? addressText(row.original.declared) : ABSENT.notDeclared,
    },
    {
      id: "observed",
      header: "Observed reality",
      cell: ({ row }) =>
        realityCell(reality, row.original.observed !== null ? addressText(row.original.observed) : null),
    },
  ];
}

/** Declared and observed addresses paired by exact network in one labelled table. */
function AddressesSection({ row }: { row: HostRow }): JSX.Element | null {
  const declared = row.declared?.addresses ?? [];
  const observed = row.reality === "available" ? (row.observed?.addresses ?? []) : [];
  if (declared.length === 0 && observed.length === 0) return null;
  const rows = pairByKey<AddressValue, AddressValue>(declared, observed, (a) => a.network, (a) => a.network);
  return (
    <Section title="Addresses" headingId="host-addresses-heading">
      <DataTable
        caption="Declared intent beside observed reality"
        columns={addressColumns(row.reality)}
        data={rows}
        getRowId={pairRowId}
        stickyHeader={false}
      />
    </Section>
  );
}

/** A declared managed config. */
interface DeclaredConfig {
  path: string;
  source: string;
  notes?: string;
}

/** An observed managed config verdict. */
interface ObservedConfig {
  path: string;
  inSync: boolean;
}

function configColumns(reality: HostRow["reality"]): ColumnDef<PairRow<DeclaredConfig, ObservedConfig>>[] {
  return [
    { id: "path", header: "Path", meta: { className: "font-mono text-xs" }, cell: ({ row }) => row.original.key },
    {
      id: "declared",
      header: "Declared intent",
      meta: { className: "whitespace-normal" },
      cell: ({ row }) => {
        const config = row.original.declared;
        if (config === null) return ABSENT.notDeclared;
        return config.notes !== undefined ? `${config.source} — ${config.notes}` : config.source;
      },
    },
    {
      id: "observed",
      header: "Observed reality",
      cell: ({ row }) =>
        realityCell(reality, row.original.observed !== null ? renderSync(row.original.observed.inSync) : null),
    },
  ];
}

/** Declared and observed managed configs paired by exact path in one labelled table. */
function ManagedConfigsSection({ row }: { row: HostRow }): JSX.Element | null {
  const declared = row.declared?.managedConfigs ?? [];
  const observed = row.reality === "available" ? (row.observed?.managedConfigs ?? []) : [];
  if (declared.length === 0 && observed.length === 0) return null;
  const rows = pairByKey<DeclaredConfig, ObservedConfig>(declared, observed, (c) => c.path, (c) => c.path);
  return (
    <Section title="Managed configs" headingId="host-managed-configs-heading">
      <DataTable
        caption="Declared intent beside observed reality"
        columns={configColumns(row.reality)}
        data={rows}
        getRowId={pairRowId}
        stickyHeader={false}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Access.
// ---------------------------------------------------------------------------

/** Declared access summary beside observed reachability, omitted when both absent. */
function AccessSection({ row }: { row: HostRow }): JSX.Element | null {
  const access = row.declared?.access;
  const reachable = row.reality === "available" ? row.observed?.reachable : undefined;
  if (access === undefined && reachable === undefined) return null;
  return (
    <IntentReality
      label="Access"
      intent={access !== undefined ? <DeclaredAccess access={access} /> : null}
      reality={realitySide(
        row.reality,
        reachable !== undefined ? <Fields fields={[["Reachable", yesNo(reachable)]]} /> : null,
      )}
    />
  );
}

/** Declared access fields, each rendered only when present. */
function DeclaredAccess({ access }: { access: Access }): JSX.Element {
  return (
    <Fields
      fields={[
        ["Method", access.method],
        ["Port", access.port !== undefined ? String(access.port) : undefined],
        ["User", access.user],
        ["Sudo", access.sudo !== undefined ? yesNo(access.sudo) : undefined],
        ["Expected reachable", access.reachable !== undefined ? yesNo(access.reachable) : undefined],
        ["Notes", access.notes],
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Observed facts (reality-only; no declared counterpart).
// ---------------------------------------------------------------------------

/** OS, uptime, containers, guests, and open facts; omitted when all are absent. */
function ObservedFactsSection({
  observed,
  reality,
}: {
  observed: ObservedHost | null;
  reality: HostRow["reality"];
}): JSX.Element | null {
  if (reality !== "available" || observed === null) return null;

  const os = observed.os;
  const hasOs =
    os !== undefined && (os.name !== undefined || os.version !== undefined || os.kernel !== undefined);
  const hasUptime = observed.uptimeSeconds !== undefined;
  const containers = observed.containers ?? [];
  const guests = observed.guests ?? [];
  const factEntries = Object.entries(observed.facts ?? {}).sort((a, b) => compareOrdinal(a[0], b[0]));

  if (!hasOs && !hasUptime && containers.length === 0 && guests.length === 0 && factEntries.length === 0) {
    return null;
  }

  const content = (
    <div className="flex flex-col gap-4 text-sm">
      {hasOs ? (
        <Fields
          fields={[
            ["OS name", os?.name],
            ["OS version", os?.version],
            ["Kernel", os?.kernel],
          ]}
        />
      ) : null}
      {hasUptime ? <p>Uptime: {String(observed.uptimeSeconds)} seconds</p> : null}
      {containers.length > 0 ? (
        <FactGroup title="Containers">
          {containers.map((container, index) => (
            <li key={`${container.name}:${index}`}>
              {container.name} — {container.image} ({container.state})
            </li>
          ))}
        </FactGroup>
      ) : null}
      {guests.length > 0 ? (
        <FactGroup title="Guests">
          {guests.map((guest, index) => (
            <li key={`${guest.vmid}:${index}`}>
              {String(guest.vmid)} — {guest.name} ({guest.state})
            </li>
          ))}
        </FactGroup>
      ) : null}
      {factEntries.length > 0 ? <FactList entries={factEntries} /> : null}
    </div>
  );

  return <IntentReality label="Observed facts" intent={null} reality={content} />;
}

/** A titled observed-fact list (containers, guests). */
function FactGroup({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="flex list-disc flex-col gap-1 ps-5 break-words">{children}</ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Services on this host (bounded projection over the sorted model).
// ---------------------------------------------------------------------------

/**
 * A services-on-host row's id: the (host, name) pair serialized collision-safely
 * without encoding (a non-encodable name must not break the table).
 */
const serviceOnHostId = (service: ServiceRow): string => JSON.stringify([service.key.host, service.key.name]);

/** The Services list's columns, with defensively built entity links. */
const SERVICE_ON_HOST_COLUMNS: ColumnDef<ServiceRow>[] = [
  {
    id: "service",
    header: "Service",
    columns: [
      { id: "name", header: "Name", cell: ({ row }) => serviceName(row.original) },
      {
        id: "host",
        header: "Host",
        cell: ({ row }) => (
          <SafeRouteLink build={() => hostHref(row.original.key.host)} className="font-normal">
            {row.original.key.host}
          </SafeRouteLink>
        ),
      },
    ],
  },
  {
    id: "intent",
    header: "Declared intent",
    columns: [
      { id: "kind", header: "Kind", cell: ({ row }) => row.original.declared?.kind ?? LIST_CELLS.notDeclared },
      { id: "lifecycle", header: "Lifecycle", cell: ({ row }) => renderServiceLifecycle(row.original.declared) },
      {
        id: "purpose",
        header: "Purpose",
        meta: { className: "min-w-48 whitespace-normal" },
        cell: ({ row }) => row.original.declared?.purpose ?? LIST_CELLS.notDeclared,
      },
    ],
  },
  {
    id: "reality",
    header: "Observed reality",
    columns: [
      { id: "observed-state", header: "Observed state", cell: ({ row }) => renderServiceObservedState(row.original) },
      {
        id: "host-collection",
        header: "Host collection",
        meta: { className: "min-w-52 whitespace-normal" },
        cell: ({ row }) =>
          row.original.hostState !== null ? renderHostState(row.original.hostState) : LIST_CELLS.noSnapshot,
      },
    ],
  },
];

/** The Name row header: the service link plus its Undeclared and Hidden markers. */
function serviceName(service: ServiceRow): JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <SafeRouteLink build={() => serviceHref(service.key.host, service.key.name)}>{service.key.name}</SafeRouteLink>
      {service.declared === null ? LIST_CELLS.undeclared : null}
      {service.declared?.hidden === true ? LIST_CELLS.hidden : null}
    </span>
  );
}

/** Sorted services belonging to this host, with the Services list's row shape. */
function ServicesOnHostSection({ row, model }: { row: HostRow; model: InventoryModel }): JSX.Element {
  const services = model.services.filter((service) => service.key.host === row.key);
  return (
    <Section title="Services on this host" headingId="host-services-heading">
      {services.length === 0 ? (
        <EmptyState compact title="No services are declared or observed on this host." />
      ) : (
        <DataTable
          caption="Declared intent beside observed reality"
          columns={SERVICE_ON_HOST_COLUMNS}
          data={services}
          getRowId={serviceOnHostId}
          stickyHeader={false}
        />
      )}
    </Section>
  );
}

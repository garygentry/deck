import type { DriftFindingProjection } from "@deck/server";
import { memo, type JSX } from "react";
import {
  Callout,
  Disclosure,
  Icon,
  KeyValueList,
  ListItem,
  NotSupplied,
  StatusBadge,
} from "@/ui";
import type { InventoryModel } from "../../hosts-and-services/model.js";
import {
  DRIFT_SEVERITY,
  DRIFT_UNRESOLVED_LOCATION,
  DRIFT_WAIVER,
} from "../constants.js";
import { resolveFindingLocation } from "../shared.js";
import { EvidenceValue } from "./EvidenceValue.js";

/** Full-page finding renderer. */
export interface FindingRowProps {
  /** One immutable projected finding. */
  readonly finding: DriftFindingProjection;
  /** Matching accepted model against which its location is resolved. */
  readonly model: InventoryModel;
  /** Stable DOM/result id derived collision-safely from the finding id. */
  readonly resultId: string;
}

/** The explicit, visible no-link text for a finding whose location is unresolved. */
export function UnresolvedLocation(): JSX.Element {
  return (
    <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
      <Icon name={DRIFT_UNRESOLVED_LOCATION.icon} className="mt-0.5 shrink-0" />
      {DRIFT_UNRESOLVED_LOCATION.label}
    </p>
  );
}

/** A detail link carrying the page's keyboard-activation hook. */
export function EntityLink({
  href,
  children,
  primary = false,
}: {
  readonly href: string;
  readonly children: string;
  readonly primary?: boolean;
}): JSX.Element {
  return (
    <a
      href={href}
      data-drift-primary={primary ? "" : undefined}
      className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {children}
    </a>
  );
}

/**
 * Render one finding: all supplied inert metadata, its waiver state and details,
 * a safe detail route or explicit unresolved text, and expected/observed evidence.
 * Absent evidence fields render "Not supplied"; supplied null/false/0/"" mount the
 * inert evidence renderer. The row root carries a collision-safe id and
 * `tabIndex={-1}` for programmatic focus.
 */
function FindingRowView({
  finding,
  model,
  resultId,
}: FindingRowProps): JSX.Element {
  const location = resolveFindingLocation(finding, model);

  const metadata = [
    { label: "Severity", value: StatusBadge.fromMap(DRIFT_SEVERITY, finding.severity) },
    { label: "Waiver", value: StatusBadge.fromMap(DRIFT_WAIVER, finding.waiverState, { variant: "dot" }) },
    { label: "Category", value: finding.category },
    { label: "Finding", value: <code className="font-mono text-xs break-all">{finding.id}</code> },
    { label: "Host", value: finding.host },
    ...(finding.service !== null ? [{ label: "Service", value: finding.service }] : []),
    ...(finding.path !== null
      ? [{ label: "Path", value: <code className="font-mono text-xs break-all">{finding.path}</code> }]
      : []),
  ];

  return (
    <ListItem
      id={resultId}
      tabIndex={-1}
      title={<span className="break-words">{finding.message}</span>}
    >
      <div className="mt-1 flex flex-col gap-2">
        <KeyValueList layout="inline" className="gap-x-4 text-xs" items={metadata} />

        {finding.waiver !== null ? (
          <Disclosure label="Waiver details">
            <KeyValueList
              layout="grid"
              items={[
                { label: "Reason", value: finding.waiver.reason },
                { label: "Who", value: finding.waiver.who },
                { label: "Until", value: finding.waiver.until ?? "No expiry" },
              ]}
            />
          </Disclosure>
        ) : null}

        {finding.waiverWarning !== null ? (
          <Callout tone="warn" role="alert" compact>
            {finding.waiverWarning}
          </Callout>
        ) : null}

        {location.href !== null ? (
          <EntityLink href={location.href} primary>
            {location.linkLabel!}
          </EntityLink>
        ) : (
          <UnresolvedLocation />
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {finding.expected !== undefined ? (
            <EvidenceValue label="Expected" value={finding.expected} />
          ) : (
            <p className="text-xs">
              Expected: <NotSupplied />
            </p>
          )}
          {finding.observed !== undefined ? (
            <EvidenceValue label="Observed" value={finding.observed} />
          ) : (
            <p className="text-xs">
              Observed: <NotSupplied />
            </p>
          )}
        </div>
      </div>
    </ListItem>
  );
}

/**
 * Memoized: a filter or search change re-renders the page, but an unchanged
 * finding (same immutable projection object and model) keeps its row as is.
 */
export const FindingRow = memo(FindingRowView);

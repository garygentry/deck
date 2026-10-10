import type { Finding } from "@deck/schema";
import type { JSX, ReactNode } from "react";
import { Callout, Disclosure, FreshnessBadge, type IconName, type Tone } from "@/ui";
import type { SnapshotClientState } from "../use-inventory-data.js";

export interface SnapshotStatusProps {
  /** Classified provider state from the same committed generation as the rows. */
  snapshot: SnapshotClientState;
}

/**
 * Validation findings that a snapshot has no dedicated entity row for and that a
 * maintainer can act on. Undeclared host/service findings are excluded because
 * their own rows already surface them; info-only findings (including
 * `HOST_NOT_COLLECTED`) are excluded by severity. `snapshot.drift` is never read.
 */
const UNDECLARED_FINDING_CODES: ReadonlySet<string> = new Set([
  "SNAPSHOT_HOST_UNDECLARED",
  "SNAPSHOT_SERVICE_UNDECLARED",
]);

/** Findings that need a page-level surface rather than a dedicated entity row. */
export function visibleSnapshotFindings(
  findings: readonly Finding[],
): readonly Finding[] {
  return findings.filter(
    (finding) =>
      (finding.severity === "warning" || finding.severity === "error") &&
      !UNDECLARED_FINDING_CODES.has(finding.code),
  );
}

/** The heading id the status section is labelled by (one status per page). */
const HEADING_ID = "snapshot-status-heading";

/**
 * Provider/read/finding status shared by the inventory pages: a toned `Callout`
 * whose `h2` names the state, with the provider `FreshnessBadge` beneath it.
 */
export function SnapshotStatus({ snapshot }: SnapshotStatusProps): JSX.Element {
  return (
    <section aria-labelledby={HEADING_ID} data-slot="snapshot-status">
      {renderStatusBody(snapshot)}
    </section>
  );
}

/** Exhaustively render one client state; a new state is a compile failure. */
function renderStatusBody(snapshot: SnapshotClientState): JSX.Element {
  switch (snapshot.status) {
    case "not-configured":
      return (
        <StatusCallout tone="neutral" icon="database-off" primary="No snapshot configured">
          <p>Set DECK_SNAPSHOT_SOURCE to add observed reality.</p>
        </StatusCallout>
      );
    case "pending":
      return (
        <StatusCallout tone="pending" icon="hourglass" primary="Snapshot pending">
          <FreshnessBadge freshness={snapshot.envelope.freshness} />
          <p>Awaiting the first snapshot poll.</p>
        </StatusCallout>
      );
    case "failed-empty":
      return (
        <StatusCallout tone="danger" icon="cloud-off" primary="Snapshot unavailable" alert>
          <FreshnessBadge freshness={snapshot.envelope.freshness} />
          {snapshot.envelope.error !== null ? <p>{snapshot.envelope.error.message}</p> : null}
          <p>No successful snapshot has been read.</p>
        </StatusCallout>
      );
    case "request-error":
      return (
        <StatusCallout tone="danger" icon="triangle-alert" primary="Snapshot request failed" alert>
          <p>{snapshot.message}</p>
        </StatusCallout>
      );
    case "available":
      return <AvailableStatus snapshot={snapshot} />;
    default:
      return assertNever(snapshot);
  }
}

interface AvailableStatusProps {
  snapshot: Extract<SnapshotClientState, { status: "available" }>;
}

/** Provider badge, last-read time, retained-failure alert, and filtered findings. */
function AvailableStatus({ snapshot }: AvailableStatusProps): JSX.Element {
  const result = snapshot.envelope.data;
  // `available` is only classified with non-null data (04-inventory-client §4);
  // this guard keeps the component total against the wire `T | null` typing.
  if (result === null) {
    return (
      <StatusCallout tone="pending" icon="hourglass" primary="Snapshot pending">
        <FreshnessBadge freshness={snapshot.envelope.freshness} />
        <p>Awaiting the first snapshot poll.</p>
      </StatusCallout>
    );
  }
  const structuredError = result.readError;
  const outerError = snapshot.envelope.error;
  const retainedMessage =
    structuredError !== null
      ? structuredError.message
      : outerError !== null
        ? outerError.message
        : null;
  const findings = visibleSnapshotFindings(result.findings);

  return (
    <StatusCallout tone="ok" icon="database-check" primary="Snapshot available">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FreshnessBadge freshness={snapshot.envelope.freshness} />
        <p className="text-muted-foreground">
          {"Last successful snapshot read: "}
          <time dateTime={result.lastReadAt} data-snapshot-read-at="">
            {result.lastReadAt}
          </time>
        </p>
      </div>
      {retainedMessage !== null ? (
        <Callout tone="danger" compact className="mt-1">
          <p>Latest snapshot read failed; showing the last successful snapshot.</p>
          <p>{retainedMessage}</p>
        </Callout>
      ) : null}
      {findings.length > 0 ? (
        <Disclosure label={`${findings.length} snapshot validation warning(s) or error(s)`}>
          <ul className="flex flex-col gap-1 text-sm">
            {findings.map((finding, index) => (
              <li
                key={`${finding.code}:${finding.path}:${index}`}
                className="flex flex-wrap gap-x-2 break-words"
              >
                <span className="font-mono">{finding.code}</span>{" "}
                <span className="text-muted-foreground">{finding.severity}</span>{" "}
                <span className="font-mono">{finding.path}</span> <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </StatusCallout>
  );
}

interface StatusCalloutProps {
  tone: Tone;
  icon: IconName;
  primary: string;
  /** The heading announces itself (`role="alert"`) for a failure state. */
  alert?: boolean;
  children: ReactNode;
}

/**
 * The toned status frame. The callout itself is a static `note` (its freshness
 * age ticks, so it must not be a live region); a failure announces through its
 * heading, which carries `role="alert"`.
 */
function StatusCallout({ tone, icon, primary, alert, children }: StatusCalloutProps): JSX.Element {
  return (
    <Callout
      tone={tone}
      icon={icon}
      role="note"
      compact
      title={
        <h2 id={HEADING_ID} role={alert ? "alert" : undefined} className="text-sm font-semibold">
          {primary}
        </h2>
      }
    >
      <div className="flex flex-col items-start gap-1.5">{children}</div>
    </Callout>
  );
}

/** Compile-time exhaustiveness guard for the client-state switch. */
function assertNever(value: never): never {
  throw new Error(`Unhandled snapshot client state: ${JSON.stringify(value)}`);
}

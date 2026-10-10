import type { ComponentProps, JSX, ReactNode } from "react";
import {
  FreshnessBadge,
  Icon,
  List,
  ListGroup,
  ListItem,
  LoadingState,
  RelativeTime,
  Section,
  StatusBadge,
  VisuallyHidden,
  formatAge,
} from "@/ui";

import { AllClearNotice, NotConfiguredNotice, SourceErrorNotice } from "./SectionNotice.js";
import {
  ALERT_BADGE_PRESENTATION,
  OTHER_SEVERITY_BUCKET,
  SEVERITY_ORDER,
  envelopeSectionState,
  type AlertBadge,
} from "./status.js";
import type { ActiveAlert, ActiveSilence, AlertmanagerData } from "./useAlertmanagerData.js";

export interface AlertsSectionProps {
  /** Flattened alertmanager view from `useAlertmanagerData()`. */
  view: AlertmanagerData;
}

/** One severity group for rendering: an ordered bucket label + its firing alerts. */
interface SeverityGroup {
  /** Bucket key — a `SEVERITY_ORDER` value or `OTHER_SEVERITY_BUCKET`. */
  key: string;
  /** Human-readable heading, e.g. "Critical" / "Other". */
  label: string;
  alerts: ActiveAlert[];
}

/**
 * Group firing (non-suppressed) alerts by severity into fixed-order buckets, then an alphabetically
 * sorted "Other" bucket for unrecognized/empty severities. Pure; unknown severities never throw.
 * Suppressed alerts are excluded here and rendered separately.
 */
export function groupBySeverity(alerts: readonly ActiveAlert[]): SeverityGroup[] {
  const firing = alerts.filter((a) => !a.suppressed);
  const known = new Set<string>(SEVERITY_ORDER);
  const groups: SeverityGroup[] = SEVERITY_ORDER.map((sev) => ({
    key: sev,
    label: sev.charAt(0).toUpperCase() + sev.slice(1),
    alerts: firing.filter((a) => a.severity === sev),
  }));
  const other = firing
    .filter((a) => !known.has(a.severity))
    .sort((a, b) => (a.severity < b.severity ? -1 : a.severity > b.severity ? 1 : 0));
  if (other.length > 0) {
    groups.push({ key: OTHER_SEVERITY_BUCKET, label: OTHER_SEVERITY_BUCKET, alerts: other });
  }
  return groups.filter((g) => g.alerts.length > 0);
}

export function AlertsSection({ view }: AlertsSectionProps): JSX.Element {
  if (view.loading && view.freshness === null) {
    return (
      <Section id="alerts" title="Alerts">
        <LoadingState label="Loading alerts…" rows={2} />
      </Section>
    );
  }

  const alerts = view.data?.alerts ?? [];
  const silences = view.data?.silences ?? [];
  const state = envelopeSectionState(
    view.freshness,
    view.error,
    alerts.length > 0 || silences.length > 0,
  );
  const groups = groupBySeverity(alerts);
  const suppressed = alerts.filter((a) => a.suppressed);

  return (
    <Section
      id="alerts"
      title="Alerts"
      data-state={state}
      actions={
        state === "active" && view.freshness !== null ? (
          <FreshnessBadge freshness={view.freshness} />
        ) : undefined
      }
    >
      {state === "not-configured" && (
        <NotConfiguredNotice>Alertmanager not configured.</NotConfiguredNotice>
      )}

      {state === "error" && <SourceErrorNotice source="Alertmanager" freshness={view.freshness} />}

      {state === "all-clear" && (
        <AllClearNotice freshness={view.freshness}>no active alerts.</AllClearNotice>
      )}

      {state === "active" && (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <AlertGroup key={group.key} heading={group.label} alerts={group.alerts} />
          ))}
          {suppressed.length > 0 && (
            <AlertGroup id="alerts-suppressed" heading="Suppressed" alerts={suppressed} />
          )}
          {silences.length > 0 && <SilenceList silences={silences} />}
        </div>
      )}
    </Section>
  );
}

/** A headed severity (or suppressed) group, named "{heading} alerts" for assistive tech. */
function AlertGroup({
  id,
  heading,
  alerts,
}: {
  id?: string;
  heading: string;
  alerts: readonly ActiveAlert[];
}): JSX.Element {
  return (
    <ListGroup
      id={id}
      level={3}
      heading={
        <>
          {heading}
          <VisuallyHidden> alerts</VisuallyHidden>
        </>
      }
    >
      <List variant="divided">
        {alerts.map((alert) => (
          <AlertRow key={alert.fingerprint} alert={alert} />
        ))}
      </List>
    </ListGroup>
  );
}

function alertBadge(alert: ActiveAlert): AlertBadge {
  if (alert.suppressed) return "suppressed";
  return (SEVERITY_ORDER as readonly string[]).includes(alert.severity)
    ? (alert.severity as AlertBadge)
    : "other";
}

/**
 * One alert row. A `sourceUrl` makes the name a whole-row link opened in a new tab (the row's
 * keyboard-navigation target); without one the row is display-only text.
 */
function AlertRow({ alert }: { alert: ActiveAlert }): JSX.Element {
  const badge = alertBadge(alert);
  // An unrecognized severity shows its own value (an empty one keeps the map's "Other").
  const leading = StatusBadge.fromMap(
    ALERT_BADGE_PRESENTATION,
    badge,
    badge === "other" && alert.severity !== "" ? { label: alert.severity } : undefined,
  );
  return (
    <ListItem
      leading={leading}
      // Alert names are often long CamelCase identifiers: let them wrap anywhere on phones.
      title={<span className="wrap-anywhere">{alert.name}</span>}
      href={alert.sourceUrl ?? undefined}
      linkAs={alert.sourceUrl === null ? undefined : NewTabLink}
      meta={
        <span>
          started <RelativeTime value={alert.startsAt} />
        </span>
      }
    />
  );
}

/**
 * The row link for an alert's source: a new tab, with the context change announced. It forwards the
 * `className`/`aria-*` props `ListItem` gives its whole-row link.
 */
function NewTabLink({
  children,
  ...props
}: Omit<ComponentProps<"a">, "target" | "rel"> & { href: string; children?: ReactNode }) {
  return (
    <a target="_blank" rel="noopener noreferrer" {...props}>
      {children}
      <Icon
        name="external-link"
        size={12}
        className="ms-1 inline-block align-[-1px] text-muted-foreground"
      />
      <VisuallyHidden> (opens in new tab)</VisuallyHidden>
    </a>
  );
}

/** "in 1h" for a future instant; an already-passed one reads "now". */
function formatUntil(ms: number): string {
  const age = formatAge(ms);
  return age === "just now" ? "now" : `in ${age.replace(/ ago$/, "")}`;
}

/** Active silences, read-only: no edit or expire affordance. */
function SilenceList({ silences }: { silences: readonly ActiveSilence[] }): JSX.Element {
  return (
    <ListGroup
      level={3}
      heading={
        <>
          Silences
          <VisuallyHidden> (read-only)</VisuallyHidden>
        </>
      }
    >
      <List variant="divided">
        {silences.map((s) => (
          <ListItem
            key={s.id}
            title={<span className="font-mono break-all">{s.matchers}</span>}
            description={<span className="font-mono text-xs break-all">{s.id}</span>}
            meta={
              <span>
                ends{" "}
                <time dateTime={s.endsAt}>
                  {formatUntil(Math.max(0, Date.parse(s.endsAt) - Date.now()))}
                </time>
              </span>
            }
          />
        ))}
      </List>
    </ListGroup>
  );
}

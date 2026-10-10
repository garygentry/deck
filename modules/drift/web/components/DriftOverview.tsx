import type { CoverageRow, DriftProjection, FilteredDriftProjection } from "@deck/drift";
import { memo, type JSX, type ReactNode } from "react";
import {
  FRESHNESS_STATUS,
  KeyValueList,
  Section,
  StatGrid,
  StatTile,
  StatusBadge,
  formatAge,
  type IconName,
  type Tone,
} from "@/ui";
import { DRIFT_COVERAGE, DRIFT_SEVERITY, DRIFT_WAIVER } from "../constants.js";

/** Complete-generation overview; filtered counts are labelled separately. */
export interface DriftOverviewProps {
  /** The complete projection from the accepted generation. */
  readonly projection: DriftProjection;
  /** The current composed visible projection. */
  readonly filtered: FilteredDriftProjection;
  /** Display-only clock used for advancing relative ages. */
  readonly now: Date;
}

/** The oldest host collection selected from rows with a valid timestamp. */
interface OldestCollection {
  /** Non-negative display age at `now`. */
  readonly ageMs: number;
  /** Absolute RFC 3339 collection timestamp. */
  readonly collectedAt: string;
  /** Host whose collection is oldest. */
  readonly host: string;
}

/**
 * Choose the maximum display age among coverage rows with a valid `collectedAt`.
 * Uses the display clock so retained data ages visibly; never mutates state or
 * reclassifies any row. Returns null when no row has a parseable timestamp.
 */
function computeOldestCollection(
  rows: readonly CoverageRow[],
  now: Date,
): OldestCollection | null {
  let oldest: OldestCollection | null = null;
  const nowMs = now.getTime();
  for (const row of rows) {
    if (row.collectedAt === null) continue;
    const epoch = Date.parse(row.collectedAt);
    if (!Number.isFinite(epoch)) continue;
    const ageMs = Math.max(0, nowMs - epoch);
    if (oldest === null || ageMs > oldest.ageMs) {
      oldest = { ageMs, collectedAt: row.collectedAt, host: row.host };
    }
  }
  return oldest;
}

/** Relative age of an RFC 3339 instant at the display clock, or a fixed fallback. */
function relativeAge(iso: string, now: Date): string {
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) return "age unavailable";
  return formatAge(Math.max(0, now.getTime() - epoch));
}

/** A count tile: toned only when the count is non-zero (zero reads neutral). */
function CountTile({
  label,
  value,
  tone,
  icon,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: Tone;
  readonly icon?: IconName;
}): JSX.Element {
  return (
    <StatTile
      label={label}
      value={value}
      icon={icon}
      tone={tone !== undefined && value > 0 ? tone : "neutral"}
    />
  );
}

/** One labelled group of overview tiles; the phrase names its population. */
function OverviewGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-muted-foreground">
        <strong className="font-medium">{title}</strong>
      </p>
      {children}
    </div>
  );
}

/**
 * Render the complete-generation overview: active-risk severity, waiver, all five
 * coverage counts and total hosts, snapshot evidence, and the oldest available
 * host collection. Every number is bound to a population phrase, so counts are
 * never confused with the separately labelled filtered status.
 */
function DriftOverviewView({
  projection,
  now,
}: DriftOverviewProps): JSX.Element {
  const summary = projection.summary;
  const oldest = computeOldestCollection(projection.coverageRows, now);
  const freshness = projection.providerFreshness.state;

  return (
    <Section title="Overview" headingId="drift-section-overview">
      <div className="flex flex-col gap-5">
        <OverviewGroup title="Active drift — all findings in this snapshot generation">
          <StatGrid>
            {(["error", "warning", "info"] as const).map((severity) => (
              <CountTile
                key={severity}
                label={DRIFT_SEVERITY[severity].label}
                value={summary.activeSeverity[severity]}
                tone={DRIFT_SEVERITY[severity].tone}
                icon={DRIFT_SEVERITY[severity].icon}
              />
            ))}
          </StatGrid>
        </OverviewGroup>

        <OverviewGroup title="Waivers — all findings in this snapshot generation">
          <StatGrid>
            <CountTile
              label="Active"
              value={summary.activeWaivers}
              tone={DRIFT_WAIVER.active.tone}
              icon={DRIFT_WAIVER.active.icon}
            />
            <CountTile
              label="Expired"
              value={summary.expiredWaivers}
              tone={DRIFT_WAIVER.expired.tone}
              icon={DRIFT_WAIVER.expired.icon}
            />
          </StatGrid>
        </OverviewGroup>

        <OverviewGroup title="Collection coverage — all hosts in this snapshot generation">
          <StatGrid>
            {(["fresh", "stale", "partial", "unreachable", "never-collected"] as const).map(
              (state) => (
                <CountTile
                  key={state}
                  label={DRIFT_COVERAGE[state].label}
                  value={summary.coverage[state]}
                  tone={DRIFT_COVERAGE[state].tone}
                  icon={DRIFT_COVERAGE[state].icon}
                />
              ),
            )}
            <CountTile label="Total coverage hosts" value={summary.totalHosts} icon="server" />
          </StatGrid>
        </OverviewGroup>

        <div className="grid gap-5 lg:grid-cols-2">
          <OverviewGroup title="Snapshot evidence">
            <KeyValueList
              items={[
                {
                  label: "Provider freshness",
                  value: StatusBadge.fromMap(FRESHNESS_STATUS, freshness, { label: freshness }),
                },
                {
                  label: "Snapshot generated",
                  value: (
                    <time dateTime={projection.snapshotGeneratedAt} className="break-words">
                      {projection.snapshotGeneratedAt}
                    </time>
                  ),
                },
                {
                  label: "Last successful read",
                  value: (
                    <>
                      <time dateTime={projection.lastSuccessfulReadAt} className="break-words">
                        {projection.lastSuccessfulReadAt}
                      </time>{" "}
                      ({relativeAge(projection.lastSuccessfulReadAt, now)})
                    </>
                  ),
                },
              ]}
            />
          </OverviewGroup>

          <OverviewGroup title="Oldest available host collection">
            {oldest === null ? (
              <p className="text-sm text-muted-foreground">
                No host collection timestamps are available.
              </p>
            ) : (
              <p className="text-sm break-words">
                {formatAge(oldest.ageMs)} —{" "}
                <time dateTime={oldest.collectedAt}>{oldest.collectedAt}</time> (
                {oldest.host})
              </p>
            )}
          </OverviewGroup>
        </div>
      </div>
    </Section>
  );
}

/**
 * Memoized on the complete projection and the display clock: the overview never
 * reads the filtered population, so filtering does not re-render it.
 */
export const DriftOverview = memo(
  DriftOverviewView,
  (prior, next) => prior.projection === next.projection && prior.now === next.now,
);

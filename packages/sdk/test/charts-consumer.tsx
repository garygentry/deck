/**
 * A module author's use of the viz charts, type-checked (`pnpm typecheck`) against the generated
 * index.d.ts exactly as a runtime module's web half imports it: the chart props must resolve
 * without reaching deck's internals.
 */
import {
  defineStatusMap,
  Section,
  type ChartStatus,
  Gauge,
  Sparkline,
  StatusTimeline,
  type GaugeProps,
  type SparklineData,
  type SparklineProps,
  type SparklineSample,
  type StatusTimelineProps,
  type TimelineLane,
  type TimelineSegment,
} from "@deck/sdk";

type Health = "up" | "down";
const HEALTH = defineStatusMap<Health>({
  up: { tone: "ok", icon: "circle-check", label: "Up" },
  down: { tone: "danger", icon: "circle-x", label: "Down" },
});

const samples: SparklineSample[] = [{ at: 0, value: 1 }, { at: 1, value: null }];
const segment: TimelineSegment<Health> = { status: "up", start: 0, end: 10 };
const lanes: TimelineLane<Health>[] = [{ id: "web", label: "web", segments: [segment] }];
const gauge: GaugeProps = { ariaLabel: "Disk usage", value: 42, status: HEALTH.up };
const sparkline: SparklineProps = { samples, status: HEALTH.down, ariaLabel: "Latency" };
const tone: ChartStatus = { tone: "warn" };
const data: SparklineData = { values: [1, 2] };
// A bare StatusTimelineProps takes any status vocabulary.
const anyTimeline: StatusTimelineProps = { lanes: [], domainStart: 0, domainEnd: 1, formatTime: String, statusMap: HEALTH };
const timeline: StatusTimelineProps<Health> = { lanes, domainStart: 0, domainEnd: 10, formatTime: String, statusMap: HEALTH };

export const charts = (
  <>
    <Gauge {...gauge} />
    <Sparkline {...sparkline} />
    <Sparkline values={[1, 2, 3]} status={tone} ariaLabel="Restarts" />
    <Sparkline {...data} ariaLabel="Restarts" />
    <StatusTimeline {...timeline} />
    <StatusTimeline {...anyTimeline} />
  </>
);

// @ts-expect-error: a Gauge needs its accessible name.
export const unnamed = <Gauge value={1} />;
// @ts-expect-error: a StatusTimeline needs formatTime for its text alternative.
export const unformatted = <StatusTimeline lanes={lanes} domainStart={0} domainEnd={10} statusMap={HEALTH} />;
// @ts-expect-error: a Sparkline needs its accessible name.
export const unnamedSparkline = <Sparkline values={[1, 2]} />;
// @ts-expect-error: a Sparkline plots values or samples, never both.
export const both = <Sparkline values={[1, 2]} samples={samples} ariaLabel="Latency" />;

// The guide's example (docs/guides/runtime-modules.md, "Draw charts"), with its map and lanes
// renamed to sit beside the cases above: it must compile as written.
type GuideHealth = "up" | "down";
const GUIDE_HEALTH = defineStatusMap<GuideHealth>({
  up: { tone: "ok", icon: "circle-check", label: "Up" },
  down: { tone: "danger", icon: "circle-x", label: "Down" },
});

// Stand-ins for what the module reads from its provider.
const state: GuideHealth = "up";
const diskUsed = 72;
const latencies = [120, 135, 128, 160, 142];
const from = 1_760_000_000;
const to = from + 3600;
const guideLanes: TimelineLane<GuideHealth>[] = [
  { id: "web", label: "web", segments: [{ status: "up", start: from, end: from + 3000 }, { status: "down", start: from + 3000, end: to }] },
];

export function HealthCharts() {
  return (
    <Section title="Health">
      <Gauge ariaLabel="Disk usage" value={diskUsed} status={GUIDE_HEALTH[state]} />
      <Sparkline values={latencies} status={GUIDE_HEALTH[state]} ariaLabel={`Latency, ${GUIDE_HEALTH[state].label}`} />
      <StatusTimeline lanes={guideLanes} statusMap={GUIDE_HEALTH} domainStart={from} domainEnd={to} formatTime={(t) => new Date(t * 1000).toLocaleTimeString()} />
    </Section>
  );
}

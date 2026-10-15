/**
 * A module author's use of the viz charts, type-checked (`pnpm typecheck`) against the generated
 * index.d.ts exactly as a runtime module's web half imports it: the chart props must resolve
 * without reaching deck's internals.
 */
import {
  defineStatusMap,
  Gauge,
  Sparkline,
  StatusTimeline,
  type GaugeProps,
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
const timeline: StatusTimelineProps<Health> = { lanes, domainStart: 0, domainEnd: 10, formatTime: String, statusMap: HEALTH };

export const charts = (
  <>
    <Gauge {...gauge} />
    <Sparkline {...sparkline} />
    <Sparkline values={[1, 2, 3]} status={{ tone: "warn" }} />
    <StatusTimeline {...timeline} />
  </>
);

// @ts-expect-error: a Gauge needs its accessible name.
export const unnamed = <Gauge value={1} />;
// @ts-expect-error: a StatusTimeline needs formatTime for its text alternative.
export const unformatted = <StatusTimeline lanes={lanes} domainStart={0} domainEnd={10} statusMap={HEALTH} />;

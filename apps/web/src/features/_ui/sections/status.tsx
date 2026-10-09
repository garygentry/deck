import {
  FreshnessBadge,
  Gauge,
  HealthPill,
  RelativeTime,
  Sparkline,
  StatusBadge,
  StatusTimeline,
  TONES,
  defineStatusMap,
  type IconName,
  type Tone,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

// Fixed clock: the workbench renders deterministically (visual baselines).
const NOW = Date.parse("2026-01-15T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TONE_ICON: Record<Tone, IconName> = {
  ok: "circle-check",
  warn: "triangle-alert",
  danger: "circle-x",
  info: "info",
  pending: "hourglass",
  neutral: "circle-minus",
};

const TONE_LABEL: Record<Tone, string> = {
  ok: "Healthy",
  warn: "Degraded",
  danger: "Down",
  info: "Info",
  pending: "Pending",
  neutral: "Unknown",
};

const DEMO_MAP = defineStatusMap<"running" | "stopped" | "unknown">({
  running: { tone: "ok", icon: "circle-play", label: "Running" },
  stopped: { tone: "danger", icon: "circle-stop", label: "Stopped" },
  unknown: { tone: "neutral", icon: "circle-help", label: "Unknown" },
});

// Fixed series for the viz specimens.
const TREND = [12, 14, 13, 18, 22, 21, 25, 24, 30, 28, 33, 35];
const SAMPLES = [
  { at: 0, value: 40 },
  { at: 1, value: 42 },
  { at: 2, value: 45 },
  { at: 3, value: null },
  { at: 4, value: null },
  { at: 5, value: 38 },
  { at: 6, value: null },
  { at: 7, value: 41 },
  { at: 8, value: 44 },
  { at: 10, value: 47 },
];
const T0 = 0;
const T1 = 24 * 60;
const LANES = [
  {
    id: "web",
    label: "web",
    segments: [
      { status: "running" as const, start: 0, end: 600 },
      { status: "stopped" as const, start: 600, end: 690 },
      { status: "running" as const, start: 690, end: T1 },
    ],
  },
  {
    id: "db",
    label: "db",
    segments: [
      { status: "unknown" as const, start: 0, end: 120 },
      { status: "running" as const, start: 120, end: T1 },
    ],
  },
  { id: "cache", label: "cache", segments: [{ status: "running" as const, start: 0, end: T1 }] },
];

function ToneRow({ variant, size }: { variant: "soft" | "outline" | "dot"; size?: "sm" | "md" }) {
  return (
    <>
      {TONES.map((tone) => (
        <StatusBadge
          key={tone}
          tone={tone}
          icon={TONE_ICON[tone]}
          label={TONE_LABEL[tone]}
          variant={variant}
          size={size}
        />
      ))}
    </>
  );
}

function Status() {
  return (
    <>
      <Specimen label="StatusBadge — soft, sm (default), every tone">
        <ToneRow variant="soft" />
      </Specimen>
      <Specimen label="StatusBadge — soft, md">
        <ToneRow variant="soft" size="md" />
      </Specimen>
      <Specimen label="StatusBadge — outline">
        <ToneRow variant="outline" />
      </Specimen>
      <Specimen label="StatusBadge — dot (tinted icon, plain text)">
        <ToneRow variant="dot" />
      </Specimen>
      <Specimen label="StatusBadge — detail suffix, tooltip (focusable), truncation">
        <StatusBadge tone="ok" icon="circle-check" label="Fresh" detail="as of 58s ago" />
        <StatusBadge tone="warn" icon="clock-alert" label="Stale" detail="as of 2h ago" size="md" />
        <StatusBadge
          tone="info"
          icon="info"
          label="Waived"
          title="Waived until 2026-02-01 by ops: planned migration window"
        />
        <span className="w-32">
          <StatusBadge
            tone="danger"
            icon="octagon-alert"
            label="Critical: disk usage above threshold on every volume"
          />
        </span>
      </Specimen>
      <Specimen label="StatusBadge.fromMap — a feature map bound to a state">
        {(Object.keys(DEMO_MAP) as (keyof typeof DEMO_MAP)[]).map((state) => (
          <span key={state}>{StatusBadge.fromMap(DEMO_MAP, state)}</span>
        ))}
        {StatusBadge.fromMap(DEMO_MAP, "running", { variant: "outline", detail: "3 containers" })}
      </Specimen>
      <Specimen label="FreshnessBadge — every state (fixed now)">
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "fresh", observedAt: ago(42 * SECOND), ageMs: null, ttlMs: 60_000 }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "stale", observedAt: ago(6 * MINUTE), ageMs: null, ttlMs: 60_000 }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "unreachable", observedAt: ago(3 * HOUR), ageMs: null, ttlMs: 60_000 }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "unreachable", observedAt: null, ageMs: null, ttlMs: null }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "static", observedAt: null, ageMs: null, ttlMs: null }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "pending", observedAt: null, ageMs: null, ttlMs: null }}
        />
      </Specimen>
      <Specimen label="RelativeTime — absolute time in tooltip; invalid input verbatim">
        {[5 * SECOND, 42 * SECOND, 6 * MINUTE, 3 * HOUR, 8 * DAY].map((ms) => (
          <span key={ms} className="text-sm">
            <RelativeTime value={ago(ms)} now={NOW} />
          </span>
        ))}
        <span className="text-sm">
          <RelativeTime value="not-a-date" now={NOW} />
        </span>
      </Specimen>
      <Specimen label="HealthPill — tones, counts, freshness meta, truncation">
        <HealthPill tone="ok" icon="circle-check" label="Endpoints OK" href="#status" />
        <HealthPill
          tone="warn"
          icon="triangle-alert"
          label="Drift"
          count={3}
          countLabel="3 active findings"
          href="#status"
        />
        <HealthPill tone="danger" icon="octagon-alert" label="Alerts" count={12} href="#status" />
        <HealthPill
          tone="pending"
          icon="hourglass"
          label="Metrics"
          href="#status"
          meta={
            <FreshnessBadge
              tooltip={false}
              variant="dot"
              freshness={{ state: "pending", observedAt: null, ageMs: null, ttlMs: null }}
            />
          }
        />
        <HealthPill
          tone="ok"
          icon="circle-check"
          label="Monitoring"
          href="#status"
          meta={
            <FreshnessBadge
              now={NOW}
              tooltip={false}
              variant="dot"
              freshness={{ state: "fresh", observedAt: ago(58 * SECOND), ageMs: null, ttlMs: null }}
            />
          }
        />
        <HealthPill
          tone="warn"
          icon="triangle-alert"
          label="Two endpoints degraded across the lab and backup hosts"
          count={2}
          href="#status"
        />
      </Specimen>
      <Specimen label="Sparkline — plain, status tone, timestamped samples with a gap and an isolated point">
        <Sparkline values={TREND} ariaLabel="Requests per second, rising" />
        <Sparkline values={TREND} status={DEMO_MAP.stopped} ariaLabel="Restarts, rising (stopped)" />
        <Sparkline samples={SAMPLES} status={DEMO_MAP.running} ariaLabel="Latency with a collection gap" />
      </Specimen>
      <Specimen label="StatusTimeline — lanes of status intervals from a status map (24 h)">
        <StatusTimeline
          lanes={LANES}
          domainStart={T0}
          domainEnd={T1}
          statusMap={DEMO_MAP}
          width={280}
          ariaLabel="Service state over the last 24 hours: web stopped once, db unknown at first"
        />
      </Specimen>
      <Specimen label="Gauge — plain, with a status (tone on the arc, label under the value), clamped over max">
        <Gauge value={42} ariaLabel="Disk 42%" label="42%" />
        <Gauge value={87} label="87%" status={DEMO_MAP.stopped} />
        <Gauge value={140} max={100} label="140%" status={DEMO_MAP.running} />
      </Specimen>
    </>
  );
}

export const status: WorkbenchSectionDef = {
  id: "status",
  title: "Status",
  catalogue: "B",
  Demo: Status,
};

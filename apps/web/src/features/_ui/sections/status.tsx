import type { ReactNode } from "react";
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

// The viz specimens' map: DEMO_MAP plus an outline (hatched/dashed) entry on the same tone as
// `unknown`, so the two stay distinct without a second shade.
const VIZ_MAP = defineStatusMap<"running" | "stopped" | "unknown" | "suppressed">({
  ...DEMO_MAP,
  suppressed: { tone: "neutral", icon: "eye-off", label: "Suppressed", variant: "outline" },
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
    id: "api",
    label: "api",
    segments: [
      { status: "running" as const, start: 0, end: 900 },
      { status: "stopped" as const, start: 900, end: 901 },
      { status: "running" as const, start: 901, end: 1200 },
      { status: "suppressed" as const, start: 1200, end: 1320 },
      { status: "running" as const, start: 1320, end: T1 },
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
const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A status-bearing chart beside its badge, so the state is read from icon and text, not colour. */
function WithBadge({ state, children }: { state: keyof typeof VIZ_MAP; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {StatusBadge.fromMap(VIZ_MAP, state)}
      {children}
    </span>
  );
}

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
      <Specimen label="Sparkline — plain; status tone beside its badge; outline entry dashed; samples with a gap and an isolated point">
        <Sparkline values={TREND} ariaLabel="Requests per second, rising" />
        <WithBadge state="stopped">
          <Sparkline values={TREND} status={VIZ_MAP.stopped} ariaLabel="Restarts, rising" />
        </WithBadge>
        <WithBadge state="suppressed">
          <Sparkline values={TREND} status={VIZ_MAP.suppressed} ariaLabel="Alerts, rising" />
        </WithBadge>
        <WithBadge state="running">
          <Sparkline samples={SAMPLES} status={VIZ_MAP.running} ariaLabel="Latency with a collection gap" />
        </WithBadge>
      </Specimen>
      <Specimen label="StatusTimeline — lanes of status intervals (24 h): a 1-minute outage at the minimum width, a hatched outline entry">
        <StatusTimeline
          lanes={LANES}
          domainStart={T0}
          domainEnd={T1}
          formatTime={clock}
          statusMap={VIZ_MAP}
          width={280}
          ariaLabel="Service state over the last 24 hours"
        />
      </Specimen>
      <Specimen label="Gauge — plain, with a status (tone on the arc, label under the value), outline entry dashed, clamped over max, at zero, unavailable">
        <Gauge value={42} ariaLabel="Disk usage" label="42%" />
        <Gauge value={87} ariaLabel="Memory" label="87%" status={VIZ_MAP.stopped} />
        <Gauge value={35} ariaLabel="Alert load" label="35%" status={VIZ_MAP.suppressed} />
        <Gauge value={140} max={100} ariaLabel="CPU" label="140%" status={VIZ_MAP.running} />
        <Gauge value={0} ariaLabel="Swap" label="0%" />
        <Gauge value={Number.NaN} ariaLabel="GPU" />
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

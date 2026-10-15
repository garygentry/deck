import { defineStatusMap, Gauge, Section, Sparkline, StatusTimeline, type TimelineLane } from "@deck/sdk";

type Health = "up" | "down";
const HEALTH = defineStatusMap<Health>({
  up: { tone: "ok", icon: "circle-check", label: "Up" },
  down: { tone: "danger", icon: "circle-x", label: "Down" },
});

// Stand-ins for what the module reads from its provider.
const state: Health = "up";
const diskUsed = 72;
const latencies = [120, 135, 128, 160, 142];
const from = 1_760_000_000;
const to = from + 3600;
const lanes: TimelineLane<Health>[] = [
  { id: "web", label: "web", segments: [{ status: "up", start: from, end: from + 3000 }, { status: "down", start: from + 3000, end: to }] },
];

export function HealthCharts() {
  return (
    <Section title="Health">
      <Gauge ariaLabel="Disk usage" value={diskUsed} status={HEALTH[state]} />
      <Sparkline values={latencies} status={HEALTH[state]} ariaLabel={`Latency, ${HEALTH[state].label}`} />
      <StatusTimeline lanes={lanes} statusMap={HEALTH} domainStart={from} domainEnd={to} formatTime={(t) => new Date(t * 1000).toLocaleTimeString()} />
    </Section>
  );
}

// @vitest-environment jsdom
// The viz charts (Sparkline, StatusTimeline, Gauge): geometry, render, token-only colours.
import { cleanup, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Gauge, Sparkline, StatusTimeline, defineStatusMap, presentationMark, type StatusMap, type TimelineSegment } from "@/ui";
// ui-deep-import: geometry helpers are internal to the viz modules
import { GAUGE_START_ANGLE, GAUGE_SWEEP, arcPath, gaugeValueAngle, polarToCartesian } from "@/ui/viz/gauge";
// ui-deep-import: geometry helpers are internal to the viz modules
import { sparklineGeometry, sparklineSampleGeometry } from "@/ui/viz/sparkline";
// ui-deep-import: geometry helpers are internal to the viz modules
import { timelineHeight, timelineSegmentRect, type TimelineLayoutOpts } from "@/ui/viz/status-timeline";

afterEach(cleanup);

const VIZ_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/ui/viz");

type Health = "up" | "degraded" | "down" | "unknown" | "suppressed";
// `variant` marks the outline entry; built with a cast so this file does not depend on
// `StatusPresentation.variant` being declared.
const HEALTH = {
  ...defineStatusMap<Exclude<Health, "suppressed">>({
    up: { tone: "ok", icon: "circle-check", label: "Up" },
    degraded: { tone: "warn", icon: "triangle-alert", label: "Degraded" },
    down: { tone: "danger", icon: "circle-x", label: "Down" },
    unknown: { tone: "neutral", icon: "circle-help", label: "Unknown" },
  }),
  suppressed: { tone: "neutral", icon: "eye-off", label: "Suppressed", variant: "outline" },
} as StatusMap<Health>;

describe("ui/viz colours", () => {
  it("uses no colour literals in any ui/viz source file", () => {
    const literal =
      /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(|\b(?:black|white|red|green|blue|gray|grey|orange|yellow|purple)\b(?!-)/;
    const files = readdirSync(VIZ_DIR).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const src = readFileSync(join(VIZ_DIR, file), "utf8");
      expect(literal.exec(src)?.[0] ?? null, file).toBeNull();
    }
  });

  it("marks a map entry with its tone; only an outline entry is hatched", () => {
    expect(presentationMark(HEALTH.up)).toEqual({ tone: "ok", pattern: "solid" });
    expect(presentationMark(HEALTH.unknown)).toEqual({ tone: "neutral", pattern: "solid" });
    expect(presentationMark(HEALTH.suppressed)).toEqual({ tone: "neutral", pattern: "hatched" });
    expect(presentationMark({ tone: "info" })).toEqual({ tone: "info", pattern: "solid" });
  });
});

describe("ui/viz geometry", () => {
  const OPTS: TimelineLayoutOpts = { domainStart: 0, domainEnd: 100, width: 200, laneHeight: 16, laneGap: 4 };

  it("sparklineGeometry spaces points evenly, inverts y and honours min/max", () => {
    expect(sparklineGeometry([0, 5, 10], { width: 100, height: 20 })).toEqual({
      points: [
        { x: 0, y: 20 },
        { x: 50, y: 10 },
        { x: 100, y: 0 },
      ],
      path: "M 0,20 L 50,10 L 100,0",
    });
    expect(sparklineGeometry([5, 5], { width: 100, height: 20 })!.points).toEqual([
      { x: 0, y: 20 },
      { x: 100, y: 20 },
    ]);
    expect(sparklineGeometry([5, 5], { width: 100, height: 20, min: 0, max: 10 })!.points[0]).toEqual({ x: 0, y: 10 });
    expect(sparklineGeometry([1], { width: 120, height: 32 })).toBeNull();
    expect(sparklineGeometry([Number.NaN, 3], { width: 120, height: 32 })).toBeNull();
  });

  it("sparklineSampleGeometry sorts, deduplicates and splits at gaps", () => {
    const geo = sparklineSampleGeometry(
      [
        { at: 30, value: 3 },
        { at: 10, value: 1 },
        { at: 20, value: null },
        { at: 30, value: 4 },
        { at: 40, value: 5 },
      ],
      { width: 90, height: 20 },
    );
    expect(geo.runs).toHaveLength(2);
    expect(geo.paths).toHaveLength(1);
    expect(geo.paths[0]!.startsWith("M 60,")).toBe(true);
    expect(geo.markers).toHaveLength(1);
  });

  it("timelineSegmentRect offsets lanes, clamps to the domain and drops empty segments", () => {
    expect(timelineSegmentRect({ status: "up", start: 0, end: 100 }, 0, OPTS)).toEqual({ x: 0, y: 0, width: 200, height: 16 });
    expect(timelineSegmentRect({ status: "degraded", start: 50, end: 100 }, 1, OPTS)).toEqual({ x: 100, y: 20, width: 100, height: 16 });
    expect(timelineSegmentRect({ status: "up", start: 90, end: 150 }, 0, OPTS)).toEqual({ x: 180, y: 0, width: 20, height: 16 });
    expect(timelineSegmentRect({ status: "up", start: 50, end: 50 }, 0, OPTS)).toBeNull();
    expect(timelineSegmentRect({ status: "up", start: -20, end: -5 }, 0, OPTS)).toBeNull();
    expect(timelineHeight(3, 16, 4)).toBe(60);
  });

  it("gauge angles clamp to the sweep and arcs end on the value angle", () => {
    expect(polarToCartesian(0, 0, 10, 90)).toEqual({ x: 0, y: 10 });
    expect(gaugeValueAngle(0, 0, 100)).toBe(GAUGE_START_ANGLE);
    expect(gaugeValueAngle(150, 0, 100)).toBe(GAUGE_START_ANGLE + GAUGE_SWEEP);
    expect(gaugeValueAngle(5, 5, 5)).toBe(GAUGE_START_ANGLE);
    const end = polarToCartesian(50, 50, 44, 270);
    expect(arcPath(50, 50, 44, 135, 270)).toBe(`M 18.89,81.11 A 44 44 0 0 1 ${end.x},${end.y}`);
    expect(arcPath(0, 0, 10, 135, 405)).toContain("A 10 10 0 1 1");
  });
});

describe("Sparkline", () => {
  it("renders a labelled img with one path and no tone by default", () => {
    render(<Sparkline values={[1, 2, 3, 2, 4]} />);
    const svg = screen.getByRole("img", { name: "sparkline" });
    expect(svg).toHaveAttribute("data-slot", "sparkline");
    expect(svg).toHaveAttribute("viewBox", "0 0 120 32");
    expect(svg).not.toHaveAttribute("data-tone");
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.outerHTML).not.toContain("NaN");
  });

  it("carries the status tone; an outline entry draws dashed", () => {
    const { rerender } = render(<Sparkline values={[1, 5, 3]} status={HEALTH.down} />);
    let svg = screen.getByRole("img", { name: "sparkline" });
    expect(svg).toHaveAttribute("data-tone", "danger");
    expect(svg.querySelector("path")).not.toHaveAttribute("stroke-dasharray");

    rerender(<Sparkline values={[1, 5, 3]} status={HEALTH.suppressed} />);
    svg = screen.getByRole("img", { name: "sparkline" });
    expect(svg).toHaveAttribute("data-tone", "neutral");
    expect(svg).toHaveAttribute("data-mark", "hatched");
    expect(svg.querySelector("path")).toHaveAttribute("stroke-dasharray", "4 3");

    rerender(<Sparkline values={[1, 5, 3]} status={HEALTH.unknown} />);
    svg = screen.getByRole("img", { name: "sparkline" });
    expect(svg).toHaveAttribute("data-mark", "solid");
    expect(svg.querySelector("path")).not.toHaveAttribute("stroke-dasharray");
  });

  it("never bridges a null gap and marks an isolated sample", () => {
    const { rerender } = render(
      <Sparkline
        samples={[
          { at: 0, value: 1 },
          { at: 1, value: 2 },
          { at: 2, value: null },
          { at: 3, value: 3 },
          { at: 4, value: 4 },
        ]}
      />,
    );
    expect(screen.getByRole("img").querySelectorAll("path")).toHaveLength(2);

    rerender(
      <Sparkline
        samples={[
          { at: 0, value: null },
          { at: 1, value: 7 },
        ]}
        ariaLabel="liveness history"
      />,
    );
    const svg = screen.getByRole("img", { name: "liveness history" });
    expect(svg.querySelector('[data-spark-point="single"]')).not.toBeNull();
  });

  it("renders an empty img below two points", () => {
    render(<Sparkline values={[1]} />);
    expect(screen.getByRole("img").querySelectorAll("path")).toHaveLength(0);
  });
});

describe("StatusTimeline", () => {
  const lane = (segments: TimelineSegment<Health>[]) => [{ id: "host-a", label: "host-a", segments }];

  it("renders one rect per visible segment in a labelled lane group, titled by the state", () => {
    render(
      <StatusTimeline
        lanes={lane([
          { status: "up", start: 0, end: 50 },
          { status: "down", start: 50, end: 100 },
          { status: "up", start: 200, end: 300 },
        ])}
        statusMap={HEALTH}
        domainStart={0}
        domainEnd={100}
      />,
    );
    const svg = screen.getByRole("img", { name: "status timeline" });
    expect(svg).toHaveAttribute("data-slot", "status-timeline");
    const group = screen.getByRole("group", { name: "host-a" });
    expect(group).toHaveAttribute("data-lane", "host-a");
    const rects = group.querySelectorAll("rect[data-status]");
    expect(rects).toHaveLength(2);
    expect(rects[0]).toHaveAttribute("data-status", "up");
    expect(rects[0]).toHaveAttribute("data-tone", "ok");
    expect(rects[1]).toHaveAttribute("data-status", "down");
    expect(rects[1]).toHaveAttribute("data-tone", "danger");
    expect(rects[1]!.querySelector("title")).toHaveTextContent("Down");
    expect(svg.querySelector("pattern")).toBeNull();
    expect(svg.outerHTML).not.toContain("NaN");
  });

  it("hatches an outline entry and keeps a solid one on the same tone solid", () => {
    render(
      <StatusTimeline
        lanes={lane([
          { status: "unknown", start: 0, end: 50 },
          { status: "suppressed", start: 50, end: 100 },
        ])}
        statusMap={HEALTH}
        domainStart={0}
        domainEnd={100}
      />,
    );
    const svg = screen.getByRole("img", { name: "status timeline" });
    const unknown = svg.querySelector('rect[data-status="unknown"]')!;
    const suppressed = svg.querySelector('rect[data-status="suppressed"]')!;
    expect(unknown).toHaveAttribute("data-tone", "neutral");
    expect(unknown).toHaveAttribute("data-mark", "solid");
    expect(unknown).not.toHaveAttribute("fill");
    expect(suppressed).toHaveAttribute("data-tone", "neutral");
    expect(suppressed).toHaveAttribute("data-mark", "hatched");
    const pattern = svg.querySelector("pattern")!;
    expect(suppressed.getAttribute("fill")).toBe(`url(#${pattern.id})`);
  });

  it("renders an empty img for no lanes", () => {
    render(<StatusTimeline lanes={[]} statusMap={HEALTH} domainStart={0} domainEnd={100} />);
    const svg = screen.getByRole("img", { name: "status timeline" });
    expect(svg).toHaveAttribute("viewBox", "0 0 320 0");
    expect(svg.querySelectorAll("rect")).toHaveLength(0);
  });
});

describe("Gauge", () => {
  it("renders track, value arc and the rounded value as the label", () => {
    render(<Gauge value={42.4} />);
    const svg = screen.getByRole("img", { name: "42" });
    expect(svg).toHaveAttribute("data-slot", "gauge");
    expect(svg.querySelector('[data-slot="gauge-track"]')).not.toBeNull();
    expect(svg.querySelector('[data-slot="gauge-value"]')).not.toHaveAttribute("data-tone");
    expect(svg.querySelector('[data-slot="gauge-label"]')!.textContent).toBe("42");
    expect(svg.querySelector('[data-slot="gauge-status"]')).toBeNull();
  });

  it("a status puts its tone on the value arc and its label under the value", () => {
    render(<Gauge value={90} label="90%" status={HEALTH.down} />);
    const svg = screen.getByRole("img", { name: "90%, Down" });
    expect(svg.querySelector('[data-slot="gauge-value"]')).toHaveAttribute("data-tone", "danger");
    expect(svg.querySelector('[data-slot="gauge-label"]')!.textContent).toBe("90%");
    expect(svg.querySelector('[data-slot="gauge-status"]')!.textContent).toBe("Down");
  });

  it("an outline entry draws a dashed arc", () => {
    render(<Gauge value={10} status={HEALTH.suppressed} />);
    const arc = screen.getByRole("img").querySelector('[data-slot="gauge-value"]')!;
    expect(arc).toHaveAttribute("data-tone", "neutral");
    expect(arc).toHaveAttribute("stroke-dasharray", "4 3");
  });

  it("survives a degenerate domain", () => {
    render(<Gauge value={5} min={5} max={5} />);
    expect(screen.getByRole("img").outerHTML).not.toContain("NaN");
  });
});

// @vitest-environment jsdom
// The viz charts as a runtime module gets them: imported from the @deck/sdk entry the import map serves.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import * as ui from "@/ui";

import { defineStatusMap, Gauge, Sparkline, StatusTimeline, type TimelineLane } from "../src/sdk/index.js";

afterEach(cleanup);

type Health = "up" | "down";
const HEALTH = defineStatusMap<Health>({
  up: { tone: "ok", icon: "circle-check", label: "Up" },
  down: { tone: "danger", icon: "circle-x", label: "Down" },
});

describe("@deck/sdk charts", () => {
  it("are the shell's own components, not copies", () => {
    expect(Gauge).toBe(ui.Gauge);
    expect(Sparkline).toBe(ui.Sparkline);
    expect(StatusTimeline).toBe(ui.StatusTimeline);
  });

  it("render Gauge as a named meter in its status tone", () => {
    render(<Gauge ariaLabel="Disk usage" value={42} status={HEALTH.down} />);
    const meter = screen.getByRole("meter", { name: "Disk usage" });
    expect(meter).toHaveAttribute("aria-valuenow", "42");
    expect(meter.outerHTML).toContain("stroke-status-danger-fg");
    expect(meter).toHaveTextContent("Down");
  });

  it("render Sparkline as a labelled image in its status tone", () => {
    render(<Sparkline values={[1, 3, 2]} status={HEALTH.up} ariaLabel="Latency, up" />);
    const svg = screen.getByRole("img", { name: "Latency, up" });
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.outerHTML).toContain("stroke-status-ok-fg");
  });

  it("render StatusTimeline with its text alternative, formatted by formatTime", () => {
    const lanes: TimelineLane<Health>[] = [{ id: "web", label: "web", segments: [{ status: "down", start: 0, end: 50 }] }];
    render(<StatusTimeline lanes={lanes} statusMap={HEALTH} domainStart={0} domainEnd={100} formatTime={(t) => `t${t}`} />);
    const root = screen.getByRole("group", { name: "status timeline" });
    const item = within(within(root).getByRole("list", { name: "web" })).getByRole("listitem");
    expect(item).toHaveTextContent("Down");
    expect(item).toHaveTextContent("t0");
    expect(item).toHaveTextContent("t50");
  });
});

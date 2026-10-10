import { describe, expect, it } from "vitest";

import { clampTiming, MAX_TIMER_MS, TIMING_FIELDS, timingProblem } from "../src/index.js";

describe("timing rule", () => {
  it("caps every field at the longest timer delay", () => {
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
    for (const field of TIMING_FIELDS) {
      expect(timingProblem(field, MAX_TIMER_MS)).toBeNull();
      expect(timingProblem(field, 3e9)).not.toBeNull();
    }
  });

  it.each([
    [1_000, null],
    [999, "pollIntervalMs must be a whole number of milliseconds from 1000 to 2147483647"],
    [1, "pollIntervalMs must be a whole number of milliseconds from 1000 to 2147483647"],
    [1500.5, "pollIntervalMs must be a whole number of milliseconds from 1000 to 2147483647"],
  ])("checks a poll interval of %s", (value, problem) => {
    expect(timingProblem("pollIntervalMs", value)).toBe(problem);
  });

  it.each([[1, true], [0.5, false], [0, false], [-1, false], [Number.NaN, false], [Number.POSITIVE_INFINITY, false], ["5", false]])(
    "accepts a timeout of %s: %s",
    (value, ok) => {
      expect(timingProblem("timeoutMs", value) === null).toBe(ok);
    },
  );

  it("clamps a finite number into range and refuses anything else", () => {
    expect(clampTiming("pollIntervalMs", 3e9)).toBe(MAX_TIMER_MS);
    expect(clampTiming("pollIntervalMs", 1)).toBe(1_000);
    expect(clampTiming("timeoutMs", 0.5)).toBe(1);
    expect(clampTiming("timeoutMs", 1500.4)).toBe(1_500);
    expect(clampTiming("timeoutMs", Number.NaN)).toBeUndefined();
    expect(clampTiming("timeoutMs", Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampTiming("timeoutMs", "5")).toBeUndefined();
  });
});

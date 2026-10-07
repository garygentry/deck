import { describe, expect, it } from "vitest";

import {
  ACTION_OUTCOMES,
  encodeRunEvent,
  isPreRunOutcome,
  type ActionOutcome,
  type ActionRunEvent,
} from "../src/actions/events.js";

describe("ACTION_OUTCOMES", () => {
  it("lists all six outcomes exactly once", () => {
    expect(ACTION_OUTCOMES).toEqual([
      "succeeded",
      "failed",
      "error",
      "rejected",
      "timed-out",
      "cancelled",
    ]);
    expect(new Set(ACTION_OUTCOMES).size).toBe(ACTION_OUTCOMES.length);
  });
});

describe("isPreRunOutcome", () => {
  it("returns true only for 'rejected'", () => {
    for (const outcome of ACTION_OUTCOMES) {
      expect(isPreRunOutcome(outcome)).toBe(outcome === "rejected");
    }
  });
});

describe("encodeRunEvent", () => {
  const cases: ActionRunEvent[] = [
    { type: "run", runId: "abc-123" },
    { type: "stdout", data: "hello" },
    { type: "stderr", data: "warn\nmore" },
    { type: "end", outcome: "succeeded", exit: 0, durationMs: 42 },
  ];

  it.each(cases)("serializes %o to a single trailing-newline JSON line", (event) => {
    const line = encodeRunEvent(event);
    expect(line.endsWith("\n")).toBe(true);
    // Exactly one newline, at the very end.
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual(event);
  });

  it("preserves embedded newlines inside data as escaped JSON (not as line breaks)", () => {
    const line = encodeRunEvent({ type: "stdout", data: "a\nb\nc" });
    // The literal chunk newlines are JSON-escaped, so the encoded line has a single
    // real newline terminator.
    expect(line.match(/\n/g)).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({ type: "stdout", data: "a\nb\nc" });
  });

  it("round-trips every terminal outcome", () => {
    for (const outcome of ACTION_OUTCOMES) {
      const event: ActionRunEvent = {
        type: "end",
        outcome: outcome as ActionOutcome,
        exit: outcome === "succeeded" ? 0 : null,
        durationMs: 1,
      };
      expect(JSON.parse(encodeRunEvent(event))).toEqual(event);
    }
  });
});

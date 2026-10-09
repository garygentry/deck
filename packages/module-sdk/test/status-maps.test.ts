import { describe, expect, it } from "vitest";

import { isTone, numberOf, statusTone, type StatusMapData } from "../src/index.js";

const LOAD: StatusMapData = { rules: [{ lt: 60, tone: "ok" }, { lt: 85, tone: "warn" }, { tone: "danger" }] };
const STATE: StatusMapData = { values: { running: "ok", stopped: "danger", "404": "warn", true: "info" } };

describe("statusTone", () => {
  it("gives a value-map entry by the value's text", () => {
    expect(statusTone(STATE, "running")).toBe("ok");
    expect(statusTone(STATE, "stopped")).toBe("danger");
    // Numbers and booleans compare as text.
    expect(statusTone(STATE, 404)).toBe("warn");
    expect(statusTone(STATE, true)).toBe("info");
    expect(statusTone(STATE, "paused")).toBeUndefined();
  });

  it("reads only the map's own entries, never inherited ones", () => {
    expect(statusTone(STATE, "toString")).toBeUndefined();
    expect(statusTone(STATE, "__proto__")).toBeUndefined();
    expect(statusTone(STATE, "constructor")).toBeUndefined();
  });

  it("takes the first rule whose every condition holds, a bare rule matching anything", () => {
    expect(statusTone(LOAD, 12)).toBe("ok");
    expect(statusTone(LOAD, 60)).toBe("warn");
    expect(statusTone(LOAD, 84.9)).toBe("warn");
    expect(statusTone(LOAD, 85)).toBe("danger");
    expect(statusTone(LOAD, "not a number")).toBe("danger");
    const band: StatusMapData = { rules: [{ gte: 10, lte: 20, tone: "ok" }, { gt: 20, tone: "warn" }] };
    expect(statusTone(band, 10)).toBe("ok");
    expect(statusTone(band, 20)).toBe("ok");
    expect(statusTone(band, 20.5)).toBe("warn");
    expect(statusTone(band, 9)).toBeUndefined();
  });

  it("compares bounds with numbers and text that is wholly a number only", () => {
    const map: StatusMapData = { rules: [{ lt: 50, tone: "ok" }] };
    expect(statusTone(map, "42")).toBe("ok");
    expect(statusTone(map, "4.2e1")).toBe("ok");
    expect(statusTone(map, " 42 ")).toBeUndefined();
    expect(statusTone(map, "42%")).toBeUndefined();
    expect(statusTone(map, "")).toBeUndefined();
    expect(statusTone(map, null)).toBeUndefined();
    expect(statusTone(map, true)).toBeUndefined();
    expect(statusTone(map, Number.NaN)).toBeUndefined();
    expect(statusTone(map, [1])).toBeUndefined();
  });

  it("matches eq by text, symmetrically, as values keys do", () => {
    const map: StatusMapData = { rules: [{ eq: 0, tone: "ok" }, { eq: "down", tone: "danger" }, { eq: false, tone: "warn" }, { eq: "42", tone: "info" }] };
    expect(statusTone(map, 0)).toBe("ok");
    expect(statusTone(map, "0")).toBe("ok");
    expect(statusTone(map, "down")).toBe("danger");
    expect(statusTone(map, false)).toBe("warn");
    expect(statusTone(map, "false")).toBe("warn");
    // Text in the rule matches the number in the data, and the other way round.
    expect(statusTone(map, 42)).toBe("info");
    expect(statusTone({ rules: [{ eq: 42, tone: "info" }] }, "42")).toBe("info");
    expect(statusTone(map, null)).toBeUndefined();
    expect(statusTone(map, { a: 1 })).toBeUndefined();
  });

  it("tries values before rules", () => {
    expect(statusTone({ values: { "99": "info" }, rules: [{ tone: "danger" }] }, 99)).toBe("info");
    expect(statusTone({ values: { "99": "info" }, rules: [{ tone: "danger" }] }, 98)).toBe("danger");
  });

  it("matches nothing for a missing or malformed map, an unknown tone or a non-number bound", () => {
    expect(statusTone(undefined, "running")).toBeUndefined();
    expect(statusTone({ values: { running: "green" as never } }, "running")).toBeUndefined();
    expect(statusTone({ rules: [{ tone: "red" as never }] }, 1)).toBeUndefined();
    expect(statusTone({ rules: [{ lt: "5" as never, tone: "ok" }] }, 1)).toBeUndefined();
    expect(statusTone({ rules: "nope" as never }, 1)).toBeUndefined();
    expect(statusTone(null as never, 1)).toBeUndefined();
  });
});

describe("isTone and numberOf", () => {
  it("knows the six tones", () => {
    expect(["ok", "warn", "danger", "info", "pending", "neutral"].every(isTone)).toBe(true);
    expect(isTone("success")).toBe(false);
  });

  it("reads finite numbers and wholly numeric text", () => {
    expect(numberOf(3)).toBe(3);
    expect(numberOf("-1.5")).toBe(-1.5);
    expect(numberOf(".5")).toBe(0.5);
    expect(numberOf("1e400")).toBeUndefined();
    expect(numberOf(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(numberOf("0x10")).toBeUndefined();
  });
});

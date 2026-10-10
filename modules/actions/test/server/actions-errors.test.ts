import { describe, expect, it } from "vitest";

import {
  ACTION_RUN_CODE_TO_OUTCOME,
  ACTION_RUN_ERROR_CODES,
  ACTION_RUN_MESSAGES,
  ActionRunFailure,
  normalizeActionFailure,
} from "../../server/errors.js";

describe("error tables", () => {
  it("has a message and outcome mapping for every code", () => {
    for (const code of ACTION_RUN_ERROR_CODES) {
      expect(typeof ACTION_RUN_MESSAGES[code]).toBe("string");
      expect(ACTION_RUN_CODE_TO_OUTCOME[code]).toBeDefined();
    }
  });
});

describe("ActionRunFailure", () => {
  it("derives outcome from code", () => {
    expect(new ActionRunFailure("REJECTED", "x").outcome).toBe("rejected");
    expect(new ActionRunFailure("SPAWN_ERROR", "x").outcome).toBe("error");
    expect(new ActionRunFailure("TIMED_OUT", "x").outcome).toBe("timed-out");
    expect(new ActionRunFailure("CANCELLED", "x").outcome).toBe("cancelled");
    expect(new ActionRunFailure("INTERNAL", "x").outcome).toBe("error");
  });

  it("toPublic strips internal details beyond httpStatus/paramErrors", () => {
    const paramErrors = [{ name: "port", message: "must be a number" }];
    const failure = new ActionRunFailure("REJECTED", "refused", {
      httpStatus: 400,
      paramErrors,
      publicCode: "PARAMS_INVALID",
    });
    const pub = failure.toPublic();
    expect(pub).toEqual({
      code: "REJECTED",
      message: "refused",
      outcome: "rejected",
      httpStatus: 400,
      paramErrors,
    });
    // publicCode (internal-only) never leaks.
    expect("publicCode" in pub).toBe(false);
  });

  it("omits httpStatus/paramErrors when absent", () => {
    const pub = new ActionRunFailure("INTERNAL", "boom").toPublic();
    expect(pub).toEqual({ code: "INTERNAL", message: "boom", outcome: "error" });
    expect("httpStatus" in pub).toBe(false);
    expect("paramErrors" in pub).toBe(false);
  });
});

describe("normalizeActionFailure", () => {
  it("preserves an existing ActionRunFailure", () => {
    const original = new ActionRunFailure("SPAWN_ERROR", "nope");
    expect(normalizeActionFailure(original)).toBe(original);
  });

  it("maps a bare AbortError shape to TIMED_OUT", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const failure = normalizeActionFailure(err);
    expect(failure.code).toBe("TIMED_OUT");
    expect(failure.outcome).toBe("timed-out");
    expect(failure.message).toBe(ACTION_RUN_MESSAGES.TIMED_OUT);
  });

  it("maps a TimeoutError shape to TIMED_OUT", () => {
    const err = Object.assign(new Error("slow"), { name: "TimeoutError" });
    expect(normalizeActionFailure(err).code).toBe("TIMED_OUT");
  });

  it("maps an AbortError carrying a cancel reason to CANCELLED", () => {
    const direct = Object.assign(new Error("aborted"), {
      name: "AbortError",
      cancelReason: "cancelled",
    });
    expect(normalizeActionFailure(direct).code).toBe("CANCELLED");
    expect(normalizeActionFailure(direct).outcome).toBe("cancelled");

    const viaCause = Object.assign(new Error("aborted"), {
      name: "AbortError",
      cause: { cancelReason: "cancelled" },
    });
    expect(normalizeActionFailure(viaCause).code).toBe("CANCELLED");
  });

  it("maps ENOENT/EACCES/spawn syscall shapes to SPAWN_ERROR", () => {
    expect(
      normalizeActionFailure(Object.assign(new Error("x"), { code: "ENOENT" })).code,
    ).toBe("SPAWN_ERROR");
    expect(
      normalizeActionFailure(Object.assign(new Error("x"), { code: "EACCES" })).code,
    ).toBe("SPAWN_ERROR");
    expect(
      normalizeActionFailure(
        Object.assign(new Error("x"), { syscall: "spawn /usr/bin/runner" }),
      ).code,
    ).toBe("SPAWN_ERROR");
  });

  it("maps everything else to a sanitized INTERNAL", () => {
    for (const value of [null, undefined, "boom", 42, {}, new Error("plain")]) {
      const failure = normalizeActionFailure(value);
      expect(failure.code).toBe("INTERNAL");
      expect(failure.message).toBe(ACTION_RUN_MESSAGES.INTERNAL);
    }
  });
});

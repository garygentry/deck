import { describe, expect, it } from "vitest";

import type { Action, ActionParam } from "../../server/config.generated.js";

import {
  validateActionParams,
  type ParamError,
  type ValidateResult,
} from "../../server/validate.js";

/** Build a minimal Action wrapping the given params. */
function actionWith(params: ActionParam[]): Action {
  return {
    id: "act",
    title: "Act",
    runner: "runner",
    confirm: "none",
    params,
  };
}

/** Validate a single-param action and return the result. */
function one(param: ActionParam, raw: Record<string, unknown>): ValidateResult {
  return validateActionParams(actionWith([param]), raw);
}

function errorsOf(result: ValidateResult): ParamError[] {
  return result.ok ? [] : result.errors;
}

describe("validateActionParams — exports & result shape", () => {
  it("returns { ok: true, values } on success and never both branches", () => {
    const result = one({ name: "s", type: "string" }, { s: "x" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toEqual({ s: "x" });
      expect("errors" in result).toBe(false);
    }
  });

  it("returns { ok: false, errors } on failure and carries no values", () => {
    const result = one({ name: "n", type: "number", required: true }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBe(1);
      expect("values" in result).toBe(false);
    }
  });
});

describe("validateActionParams — never throws (fuzz)", () => {
  const weirdValues: unknown[] = [
    {},
    [],
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    () => "fn",
    Symbol("s"),
    123n,
    new Date(),
    { toString: () => { throw new Error("boom"); } },
  ];
  const types: ActionParam["type"][] = ["string", "number", "boolean", "enum"];

  it("returns a ValidateResult for any raw value across every declared type", () => {
    for (const type of types) {
      for (const value of weirdValues) {
        const param: ActionParam =
          type === "enum" ? { name: "p", type, values: ["a"] } : { name: "p", type };
        expect(() => one(param, { p: value })).not.toThrow();
        const result = one(param, { p: value });
        expect(typeof result.ok).toBe("boolean");
      }
    }
  });

  it("tolerates a raw record that is itself empty or has extraneous keys", () => {
    const action = actionWith([{ name: "s", type: "string" }]);
    expect(() => validateActionParams(action, {})).not.toThrow();
    expect(() =>
      validateActionParams(action, { s: "ok", extra: {}, more: [1, 2] }),
    ).not.toThrow();
  });
});

describe("string coercion", () => {
  it("takes a string as-is", () => {
    expect(one({ name: "s", type: "string" }, { s: "nginx" })).toEqual({
      ok: true,
      values: { s: "nginx" },
    });
  });

  it("stringifies a number and a boolean", () => {
    expect(one({ name: "s", type: "string" }, { s: 5 })).toEqual({
      ok: true,
      values: { s: "5" },
    });
    expect(one({ name: "s", type: "string" }, { s: true })).toEqual({
      ok: true,
      values: { s: "true" },
    });
  });

  it("rejects an object and an array", () => {
    expect(one({ name: "s", type: "string" }, { s: {} }).ok).toBe(false);
    expect(one({ name: "s", type: "string" }, { s: [1] }).ok).toBe(false);
    expect(errorsOf(one({ name: "s", type: "string" }, { s: {} }))[0].message).toBe(
      "must be text.",
    );
  });
});

describe("number coercion", () => {
  it("accepts a finite number and a numeric string (trimmed)", () => {
    expect(one({ name: "n", type: "number" }, { n: 42 })).toEqual({
      ok: true,
      values: { n: 42 },
    });
    expect(one({ name: "n", type: "number" }, { n: "42" })).toEqual({
      ok: true,
      values: { n: 42 },
    });
    expect(one({ name: "n", type: "number" }, { n: " 42 " })).toEqual({
      ok: true,
      values: { n: 42 },
    });
  });

  it("rejects '12px', NaN, Infinity, and boolean", () => {
    expect(one({ name: "n", type: "number" }, { n: "12px" }).ok).toBe(false);
    expect(one({ name: "n", type: "number" }, { n: Number.NaN }).ok).toBe(false);
    expect(one({ name: "n", type: "number" }, { n: Number.POSITIVE_INFINITY }).ok).toBe(
      false,
    );
    expect(one({ name: "n", type: "number" }, { n: true }).ok).toBe(false);
    expect(errorsOf(one({ name: "n", type: "number" }, { n: "12px" }))[0].message).toBe(
      "must be a number.",
    );
  });
});

describe("boolean coercion", () => {
  it("accepts true/false booleans", () => {
    expect(one({ name: "b", type: "boolean" }, { b: true })).toEqual({
      ok: true,
      values: { b: true },
    });
    expect(one({ name: "b", type: "boolean" }, { b: false })).toEqual({
      ok: true,
      values: { b: false },
    });
  });

  it("accepts 'true'/'false' case-insensitively and trimmed", () => {
    expect(one({ name: "b", type: "boolean" }, { b: "TRUE" })).toEqual({
      ok: true,
      values: { b: true },
    });
    expect(one({ name: "b", type: "boolean" }, { b: " false " })).toEqual({
      ok: true,
      values: { b: false },
    });
  });

  it("rejects '1', 'yes', and 2", () => {
    expect(one({ name: "b", type: "boolean" }, { b: "1" }).ok).toBe(false);
    expect(one({ name: "b", type: "boolean" }, { b: "yes" }).ok).toBe(false);
    expect(one({ name: "b", type: "boolean" }, { b: 2 }).ok).toBe(false);
    expect(errorsOf(one({ name: "b", type: "boolean" }, { b: "yes" }))[0].message).toBe(
      "must be true or false.",
    );
  });
});

describe("enum coercion", () => {
  const enumParam: ActionParam = { name: "e", type: "enum", values: ["nginx", "api"] };

  it("accepts a declared member", () => {
    expect(one(enumParam, { e: "nginx" })).toEqual({
      ok: true,
      values: { e: "nginx" },
    });
  });

  it("rejects a non-member with a message listing the allowed values", () => {
    const result = one(enumParam, { e: "postgres" });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0].message).toBe("must be one of: nginx, api.");
  });

  it("reports the config error when values is absent or empty", () => {
    expect(errorsOf(one({ name: "e", type: "enum" }, { e: "x" }))[0].message).toBe(
      "enum parameter declares no allowed values (config error).",
    );
    expect(
      errorsOf(one({ name: "e", type: "enum", values: [] }, { e: "x" }))[0].message,
    ).toBe("enum parameter declares no allowed values (config error).");
  });
});

describe("absence, required, and defaults", () => {
  it("absent required → MSG.required", () => {
    const result = one({ name: "s", type: "string", required: true }, {});
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toEqual({ name: "s", message: '"s" is required.' });
  });

  it("treats null and empty string as absent for a required param", () => {
    expect(one({ name: "s", type: "string", required: true }, { s: null }).ok).toBe(false);
    expect(one({ name: "s", type: "string", required: true }, { s: "" }).ok).toBe(false);
  });

  it("optional absent + no default → omitted from values", () => {
    const result = validateActionParams(
      actionWith([
        { name: "keep", type: "string" },
        { name: "drop", type: "number" },
      ]),
      { keep: "here" },
    );
    expect(result).toEqual({ ok: true, values: { keep: "here" } });
    if (result.ok) expect("drop" in result.values).toBe(false);
  });

  it("absent + default → coerced default applied", () => {
    expect(one({ name: "b", type: "boolean", default: false }, {})).toEqual({
      ok: true,
      values: { b: false },
    });
    // A JSON default of a different primitive is coerced through the declared type.
    expect(one({ name: "n", type: "number", default: 7 }, {})).toEqual({
      ok: true,
      values: { n: 7 },
    });
  });

  it("a default mismatching its declared type → defaultInvalid error", () => {
    const result = one({ name: "n", type: "number", default: "not-a-number" }, {});
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0].message).toBe(
      'default value for "n" does not match its type (config error).',
    );
  });

  it("required with a valid default applies the default when absent (default wins over required)", () => {
    expect(
      one({ name: "n", type: "number", required: true, default: 3 }, {}),
    ).toEqual({ ok: true, values: { n: 3 } });
  });
});

describe("ordering, undeclared keys, and multi-failure collection", () => {
  it("values insertion order equals declared params[] order", () => {
    const result = validateActionParams(
      actionWith([
        { name: "alpha", type: "string" },
        { name: "beta", type: "number" },
        { name: "gamma", type: "boolean" },
      ]),
      { gamma: "true", beta: "2", alpha: "a" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.values)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("drops undeclared raw keys silently, never errors on them", () => {
    const result = validateActionParams(actionWith([{ name: "s", type: "string" }]), {
      s: "ok",
      stale: "ignored",
      nested: { a: 1 },
    });
    expect(result).toEqual({ ok: true, values: { s: "ok" } });
  });

  it("an input failing three params returns three ParamErrors (one per failing param)", () => {
    const action = actionWith([
      { name: "service", type: "enum", required: true, values: ["nginx", "api"] },
      { name: "force", type: "boolean" },
      { name: "delaySec", type: "number" },
    ]);
    const result = validateActionParams(action, { force: "maybe", delaySec: "soon" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { name: "service", message: '"service" is required.' },
        { name: "force", message: "must be true or false." },
        { name: "delaySec", message: "must be a number." },
      ]);
    }
  });

  it("handles an action with no declared params (undefined params[])", () => {
    const action: Action = { id: "x", title: "X", runner: "r", confirm: "none" };
    expect(validateActionParams(action, { anything: 1 })).toEqual({
      ok: true,
      values: {},
    });
  });
});

describe("spec example usage (§2.11)", () => {
  const action: Action = {
    id: "restart-svc",
    title: "Restart service",
    runner: "restart",
    confirm: "confirm",
    params: [
      { name: "service", type: "enum", required: true, values: ["nginx", "api"] },
      { name: "force", type: "boolean", default: false },
      { name: "delaySec", type: "number", required: false },
    ],
  };

  it("succeeds for a form submission of strings, omitting the absent optional", () => {
    expect(validateActionParams(action, { service: "nginx", force: "true" })).toEqual({
      ok: true,
      values: { service: "nginx", force: true },
    });
  });

  it("collects one error per failing param", () => {
    expect(validateActionParams(action, { force: "maybe", delaySec: "soon" })).toEqual({
      ok: false,
      errors: [
        { name: "service", message: '"service" is required.' },
        { name: "force", message: "must be true or false." },
        { name: "delaySec", message: "must be a number." },
      ],
    });
  });
});

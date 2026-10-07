/**
 * Pure parameter validator for governed actions: the authoritative gate that runs on the
 * server before any runner is spawned, and runs unchanged in the browser for live per-field
 * feedback, so the rules can never diverge.
 *
 * Transitional home: this is the actions module's code, shared by its server and web halves.
 * It lives in the wire contract only until the actions module is co-located in its own
 * package with a shared half, which it then moves to.
 *
 * PURE: no I/O, no clock, and it NEVER throws. Every failure mode is a returned
 * `{ ok: false; errors }`, one `ParamError` per failing parameter, so it can never crash the
 * route nor silently pass an invalid value to the runner.
 *
 * The input types are structural: the actions module's generated `Action` (from its config
 * schema) must stay assignable to {@link ValidatableAction}, which the server checks at
 * compile time.
 */

/** The declared parameter fields the validator reads. */
export interface ValidatableParam {
  /** Parameter name, unique within the action. */
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "enum";
  readonly required?: boolean;
  readonly default?: unknown;
  /** Allowed values when the type is enum. */
  readonly values?: readonly string[];
}

/** The declared action fields the validator reads. */
export interface ValidatableAction {
  readonly params?: readonly ValidatableParam[];
}

/** A concrete, coerced parameter value passed to the runner and audited. */
export type ActionParamValue = string | number | boolean;

/** Resolved, validated parameter values keyed by `ActionParam.name`, in declared order. */
export type ResolvedParams = Record<string, ActionParamValue>;

/** One per-parameter validation failure, surfaced to the UI. */
export interface ParamError {
  /** The `ActionParam.name` that failed. */
  name: string;
  /** Human-readable, safe message (e.g. "must be a number", "not an allowed value"). */
  message: string;
}

/**
 * Result of validating raw parameter input against an action's declared `params[]`.
 * Discriminated union: never both `values` and `errors`.
 */
export type ValidateResult =
  | { ok: true; values: ResolvedParams }
  | { ok: false; errors: ParamError[] };

/**
 * Validate raw parameter input against an action's declared `params[]`.
 *
 * On success, `values` carries one entry per declared parameter that is present
 * or has a default, coerced to its declared type, inserted in DECLARED ORDER.
 * Optional parameters that are absent and have no default are omitted. On
 * failure, `errors` carries one `ParamError` per failing parameter — all
 * failures are collected, not just the first. Keys in `raw` not declared by the
 * action are dropped silently, never coerced and never errored.
 *
 * @param action The declared action whose `params[]` define the rules (frozen schema).
 * @param raw    Untrusted raw values keyed by `ActionParam.name`.
 * @returns A discriminated `ValidateResult`; never throws.
 */
export function validateActionParams(
  action: ValidatableAction,
  raw: Record<string, unknown>,
): ValidateResult {
  const params = action.params ?? [];
  const values: ResolvedParams = {};
  const errors: ParamError[] = [];

  // Iterate in DECLARED ORDER so `values` insertion order matches params[].
  for (const p of params) {
    const rawVal = raw[p.name];

    if (isAbsent(rawVal)) {
      // Absent: apply default, else fail if required, else omit.
      if (p.default !== undefined) {
        const applied = coerceDefault(p);
        if (applied.ok) values[p.name] = applied.value;
        else errors.push({ name: p.name, message: applied.message });
      } else if (p.required === true) {
        errors.push({ name: p.name, message: MSG.required(p.name) });
      }
      // optional + no default + absent => omit from values (nothing pushed).
      continue;
    }

    // Present: coerce/check by declared type.
    const result = coerceByType(p, rawVal);
    if (result.ok) values[p.name] = result.value;
    else errors.push({ name: p.name, message: result.message });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

/** A raw value counts as "not supplied" when undefined, null, or empty string. */
function isAbsent(rawVal: unknown): boolean {
  return rawVal === undefined || rawVal === null || rawVal === "";
}

/** Coerce a present value to a string; number/boolean stringify, other shapes reject. */
function coerceString(rawVal: unknown): CoerceOk | CoerceErr {
  if (typeof rawVal === "string") return ok(rawVal);
  if (typeof rawVal === "number" || typeof rawVal === "boolean") return ok(String(rawVal));
  return err(MSG.string());
}

/** Coerce a present value to a finite number; reject NaN/Infinity/"12px"/boolean. */
function coerceNumber(rawVal: unknown): CoerceOk | CoerceErr {
  if (typeof rawVal === "number") {
    return Number.isFinite(rawVal) ? ok(rawVal) : err(MSG.number());
  }
  if (typeof rawVal === "string") {
    const n = Number(rawVal.trim());
    return Number.isFinite(n) ? ok(n) : err(MSG.number());
  }
  return err(MSG.number());
}

/** Coerce a present value to a boolean; strings must be exactly "true"/"false". */
function coerceBoolean(rawVal: unknown): CoerceOk | CoerceErr {
  if (typeof rawVal === "boolean") return ok(rawVal);
  if (typeof rawVal === "string") {
    const s = rawVal.trim().toLowerCase();
    if (s === "true") return ok(true);
    if (s === "false") return ok(false);
  }
  return err(MSG.boolean());
}

/** Coerce to string and require membership in the declared `values`. */
function coerceEnum(p: ValidatableParam, rawVal: unknown): CoerceOk | CoerceErr {
  const allowed = p.values ?? [];
  if (allowed.length === 0) return err(MSG.enumUnconfigured());
  const asString =
    typeof rawVal === "string"
      ? rawVal
      : typeof rawVal === "number" || typeof rawVal === "boolean"
        ? String(rawVal)
        : undefined;
  if (asString !== undefined && allowed.includes(asString)) return ok(asString);
  return err(MSG.enum(allowed));
}

/** Dispatch coercion on the declared type; exhaustive over the frozen union. */
function coerceByType(p: ValidatableParam, rawVal: unknown): CoerceOk | CoerceErr {
  switch (p.type) {
    case "string":
      return coerceString(rawVal);
    case "number":
      return coerceNumber(rawVal);
    case "boolean":
      return coerceBoolean(rawVal);
    case "enum":
      return coerceEnum(p, rawVal);
    default: {
      // Exhaustiveness: the frozen schema union is closed. If a future
      // schema adds a type, this surfaces it deterministically rather than
      // passing an unknown value to the runner.
      const _exhaustive: never = p.type;
      return err(MSG.unknownType(String(_exhaustive)));
    }
  }
}

/**
 * Apply a declared default by running it through the SAME type coercion as user
 * input, so a config-authored default that does not match its own declared type
 * is surfaced as a validation error rather than silently coerced.
 */
function coerceDefault(p: ValidatableParam): CoerceOk | CoerceErr {
  const result = coerceByType(p, p.default as unknown);
  if (result.ok) return result;
  return err(MSG.defaultInvalid(p.name));
}

/** Small internal result helpers (not exported). */
type CoerceOk = { ok: true; value: ActionParamValue };
type CoerceErr = { ok: false; message: string };
const ok = (value: ActionParamValue): CoerceOk => ({ ok: true, value });
const err = (message: string): CoerceErr => ({ ok: false, message });

/**
 * Canonical, safe, deterministic per-parameter messages. Each echoes only the parameter's
 * own declared `name`/`values`, never upstream text.
 */
const MSG = {
  required: (name: string) => `"${name}" is required.`,
  string: () => "must be text.",
  number: () => "must be a number.",
  boolean: () => "must be true or false.",
  enum: (allowed: readonly string[]) => `must be one of: ${allowed.join(", ")}.`,
  enumUnconfigured: () => "enum parameter declares no allowed values (config error).",
  defaultInvalid: (name: string) =>
    `default value for "${name}" does not match its type (config error).`,
  unknownType: (type: string) => `unsupported parameter type "${type}" (config error).`,
} as const;

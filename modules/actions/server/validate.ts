import type { ValidatableAction } from "@deck/contract/actions";

import type { Action } from "./config.generated.js";

/**
 * The governed-actions parameter validator, shared with the web through
 * `@deck/contract/actions`. The route imports it from here.
 */
export {
  validateActionParams,
  type ActionParamValue,
  type ParamError,
  type ResolvedParams,
  type ValidateResult,
} from "@deck/contract/actions";

/**
 * Compile-time check: the validator's structural input must accept every declared action.
 * A schema change (a new parameter type, say) that breaks this fails typecheck here.
 */
type Assignable<T extends ValidatableAction> = T;
export type CheckedAction = Assignable<Action>;

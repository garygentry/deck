/**
 * The governed-actions wire types, for the web's actions feature. Types only: importing this
 * entry point never pulls server code into a bundle. Each type is re-exported from the module
 * that defines it.
 */
export type { Action, ActionParam, ActionsModuleConfig } from "./config.generated.js";
export type { ActionOutcome, ActionRunEvent, StructuredRunnerInput } from "./events.js";
export type { ActionParamValue, ParamError, ResolvedParams, ValidateResult } from "@deck/contract/actions";
export type { AuditDetail, AuditEntry, AuditListItem, AuditTarget } from "./audit.js";

/**
 * Actions capability probe. Answered with HTTP 200 whether or not the capability
 * is enabled, so the web can gate its audit poll without provoking a 403.
 */
export interface ActionsCapabilityResponse {
  /** True only when the governed-actions runtime is configured and enabled. */
  enabled: boolean;
}

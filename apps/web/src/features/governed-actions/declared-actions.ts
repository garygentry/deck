/**
 * The declared actions the page lists, read from `/api/config`. The actions module owns the
 * `modules.actions` section, so the config type leaves it open, and while the module is
 * switched off deck does not hold the section to its schema. A section that is not a list of
 * action-shaped objects therefore lists nothing rather than breaking the page.
 */

import type { DeckConfig } from "@deck/server";
import type { Action } from "@deck/server/actions";

const CONFIRM_POLICIES: ReadonlySet<unknown> = new Set(["none", "confirm", "typed-confirm"]);
const PARAM_TYPES: ReadonlySet<unknown> = new Set(["string", "number", "boolean", "enum"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
const isString = (value: unknown): boolean => typeof value === "string";
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every(isString);

function isParam(value: unknown): boolean {
  return isRecord(value)
    && isString(value.name)
    && PARAM_TYPES.has(value.type)
    && optional(value.required, (v) => typeof v === "boolean")
    && optional(value.values, isStringList)
    && optional(value.description, isString);
}

function isAction(value: unknown): value is Action {
  return isRecord(value)
    && isString(value.id)
    && isString(value.title)
    && isString(value.runner)
    && CONFIRM_POLICIES.has(value.confirm)
    && optional(value.params, (v) => Array.isArray(v) && v.every(isParam))
    && optional(value.target, (v) => isRecord(v) && isString(v.host) && optional(v.service, isString))
    && optional(value.description, isString);
}

/** `modules.actions.actions` when it is a list of action-shaped objects, else `[]`. */
export function declaredActions(config: DeckConfig): readonly Action[] {
  const modules: unknown = config.modules;
  const section = isRecord(modules) ? modules.actions : undefined;
  const actions = isRecord(section) ? section.actions : undefined;
  return Array.isArray(actions) && actions.every(isAction) ? actions : [];
}

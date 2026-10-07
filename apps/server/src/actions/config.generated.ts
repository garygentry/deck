/* GENERATED from src/actions/schema.json by src/scripts/gen-module-types.ts — do not edit; run `pnpm gen:module-types`. */

/**
 * Optional default value matching the declared type.
 */
export type JsonValue = (string | number | boolean | null | JsonValue1[] | {
[k: string]: JsonValue1 | undefined
})
/**
 * Any value representable in JSON.
 */
export type JsonValue1 = (string | number | boolean | null | JsonValue1[] | {
[k: string]: JsonValue1 | undefined
})

/**
 * Settings of the actions module, at modules.actions.
 */
export interface ActionsModuleConfig {
/**
 * Governed actions; absent is equivalent to an empty array.
 */
actions?: Action[]
}
export interface Action {
/**
 * Action id, unique across actions.
 */
id: string
/**
 * Human-readable action label.
 */
title: string
/**
 * Estate-side runner or playbook name, never a command.
 */
runner: string
/**
 * Confirmation policy before running.
 */
confirm: ("none" | "confirm" | "typed-confirm")
/**
 * Typed parameters accepted by the runner.
 */
params?: ActionParam[]
/**
 * Optional host or service target.
 */
target?: {
/**
 * Target host name.
 */
host: string
/**
 * Optional target service name on that host.
 */
service?: string
}
/**
 * Optional longer action description.
 */
description?: string
}
export interface ActionParam {
/**
 * Parameter name, unique within the action.
 */
name: string
/**
 * Parameter value type.
 */
type: ("string" | "number" | "boolean" | "enum")
/**
 * Whether the parameter must be supplied.
 */
required?: boolean
default?: JsonValue
/**
 * Allowed values when the type is enum.
 */
values?: string[]
/**
 * Optional parameter description.
 */
description?: string
}

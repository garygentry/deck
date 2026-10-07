/**
 * Typed parameter form for the selected action.
 *
 * Generates one field per declared `ActionParam`, honoring `type`, `required`,
 * `default`, and (for `enum`) `values`. The parent runs the shared
 * `validateActionParams` on every change and passes back the per-field
 * `errors`; the server re-validates authoritatively before spawning. This form
 * never calls the server itself — it only produces the raw value map and
 * surfaces the current per-field errors.
 */

import type { Action, ActionParam, ParamError } from "@deck/server";
import type { JSX } from "react";
import { Checkbox, Icon, Input, Label, cn } from "@/ui";

/** Props for {@link ParamForm}. */
export interface ParamFormProps {
  /** The selected action whose `params[]` drives the fields. */
  readonly action: Action;
  /** Current raw input values keyed by ActionParam.name (strings, numbers, booleans). */
  readonly values: Readonly<Record<string, unknown>>;
  /** Raised when a single field changes; the parent holds the value map. */
  readonly onChange: (name: string, value: unknown) => void;
  /** Live per-parameter errors from validateActionParams (empty when valid). */
  readonly errors: readonly ParamError[];
  /** When true, all inputs are disabled (e.g. a run is in flight). */
  readonly disabled?: boolean;
}

/**
 * Build the initial raw value map for an action, seeding each param with its
 * declared `default` when present. Pure; exported for the parent
 * and for tests.
 */
export function initialParamValues(action: Action): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const param of action.params ?? []) {
    if (param.default !== undefined) values[param.name] = param.default;
  }
  return values;
}

/** The first error message for a named param, or undefined when it validates. */
function errorFor(errors: readonly ParamError[], name: string): string | undefined {
  return errors.find((error) => error.name === name)?.message;
}

/** A raw value as the text a text/number/select control shows. */
function asText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * The enum control is a native `<select>` styled like `Input`: it keeps native
 * semantics (keyboard type-ahead, the mobile picker, a real empty "Select a
 * value…" option, which Radix Select cannot model) and the same aria contract as
 * every other field.
 */
const SELECT_CLASS = cn(
  "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
);

/** ARIA wiring every control shares. */
interface ControlAria {
  readonly id: string;
  readonly "aria-required": "true" | undefined;
  readonly "aria-invalid": "true" | undefined;
  readonly "aria-describedby": string | undefined;
}

/** Render the control matching one param's declared type. */
function ParamControl({
  param,
  value,
  aria,
  disabled,
  onChange,
}: {
  readonly param: ActionParam;
  readonly value: unknown;
  readonly aria: ControlAria;
  readonly disabled: boolean;
  readonly onChange: (name: string, value: unknown) => void;
}): JSX.Element {
  switch (param.type) {
    case "boolean":
      return (
        <Checkbox
          {...aria}
          name={param.name}
          disabled={disabled}
          checked={value === true}
          onCheckedChange={(checked) => onChange(param.name, checked === true)}
        />
      );
    case "number":
      return (
        <Input
          {...aria}
          name={param.name}
          disabled={disabled}
          type="number"
          inputMode="decimal"
          className="max-w-xs"
          value={asText(value)}
          onChange={(event) => onChange(param.name, event.currentTarget.value)}
        />
      );
    case "enum":
      return (
        <select
          {...aria}
          name={param.name}
          disabled={disabled}
          className={cn(SELECT_CLASS, "max-w-xs")}
          value={asText(value)}
          onChange={(event) => onChange(param.name, event.currentTarget.value)}
        >
          {value === undefined ? <option value="">Select a value…</option> : null}
          {(param.values ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "string":
    default:
      return (
        <Input
          {...aria}
          name={param.name}
          disabled={disabled}
          type="text"
          className="max-w-md"
          value={asText(value)}
          onChange={(event) => onChange(param.name, event.currentTarget.value)}
        />
      );
  }
}

/**
 * Render one labelled field per declared parameter. Required fields carry a
 * visible text marker and `aria-required`; the description and, when invalid,
 * the error message are linked by `aria-describedby`; invalid fields set
 * `aria-invalid` and render their message in a `role="alert"` region.
 */
export function ParamForm({
  action,
  values,
  onChange,
  errors,
  disabled = false,
}: ParamFormProps): JSX.Element {
  const params = action.params ?? [];
  if (params.length === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        This action takes no parameters.
      </p>
    );
  }

  return (
    <div data-slot="actions-param-form" className="flex flex-col gap-4">
      {params.map((param) => {
        const id = `actions-param-${param.name}`;
        const message = errorFor(errors, param.name);
        const invalid = message !== undefined;
        const descriptionId = `${id}-description`;
        const errorId = `${id}-error`;
        const describedBy =
          [param.description !== undefined ? descriptionId : null, invalid ? errorId : null]
            .filter((part): part is string => part !== null)
            .join(" ") || undefined;
        const required = param.required === true;
        const aria: ControlAria = {
          id,
          "aria-required": required ? "true" : undefined,
          "aria-invalid": invalid ? "true" : undefined,
          "aria-describedby": describedBy,
        };
        const label = (
          <Label htmlFor={id} className="font-mono">
            {param.name}
            {required ? (
              <span className="font-sans font-normal text-muted-foreground">{" "}(required)</span>
            ) : null}
          </Label>
        );
        const control = (
          <ParamControl
            param={param}
            value={values[param.name]}
            aria={aria}
            disabled={disabled}
            onChange={onChange}
          />
        );
        return (
          <div key={param.name} className="flex flex-col gap-1.5">
            {param.type === "boolean" ? (
              <div className="flex items-center gap-2">
                {control}
                {label}
              </div>
            ) : (
              label
            )}
            {param.description !== undefined ? (
              <p id={descriptionId} className="text-xs text-muted-foreground">
                {param.description}
              </p>
            ) : null}
            {param.type === "boolean" ? null : control}
            {invalid ? (
              <p
                id={errorId}
                role="alert"
                className="flex items-center gap-1.5 text-sm text-status-danger-fg"
              >
                <Icon name="circle-x" size={14} className="shrink-0" />
                {message}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

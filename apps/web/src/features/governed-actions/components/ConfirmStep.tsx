/**
 * Confirm step for the selected action.
 *
 * Owns the confirm-mode state machine and shows the DECLARED INTENT of the run.
 * It never synthesizes or displays a shell command — deck does not know it.
 */

import type { ResolvedParams } from "@deck/contract/actions";
import type { Action } from "@deck/server/actions";
import type { JSX, KeyboardEvent } from "react";
import { Button, Callout, Icon, Input, KeyValue, KeyValueList, Label } from "@/ui";
import {
  resolveActionIntent,
  shouldPreventActionDefault,
} from "../keyboard.js";
import { targetLabel } from "../status.js";

/** Props for {@link ConfirmStep}. */
export interface ConfirmStepProps {
  /** The selected action; `action.confirm` selects the mode (none|confirm|typed-confirm). */
  readonly action: Action;
  /** Validated, coerced parameter values to display and (on run) submit. */
  readonly resolvedParams: ResolvedParams;
  /** Whether params currently validate (Run is disabled while false). */
  readonly paramsValid: boolean;
  /** typed-confirm: the operator's current typed text (parent-held). */
  readonly typedValue: string;
  /** typed-confirm: raised as the operator types. */
  readonly onTypedChange: (value: string) => void;
  /** `confirm` mode: raised by the explicit click-through arm control. */
  readonly onArm: () => void;
  /** `confirm` mode: whether the click-through arm has been engaged. */
  readonly clickArmed: boolean;
  /** Raised when an armed run is activated → parent calls invokeAction. */
  readonly onRun: () => void;
  /** Raised when the operator abandons the confirm step (Esc). */
  readonly onCancel: () => void;
  /** When true, controls are disabled (a run is already in flight). */
  readonly disabled?: boolean;
}

/**
 * Pure arming predicate (exported for tests): does the current input arm the run?
 *  - "none"          → always armed (runs on activation; still fully audited).
 *  - "confirm"       → armed only when `clickArmed` is true.
 *  - "typed-confirm" → armed only when `typedValue` === `action.id` exactly.
 * In every mode, `paramsValid` must also hold before a run is permitted; the
 * component gates the Run affordance on both this predicate and `paramsValid`.
 */
export function isRunArmed(
  action: Action,
  typedValue: string,
  clickArmed: boolean,
): boolean {
  switch (action.confirm) {
    case "none":
      return true;
    case "confirm":
      return clickArmed;
    case "typed-confirm":
      return typedValue === action.id;
    default:
      return false;
  }
}

/**
 * The declared-intent panel shown for `confirm`/`typed-confirm` before a run is
 * armed: title, description, runner NAME, the target when present, and the
 * resolved parameter values as text. Never a synthesized command line. It is an
 * alert so the intent is announced when the confirm step appears.
 */
function DeclaredIntent({
  action,
  resolvedParams,
}: {
  readonly action: Action;
  readonly resolvedParams: ResolvedParams;
}): JSX.Element {
  const target = targetLabel(action.target);
  const paramEntries = Object.entries(resolvedParams);
  return (
    <Callout
      tone="warn"
      icon="play-circle"
      role="alert"
      tabIndex={-1}
      data-confirm-intent=""
      title={<h3 className="text-sm font-semibold">{action.title}</h3>}
    >
      <div className="flex flex-col gap-3">
        {action.description !== undefined ? <p>{action.description}</p> : null}
        <KeyValueList layout="inline">
          <KeyValue label="Runner" value={<span className="font-mono">{action.runner}</span>} />
          {target !== null ? (
            <KeyValue label="Target" value={<span className="font-mono">{target}</span>} />
          ) : null}
        </KeyValueList>
        {paramEntries.length > 0 ? (
          <KeyValueList aria-label="Parameters">
            {paramEntries.map(([name, value]) => (
              <KeyValue
                key={name}
                label={<span className="font-mono">{name}</span>}
                value={<span className="font-mono">{String(value)}</span>}
              />
            ))}
          </KeyValueList>
        ) : null}
      </div>
    </Callout>
  );
}

/**
 * Render the confirm step for the action's declared confirm mode, routing
 * Esc/Enter key intent through the pure `keyboard.ts` module. An inline panel,
 * never a modal: focus is never trapped.
 */
export function ConfirmStep({
  action,
  resolvedParams,
  paramsValid,
  typedValue,
  onTypedChange,
  onArm,
  clickArmed,
  onRun,
  onCancel,
  disabled = false,
}: ConfirmStepProps): JSX.Element {
  const armed = isRunArmed(action, typedValue, clickArmed);
  const runDisabled = disabled || !paramsValid || !armed;
  const typedId = `actions-confirm-typed-${action.id}`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const intent = resolveActionIntent(event);
    if (intent === "none") return;
    // Enter on a button (Arm, Run, Cancel) is that button's own activation; only
    // Enter from the typed-confirm field is a keyboard "submit".
    if (intent === "submit" && !(event.target instanceof HTMLInputElement)) return;
    if (shouldPreventActionDefault(intent)) event.preventDefault();
    if (intent === "cancel") {
      onCancel();
      return;
    }
    // "submit": only run an armed run with valid params (component owns filtering
    // so Enter inside a not-yet-matching typed-confirm field never fires a run).
    if (!runDisabled) onRun();
  };

  const showIntent = action.confirm === "confirm" || action.confirm === "typed-confirm";

  return (
    <div
      data-slot="actions-confirm"
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground"
      onKeyDown={onKeyDown}
    >
      {showIntent ? <DeclaredIntent action={action} resolvedParams={resolvedParams} /> : null}

      {action.confirm === "typed-confirm" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={typedId} className="block leading-normal">
            Type the action id (<code className="font-mono">{action.id}</code>) to confirm
          </Label>
          <Input
            id={typedId}
            type="text"
            className="max-w-xs font-mono"
            autoComplete="off"
            spellCheck={false}
            value={typedValue}
            disabled={disabled}
            aria-label={`Type ${action.id} to confirm`}
            onChange={(event) => onTypedChange(event.currentTarget.value)}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {action.confirm === "confirm" && !clickArmed ? (
          <Button type="button" variant="outline" onClick={onArm} disabled={disabled}>
            Arm run
          </Button>
        ) : null}
        <Button type="button" onClick={onRun} disabled={runDisabled}>
          <Icon name="play" />
          Run {action.title}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

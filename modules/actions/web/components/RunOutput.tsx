/**
 * Live streamed output + distinct terminal state + Cancel/Dismiss.
 *
 * Renders one visible state per `run.status` — never silent. Every terminal
 * outcome renders through `OUTCOME_UI` as a toned `Callout` banner: icon + text
 * label, never colour-only, announced with the outcome's own role. The streamed
 * stdout/stderr sit in `LogOutput`, an `aria-live="polite"` log region that is
 * `aria-busy` while the run streams and re-renders incrementally as the run
 * store notifies.
 */

import type { JSX } from "react";
import { Button, Callout, Icon, LoadingState, LogOutput } from "@/ui";
import type { RunState } from "../run-store.js";
import { OUTCOME_UI, showsExitCode } from "../status.js";

/** Props for {@link RunOutput}. */
export interface RunOutputProps {
  /** Current run state from useRun(). */
  readonly run: RunState;
  /** Raised by the Cancel control while streaming; parent calls cancelRun(runId). */
  readonly onCancel: (runId: string) => void;
  /** Raised by the Dismiss control on a terminal run; parent calls resetRun(). */
  readonly onDismiss: () => void;
}

/** Terminal-state view: the outcome banner, any refusal, the captured output and Dismiss. */
function TerminalRun({
  run,
  onDismiss,
}: {
  readonly run: Extract<RunState, { status: "terminal" }>;
  readonly onDismiss: () => void;
}): JSX.Element {
  const ui = OUTCOME_UI[run.outcome];
  const refusal = run.refusal;
  const paramErrors =
    refusal !== undefined && refusal.code === "PARAMS_INVALID" ? refusal.paramErrors : undefined;
  return (
    <div data-slot="actions-run" data-state="terminal" className="flex flex-col gap-3">
      <Callout
        tone={ui.tone}
        icon={ui.icon}
        role={ui.role}
        data-outcome={run.outcome}
        title={ui.label}
        action={
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
            {showsExitCode(run.outcome) && run.exit !== null ? <span>Exit code {run.exit}</span> : null}
            <span>{run.durationMs} ms</span>
          </p>
          {refusal !== undefined ? <p>{refusal.message}</p> : null}
          {paramErrors !== undefined ? (
            <ul aria-label="Parameter errors" className="m-0 flex list-disc flex-col gap-0.5 ps-5">
              {paramErrors.map((error) => (
                <li key={error.name}>
                  <span className="font-mono">{error.name}</span>: {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Callout>
      {run.stdout !== "" || run.stderr !== "" ? (
        <LogOutput stdout={run.stdout} stderr={run.stderr} />
      ) : null}
    </div>
  );
}

/**
 * Render the live view / terminal state for the current run. Every branch yields a
 * distinct, visible state; `idle` renders an unobtrusive placeholder.
 */
export function RunOutput({ run, onCancel, onDismiss }: RunOutputProps): JSX.Element {
  if (run.status === "idle") {
    return <p className="text-sm text-muted-foreground">No run in progress.</p>;
  }

  if (run.status === "requesting") {
    return <LoadingState label="Starting…" rows={1} />;
  }

  if (run.status === "streaming") {
    return (
      <div data-slot="actions-run" data-state="streaming" className="flex flex-col gap-3">
        <LogOutput stdout={run.stdout} stderr={run.stderr} streaming />
        <div>
          <Button type="button" variant="outline" onClick={() => onCancel(run.runId)}>
            <Icon name="circle-stop" />
            Cancel run
          </Button>
        </div>
      </div>
    );
  }

  return <TerminalRun run={run} onDismiss={onDismiss} />;
}

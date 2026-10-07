/**
 * Actions route component + page-owned error boundary.
 *
 * A `PageErrorBoundary` wraps a `ConfigGate` (the loading → error → ready
 * config ladder under a preserved "Actions" page header). The registered
 * component takes NO props. Composes the five presentational components
 * (ActionList, ParamForm, ConfirmStep, RunOutput, AuditHistory) with the
 * singleton run store (via `useRun`) and the shared `validateActionParams`.
 * Every type resolves from `@deck/server`, `@deck/contract/actions` and the feature's own modules — never
 * `@deck/schema`.
 */

import type { ReactNode, JSX } from "react";
import { useEffect, useState } from "react";
import type { ResolvedParams } from "@deck/contract/actions";
import type { DeckConfig } from "@deck/server";
import type { Action } from "@deck/server/actions";
import { validateActionParams } from "@deck/contract/actions";
import { Callout, ConfigGate, PageErrorBoundary } from "@/ui";
import { ActionList } from "./components/ActionList.js";
import { ParamForm, initialParamValues } from "./components/ParamForm.js";
import { ConfirmStep } from "./components/ConfirmStep.js";
import { declaredActions } from "./declared-actions.js";
import { RunOutput } from "./components/RunOutput.js";
import { AuditHistory } from "./components/AuditHistory.js";
import { cancelRun, fetchActionsEnabled, invokeAction } from "./client.js";
import { resetRun } from "./run-store.js";
import { useRun } from "./use-run.js";

/** Props for the page-owned render-isolation boundary. */
export interface ActionsPageBoundaryProps {
  /** Page content isolated from the shell and primary navigation. */
  readonly children: ReactNode;
}

/**
 * Page-owned render isolation: a render/interaction throw in page content is
 * caught here without touching the shell navigation; Retry remounts the content.
 * Emits no exception text.
 */
export function ActionsPageBoundary({ children }: ActionsPageBoundaryProps): JSX.Element {
  return (
    <PageErrorBoundary
      title="Actions view could not be displayed"
      message="This display failed independently of the server."
      retryLabel="Retry actions view"
    >
      {children}
    </PageErrorBoundary>
  );
}

/** Fixed page heading text shared by every state. */
const PAGE_HEADING = "Actions";

/** Registered route component. It accepts no feature props. */
export function ActionsPage(): JSX.Element {
  return (
    <div data-slot="actions-page" data-testid="actions">
      <ActionsPageBoundary>
        <ConfigGate
          title={PAGE_HEADING}
          loadingLabel="Loading actions…"
          loadingPreset="cards"
        >
          {(config) => <ActionsReady config={config} />}
        </ConfigGate>
      </ActionsPageBoundary>
    </div>
  );
}

/**
 * The ready surface: owns local selection, the per-param value map, and the
 * confirm-arm state (`clickArmed`/`typedValue`), all reset on selection change.
 * Recomputes `validateActionParams` on every render from the current values and
 * feeds the result to `ParamForm` (errors) and `ConfirmStep` (resolved params +
 * validity). Capability-disabled is probed on mount and also runtime-discovered
 * from a terminal `ACTIONS_DISABLED` refusal: once observed the page shows a
 * read-only status banner and mounts no run affordance.
 */
function ActionsReady({ config }: { readonly config: DeckConfig }): JSX.Element {
  const actions = declaredActions(config);
  const run = useRun();

  const [selected, setSelected] = useState<Action | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [clickArmed, setClickArmed] = useState(false);
  const [typedValue, setTypedValue] = useState("");
  const [capabilityDisabled, setCapabilityDisabled] = useState(false);
  // undefined until the capability probe resolves; gates the audit read so the
  // page never requests /api/actions/audit (a 403) while the capability is off.
  const [capabilityEnabled, setCapabilityEnabled] = useState<boolean | undefined>(undefined);

  // Proactively probe the capability on mount (HTTP 200 either way, no 403). A
  // disabled result flips the page to its read-only posture before any audit read.
  useEffect(() => {
    let live = true;
    void fetchActionsEnabled().then((enabled) => {
      if (!live) return;
      setCapabilityEnabled(enabled);
      if (!enabled) setCapabilityDisabled(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // Runtime-discover the capability-disabled state: any invoke refused with
  // 403 ACTIONS_DISABLED flips the page into its read-only posture.
  useEffect(() => {
    if (run.status === "terminal" && run.refusal?.code === "ACTIONS_DISABLED") {
      setCapabilityDisabled(true);
    }
  }, [run]);

  // Selecting an action resets the value map and confirm-arm state so an armed
  // state never leaks across actions.
  const selectAction = (action: Action): void => {
    setSelected(action);
    setValues(initialParamValues(action));
    setClickArmed(false);
    setTypedValue("");
  };

  if (capabilityDisabled) {
    return (
      <div className="flex flex-col gap-6">
        <Callout tone="neutral" icon="ban" role="status">
          The actions capability is disabled on this deck instance.
        </Callout>
        <ActionList
          actions={actions}
          selectedId={selected?.id ?? null}
          onSelect={selectAction}
          readOnly
        />
        <AuditHistory enabled={false} />
      </div>
    );
  }

  const onParamChange = (name: string, value: unknown): void => {
    setValues((prior) => ({ ...prior, [name]: value }));
  };

  const validation = selected !== null ? validateActionParams(selected, values) : null;
  const paramsValid = validation?.ok === true;
  const clientErrors = validation !== null && !validation.ok ? validation.errors : [];
  const resolvedParams: ResolvedParams = validation?.ok === true ? validation.values : {};

  // The client-side and server-side validators can disagree (e.g. a config default
  // changed between page load and invoke). Merge a server PARAMS_INVALID refusal's
  // field errors back into the form so the offending fields still get feedback, in
  // addition to RunOutput's refusal banner.
  const serverErrors =
    run.status === "terminal" &&
    run.refusal?.code === "PARAMS_INVALID" &&
    run.actionId === selected?.id
      ? (run.refusal.paramErrors ?? [])
      : [];
  const errors = [
    ...clientErrors,
    ...serverErrors.filter((s) => !clientErrors.some((e) => e.name === s.name)),
  ];

  const runInFlight = run.status === "requesting" || run.status === "streaming";

  return (
    <div className="flex flex-col gap-6">
      <ActionList
        actions={actions}
        selectedId={selected?.id ?? null}
        onSelect={selectAction}
      />
      {selected !== null ? (
        <div className="flex flex-col gap-4">
          <ParamForm
            action={selected}
            values={values}
            onChange={onParamChange}
            errors={errors}
            disabled={runInFlight}
          />
          <ConfirmStep
            action={selected}
            resolvedParams={resolvedParams}
            paramsValid={paramsValid}
            typedValue={typedValue}
            onTypedChange={setTypedValue}
            onArm={() => setClickArmed(true)}
            clickArmed={clickArmed}
            onRun={() => {
              // Each run consumes its confirmation; the next run must re-arm.
              setClickArmed(false);
              setTypedValue("");
              void invokeAction(selected, values);
            }}
            onCancel={() => setSelected(null)}
            disabled={runInFlight}
          />
        </div>
      ) : null}
      <RunOutput
        run={run}
        onCancel={(runId) => void cancelRun(runId)}
        onDismiss={resetRun}
      />
      {/* Read the audit log only once the capability probe confirms it is enabled,
          so a disabled deck never requests /api/actions/audit (a 403). */}
      {capabilityEnabled === true ? <AuditHistory /> : null}
    </div>
  );
}

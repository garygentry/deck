/**
 * HTTP route surface for governed actions: the four routes, the pre-run gating
 * pipeline, NDJSON streaming over the POST body, the cancel control, the read-only
 * audit routes, and the request-origin (`deriveSource`) helper.
 *
 * This module COMPOSES the pieces defined elsewhere — the validator (validate.ts),
 * the executor (executor.ts), the audit store (audit.ts), the event encoder
 * (events.ts), and the typed failure normalizer (errors.ts). It defines no execution
 * or persistence internals; it turns them into HTTP endpoints.
 */
import { randomUUID } from "node:crypto";

import { apiErrorBody } from "@deck/module-sdk";
import { type Context, type Hono } from "hono";
import { stream } from "hono/streaming";

import type { AuditEntry, AuditStore } from "./audit.js";
import type { Action } from "./config.generated.js";
import { normalizeActionFailure } from "./errors.js";
import { encodeRunEvent } from "./events.js";
import type { ResolvedInvocation } from "./executor.js";
import { lookupRunner } from "./runners.js";
import type { ActionsDeps, ActionsLogger } from "./runtime.js";
import type { ActionsCapabilityResponse } from "./types.js";
import { validateActionParams } from "./validate.js";

/**
 * Public error `code` strings for pre-run refusals (surfaced via apiError). Covers
 * only the four pre-run gates; the cancel/audit-detail lookup routes have their own
 * `ACTION_LOOKUP_CODES` below since a missing run/audit id is a read-path miss, not
 * a pre-run refusal.
 */
export const ACTION_REFUSAL_CODES = {
  /** Capability disabled at deployment -> HTTP 403 (answered by the module's `whenDisabled`). */
  ACTIONS_DISABLED: "ACTIONS_DISABLED",
  /** Action id not present in merged config modules.actions.actions -> HTTP 404. */
  ACTION_UNKNOWN: "ACTION_UNKNOWN",
  /** Runner name did not resolve in the manifest -> HTTP 422. */
  RUNNER_UNRESOLVED: "RUNNER_UNRESOLVED",
  /** Parameter validation failed -> HTTP 400. */
  PARAMS_INVALID: "PARAMS_INVALID",
} as const;

/** Closed union of pre-run refusal codes surfaced to clients. */
export type ActionRefusalCode =
  (typeof ACTION_REFUSAL_CODES)[keyof typeof ACTION_REFUSAL_CODES];

/** HTTP status paired with each refusal code. */
export const ACTION_REFUSAL_STATUS: Readonly<
  Record<ActionRefusalCode, 400 | 403 | 404 | 422>
> = {
  ACTIONS_DISABLED: 403,
  ACTION_UNKNOWN: 404,
  RUNNER_UNRESOLVED: 422,
  PARAMS_INVALID: 400,
};

/** Public error `code` strings for a read-path lookup miss (cancel/audit-detail). */
export const ACTION_LOOKUP_CODES = {
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  AUDIT_NOT_FOUND: "AUDIT_NOT_FOUND",
} as const;

/** What the action routes need. */
export interface ActionRouteDeps {
  /** The declared actions: `modules.actions.actions` of the merged config. */
  declared(): readonly Action[];
  logger: ActionsLogger;
  actions: ActionsDeps;
}

/**
 * Register the action routes (the capability probe, the run and cancel writes, and the two
 * audit reads) on the module's sub-app, which the host mounts at `/api/m/actions` and at
 * the legacy `/api/actions`; paths here are relative to that prefix. They exist only while
 * the module runs (the capability is on): switched off, the module's declared `whenDisabled`
 * answers stand in for them.
 */
export function registerActionRoutes(app: Hono, deps: ActionRouteDeps): void {
  // Capability probe (switched off, `whenDisabled` answers `{"enabled": false}`).
  app.get("/", (context) => context.json({ enabled: true } satisfies ActionsCapabilityResponse));
  app.post("/:id", (context) => runAction(context, deps));
  app.post("/runs/:runId/cancel", (context) => cancelRun(context, deps));
  app.get("/audit", (context) => listAudit(context, deps));
  app.get("/audit/:runId", (context) => readAudit(context, deps));
}

/** Answer with deck's API error envelope. */
function apiError(context: Context, status: 400 | 403 | 404 | 422, error: string, code: string): Response {
  return context.json(apiErrorBody(error, code), status);
}

/** POST /api/actions/:id — pre-run gating pipeline then NDJSON stream. */
async function runAction(context: Context, deps: ActionRouteDeps): Promise<Response> {
  const id = context.req.param("id")!; // always present: the :id route matched
  const source = deriveSource(context);
  const actions = deps.actions;

  // Gate 1 — capability: the routes exist only while it is on (see registerActionRoutes).

  // Gate 2 — declared id.
  const action: Action | undefined = deps.declared().find((a) => a.id === id);
  if (action === undefined) {
    await recordRejection(actions.audit, { actionId: id, runner: "", params: {}, source }, deps.logger);
    return apiError(
      context,
      ACTION_REFUSAL_STATUS.ACTION_UNKNOWN,
      `No action is declared with id '${id}'.`,
      ACTION_REFUSAL_CODES.ACTION_UNKNOWN,
    );
  }

  // Gate 3 — runner resolution.
  const executable = lookupRunner(actions.runtime.runners, action.runner);
  if (executable === undefined) {
    await recordRejection(
      actions.audit,
      {
        actionId: id,
        runner: action.runner,
        params: {},
        source,
        ...(action.target === undefined ? {} : { target: action.target }),
      },
      deps.logger,
    );
    return apiError(
      context,
      ACTION_REFUSAL_STATUS.RUNNER_UNRESOLVED,
      `Runner '${action.runner}' is not provisioned on this deck host.`,
      ACTION_REFUSAL_CODES.RUNNER_UNRESOLVED,
    );
  }

  // Gate 4 — parameter validation.
  const raw = await readParamBody(context);
  const validated = raw.ok
    ? validateActionParams(action, raw.value)
    : ({ ok: false, errors: [{ name: "", message: "request body is not valid JSON" }] } as const);
  if (!validated.ok) {
    await recordRejection(
      actions.audit,
      {
        actionId: id,
        runner: action.runner,
        params: {},
        source,
        ...(action.target === undefined ? {} : { target: action.target }),
      },
      deps.logger,
    );
    return context.json(
      {
        error: "One or more parameters are invalid.",
        code: ACTION_REFUSAL_CODES.PARAMS_INVALID,
        paramErrors: validated.errors,
      },
      ACTION_REFUSAL_STATUS.PARAMS_INVALID,
    );
  }

  // Step 5 — resolved invocation; stream NDJSON.
  const invocation: ResolvedInvocation = {
    actionId: id,
    runner: action.runner,
    executable,
    params: validated.values,
    source,
    ...(action.target === undefined ? {} : { target: action.target }),
  };

  context.header("Content-Type", "application/x-ndjson");
  context.header("Cache-Control", "no-store");
  return stream(
    context,
    async (writer) => {
      // A client disconnect must NOT cancel the run; the executor tees to
      // the audit log independently of consumption. We keep DRAINING the iterable to
      // completion, discarding events once the client is gone, so the executor's bounded
      // channel never accumulates (the bounded-buffer policy).
      let clientGone = false;
      writer.onAbort(() => {
        clientGone = true;
        deps.logger.info(
          { event: "action.run", id, runner: action.runner, phase: "client-disconnect" },
          "client disconnected; run continues server-side",
        );
      });
      for await (const event of actions.executor.start(invocation)) {
        if (clientGone) continue; // drain-and-discard; executor still tees to the audit .log
        try {
          await writer.write(encodeRunEvent(event));
        } catch {
          clientGone = true; // a write raced the abort — switch to draining
        }
      }
    },
    async (error, writer) => {
      // Headers already sent: cannot change status. Deliver a terminal end event so the
      // UI never hangs; the executor still writes the audit entry.
      const failure = normalizeActionFailure(error);
      await writer.write(
        encodeRunEvent({ type: "end", outcome: failure.outcome, exit: null, durationMs: 0 }),
      );
    },
  );
}

/** POST /api/actions/runs/:runId/cancel — explicit cancel. */
function cancelRun(context: Context, deps: ActionRouteDeps): Response {
  const actions = deps.actions;
  const runId = context.req.param("runId")!; // always present: the :runId route matched
  if (!actions.executor.cancel(runId)) {
    return apiError(context, 404, `No in-flight run with id '${runId}'.`, ACTION_LOOKUP_CODES.RUN_NOT_FOUND);
  }
  return context.body(null, 202);
}

/** GET /api/actions/audit — newest-first list. */
async function listAudit(context: Context, deps: ActionRouteDeps): Promise<Response> {
  const actions = deps.actions;
  return context.json(await actions.audit.list());
}

/** GET /api/actions/audit/:runId — one entry + full output. */
async function readAudit(context: Context, deps: ActionRouteDeps): Promise<Response> {
  const actions = deps.actions;
  const runId = context.req.param("runId")!; // always present: the :runId route matched
  const detail = await actions.audit.read(runId);
  if (detail === undefined) {
    return apiError(context, 404, `No audit entry with run id '${runId}'.`, ACTION_LOOKUP_CODES.AUDIT_NOT_FOUND);
  }
  return context.json(detail);
}

/** Fields the caller supplies for a pre-run rejection audit entry. */
interface RejectionInput {
  actionId: string;
  runner: string;
  params: AuditEntry["params"];
  source: string;
  target?: AuditEntry["target"];
}

/**
 * Append one `rejected` audit entry before returning a refusal. An audit-write failure
 * here must never replace the caller's typed refusal (ACTION_UNKNOWN,
 * etc.) with a generic 500 — it degrades to a logged warning instead.
 */
async function recordRejection(
  audit: AuditStore,
  input: RejectionInput,
  logger: ActionsLogger,
): Promise<void> {
  const entry: AuditEntry = {
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    actionId: input.actionId,
    runner: input.runner,
    params: input.params,
    source: input.source,
    outcome: "rejected",
    exitStatus: null,
    durationMs: 0,
    outputBytes: 0,
    ...(input.target === undefined ? {} : { target: input.target }),
  };
  try {
    await audit.append(entry);
  } catch (cause) {
    logger.error(
      { event: "action.run", actionId: entry.actionId, outcome: "rejected", audit: "append-failed", cause: String(cause) },
      "audit append failed for refusal",
    );
  }
}

/** Parse the request body to a raw record; ok=false when the body is present but invalid JSON. */
async function readParamBody(
  context: Context,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const text = await context.req.text();
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** Derive the request origin for the audit entry. */
function deriveSource(context: Context): string {
  const forwarded = context.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  const realIp = context.req.header("x-real-ip");
  if (realIp !== undefined && realIp.trim() !== "") return realIp.trim();
  return "unknown";
}

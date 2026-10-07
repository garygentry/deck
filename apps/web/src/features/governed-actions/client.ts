/**
 * NDJSON streaming client for governed actions.
 *
 * Owns all HTTP for the feature: the streaming invoke, the cancel call, and the two
 * audit reads. It drives `run-store.ts` via its mutators. Endpoints are
 * fixed and not configurable by component code (mirrors `INVENTORY_ENDPOINTS`).
 *
 * Native `EventSource` is NOT used — it is GET-only, and this is a POST stream. The
 * `getReader()` + newline-split approach is the specified mechanism.
 */

import type { ParamError } from "@deck/contract/actions";
import type {
  Action,
  ActionRunEvent,
  ActionsCapabilityResponse,
  AuditDetail,
  AuditListItem,
} from "@deck/server/actions";
import { applyRunEvent, beginRun, failRun } from "./run-store.js";
import type { RunRefusal } from "./run-store.js";

/** Fixed feature endpoints; not configurable by page or component code. */
export const ACTION_ENDPOINTS = Object.freeze({
  /** GET capability probe: `{ enabled }`, HTTP 200 whether on or off. */
  capability: "/api/actions",
  /** POST param JSON; responds application/x-ndjson. :id is the action id. */
  invoke: (id: string): string => `/api/actions/${encodeURIComponent(id)}`,
  /** POST to cancel an in-flight run. */
  cancel: (runId: string): string =>
    `/api/actions/runs/${encodeURIComponent(runId)}/cancel`,
  /** GET newest-first audit index list. */
  audit: "/api/actions/audit",
  /** GET one entry + captured output. */
  auditDetail: (runId: string): string =>
    `/api/actions/audit/${encodeURIComponent(runId)}`,
} as const);

/**
 * Probe whether the governed-actions capability is enabled. The endpoint answers
 * 200 whether the capability is on or off, so the page can gate its audit read
 * without provoking a 403. A transient failure resolves to `true` (poll anyway),
 * mirroring the provider-index fallback: a probe blip must not hide a working
 * capability.
 */
export async function fetchActionsEnabled(): Promise<boolean> {
  try {
    const response = await fetch(ACTION_ENDPOINTS.capability);
    if (!response.ok) return true;
    const body = (await response.json()) as ActionsCapabilityResponse;
    return body.enabled;
  } catch {
    return true;
  }
}

/** Shape of a non-2xx JSON refusal body. */
interface ErrorBody {
  readonly error?: unknown;
  readonly code?: unknown;
  readonly paramErrors?: unknown;
}

/**
 * Core NDJSON reader (pure over the stream; exported for standalone testing). Reads
 * `reader`, decodes UTF-8, splits on "\n", JSON-parses each complete line into an
 * `ActionRunEvent`, and invokes `onEvent` per event. A trailing partial line is
 * buffered across reads; a final non-empty buffer at stream end is parsed once.
 * Malformed lines are skipped defensively (the terminal `end` event is the authority
 * on completion).
 */
export async function readNdjsonEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: ActionRunEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";

  const dispatch = (line: string): void => {
    if (line === "") return;
    let event: ActionRunEvent;
    try {
      event = JSON.parse(line) as ActionRunEvent;
    } catch {
      // Skip a malformed line defensively; never throw on bad wire data.
      return;
    }
    onEvent(event);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    // Keep the last (possibly empty) fragment as the new buffer.
    buf = lines.pop() ?? "";
    for (const line of lines) dispatch(line);

    if (done) {
      // Flush any final trailing line that arrived without a newline.
      dispatch(buf);
      break;
    }
  }
}

/** Build a `RunRefusal` from a parsed non-2xx error body, with safe fallbacks. */
function refusalFromBody(body: ErrorBody | null): RunRefusal {
  const code = typeof body?.code === "string" ? body.code : "REQUEST";
  const message =
    typeof body?.error === "string" ? body.error : "The action was refused.";
  const paramErrors = Array.isArray(body?.paramErrors)
    ? (body.paramErrors as readonly ParamError[])
    : undefined;
  return paramErrors === undefined
    ? { code, message }
    : { code, message, paramErrors };
}

/**
 * Invoke a declared action. POSTs the raw parameter map as JSON, then either streams
 * NDJSON events into the run store or maps a non-2xx JSON error body to a terminal
 * `rejected` run. Resolves when the run reaches a terminal state; never
 * throws to the caller (all failures become a visible terminal state).
 *
 * @param action    The action being invoked (its `id` selects the endpoint).
 * @param rawParams Raw form values; the server re-validates authoritatively.
 */
export async function invokeAction(
  action: Action,
  rawParams: Readonly<Record<string, unknown>>,
): Promise<void> {
  beginRun(action.id);

  let response: Response;
  try {
    response = await fetch(ACTION_ENDPOINTS.invoke(action.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rawParams),
    });
  } catch {
    // The POST itself never reached a response (network failure before headers).
    failRun({ code: "REQUEST", message: "The request could not be sent." }, "error");
    return;
  }

  if (!response.ok) {
    // Pre-run refusal: a non-2xx JSON error body (not NDJSON).
    let body: ErrorBody | null = null;
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      body = null;
    }
    failRun(refusalFromBody(body), "rejected");
    return;
  }

  if (response.body === null) {
    // A 2xx with no body is a transport failure; never leave the UI hanging.
    failRun({ code: "REQUEST", message: "No response stream." }, "error");
    return;
  }

  const reader = response.body.getReader();
  try {
    await readNdjsonEvents(reader, applyRunEvent);
  } catch {
    // The reader threw mid-stream (network drop after headers). Synthesize a
    // terminal error so the UI never hangs; the server-side run continues to
    // completion and remains visible in AuditHistory.
    failRun(
      { code: "REQUEST", message: "The output stream was interrupted." },
      "error",
    );
  }
}

/**
 * Cancel an in-flight run by the id from its first `run` event.
 *
 * @returns true if the server accepted (202); false for 404 (unknown/finished run)
 *          or a transport failure. Never throws to the caller, matching {@link invokeAction}.
 *          The terminal `cancelled` state still arrives via the run's own `end` event.
 */
export async function cancelRun(runId: string): Promise<boolean> {
  try {
    const response = await fetch(ACTION_ENDPOINTS.cancel(runId), { method: "POST" });
    return response.status === 202;
  } catch {
    return false;
  }
}

/** Fetch the newest-first audit index list. */
export async function fetchAudit(): Promise<AuditListItem[]> {
  const response = await fetch(ACTION_ENDPOINTS.audit);
  if (!response.ok) {
    throw new Error("Failed to load audit history.");
  }
  return (await response.json()) as AuditListItem[];
}

/** Fetch one audit entry plus captured output; undefined on 404. */
export async function fetchAuditDetail(
  runId: string,
): Promise<AuditDetail | undefined> {
  const response = await fetch(ACTION_ENDPOINTS.auditDetail(runId));
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error("Failed to load audit entry.");
  }
  return (await response.json()) as AuditDetail;
}

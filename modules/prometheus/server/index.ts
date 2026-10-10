import type { EnvReader, ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";

import type { SummaryQuery } from "./parse-card.js";

export type SummaryStatus = "ok" | "warning" | "critical" | "neutral" | "error";

export interface SummaryValue {
  id: string;
  label: string;
  unit?: string;
  value: number | null;
  status: SummaryStatus;
}

export interface PrometheusResult {
  summaries: SummaryValue[];
}

/**
 * The credential wiring: `credentialEnv` names the variable holding the `Authorization` value,
 * read through `env` at fetch time (so a rotated credential is picked up). Naming a credential
 * requires a reader; without `credentialEnv` no credential is sent.
 */
export type PrometheusCredential =
  | { credentialEnv?: undefined; env?: EnvReader }
  | { credentialEnv: string; env: EnvReader };

export type PrometheusConfig = {
  baseUrl: string;
  summaries: SummaryQuery[];
} & PrometheusCredential;

interface QueryOutcome {
  /** Whether Prometheus answered the query itself: a 2xx, or a query error (bad PromQL, say). */
  reachable: boolean;
  value: SummaryValue;
  /** For an unreachable query that got an answer: why the endpoint refused it. */
  refusal?: string;
}

/**
 * The 4xx answers that are about the endpoint, not the query: whoever sends them (Prometheus or
 * a proxy in front of it), the query never ran, so every query fails the same way.
 */
const ENDPOINT_REFUSALS: Readonly<Record<number, string>> = {
  401: "authentication refused (401)",
  403: "authentication refused (403)",
  404: "not a Prometheus endpoint (404)",
  407: "proxy authentication refused (407)",
  429: "rate limited (429)",
};

/** The largest error body read to recognise a Prometheus query error. */
const ERROR_BODY_MAX_BYTES = 64 * 1024;

export class PrometheusProvider implements ProviderSpec<PrometheusResult> {
  readonly kind = "prometheus";
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: PrometheusConfig,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(context?: ProviderFetchContext): Promise<PrometheusResult> {
    if (this.cfg.summaries.length === 0) {
      this.latestHealth = { ok: true, detail: "0 summaries" };
      return { summaries: [] };
    }

    const outcomes = await Promise.all(
      this.cfg.summaries.map((query) => this.runQuery(query, context?.signal)),
    );
    if (!outcomes.some((outcome) => outcome.reachable)) {
      const refusal = outcomes.find((outcome) => outcome.refusal !== undefined)?.refusal;
      const detail = refusal === undefined ? "Prometheus endpoint unreachable" : `Prometheus ${refusal}`;
      this.latestHealth = { ok: false, detail };
      throw new Error(detail);
    }

    const summaries = outcomes.map((outcome) => outcome.value);
    const errorCount = summaries.filter((summary) => summary.status === "error").length;
    this.latestHealth = {
      ok: true,
      detail: errorCount === 0
        ? `${summaries.length} summaries`
        : `${summaries.length} summaries, ${errorCount} errored`,
    };
    return { summaries };
  }

  private async runQuery(query: SummaryQuery, signal?: AbortSignal): Promise<QueryOutcome> {
    const errored: SummaryValue = {
      id: query.id,
      label: query.label,
      ...(query.unit === undefined ? {} : { unit: query.unit }),
      value: null,
      status: "error",
    };
    let response: Response;
    try {
      response = await globalThis.fetch(queryUrl(this.cfg.baseUrl, query.query), {
        method: "GET",
        headers: authHeaders(this.cfg),
        signal,
      });
    } catch {
      return { reachable: false, value: errored };
    }
    if (!response.ok) {
      const { status } = response;
      const endpointRefusal = ENDPOINT_REFUSALS[status];
      // A query error is Prometheus answering: the query is in error, the endpoint is up. That is
      // a 400 (bad PromQL) or 422 (not executable), or another 4xx carrying Prometheus's own
      // error body. Anything else (a 5xx, a proxy's 502, an auth or rate-limit refusal) is not.
      const queryError = status === 400 || status === 422
        || (status >= 400 && status < 500 && endpointRefusal === undefined && isPrometheusError(await smallJson(response)));
      await response.body?.cancel().catch(() => {});
      if (queryError) return { reachable: true, value: errored };
      return {
        reachable: false,
        value: errored,
        ...(status < 500 ? { refusal: endpointRefusal ?? `answered HTTP ${status}` } : {}),
      };
    }

    try {
      const scalar = extractScalar(await response.json());
      return scalar === null
        ? { reachable: true, value: errored }
        : { reachable: true, value: toSummaryValue(query, scalar) };
    } catch {
      return { reachable: true, value: errored };
    }
  }
}

/** A short body parsed as JSON, or null when it is longer, unreadable or not JSON. */
async function smallJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ERROR_BODY_MAX_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Whether a body is Prometheus's API error envelope, `{ status: "error", errorType, ... }`. */
function isPrometheusError(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const { status, errorType } = body as { status?: unknown; errorType?: unknown };
  return status === "error" && typeof errorType === "string";
}

function queryUrl(baseUrl: string, query: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/api/v1/query?query=${encodeURIComponent(query)}`;
}

function authHeaders({ credentialEnv, env }: PrometheusConfig): Record<string, string> {
  if (!credentialEnv) return {};
  const value = env?.get(credentialEnv);
  return value ? { Authorization: value } : {};
}

function extractScalar(body: unknown): number | null {
  if (body === null || typeof body !== "object") return null;
  const response = body as { status?: unknown; data?: unknown };
  if (response.status !== "success" || response.data === null || typeof response.data !== "object") return null;
  const data = response.data as { resultType?: unknown; result?: unknown };
  if (data.resultType === "scalar") {
    return toFinite(Array.isArray(data.result) ? data.result[1] : undefined);
  }
  if (data.resultType === "vector" && Array.isArray(data.result) && data.result.length === 1) {
    const sample = data.result[0];
    if (sample === null || typeof sample !== "object") return null;
    const value = (sample as { value?: unknown }).value;
    return toFinite(Array.isArray(value) ? value[1] : undefined);
  }
  return null;
}

function toFinite(token: unknown): number | null {
  const value = typeof token === "number"
    ? token
    : typeof token === "string" && token.trim().length > 0
      ? Number(token)
      : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function toSummaryValue(query: SummaryQuery, value: number): SummaryValue {
  return {
    id: query.id,
    label: query.label,
    ...(query.unit === undefined ? {} : { unit: query.unit }),
    value,
    status: classifyStatus(query, value),
  };
}

function classifyStatus(query: SummaryQuery, value: number): SummaryStatus {
  if (query.warning === undefined && query.critical === undefined) return "neutral";
  const breaches = (threshold: number | undefined): boolean => threshold !== undefined
    && (query.direction === "below" ? value <= threshold : value >= threshold);
  if (breaches(query.critical)) return "critical";
  if (breaches(query.warning)) return "warning";
  return "ok";
}

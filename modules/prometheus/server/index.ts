import type { EnvReader, ProviderFetchContext, ProviderHealth, ProviderSpec, ProviderTiming } from "@deck/module-sdk";

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
  timing?: ProviderTiming;
} & PrometheusCredential;

interface QueryOutcome {
  reachable: boolean;
  value: SummaryValue;
}

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
      const detail = "Prometheus endpoint unreachable";
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
    if (!response.ok) return { reachable: false, value: errored };

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

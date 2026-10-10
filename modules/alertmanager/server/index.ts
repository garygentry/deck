import type { EnvReader, ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";

/** One active alert, normalized from the Alertmanager v2 GET /api/v2/alerts shape. */
export interface ActiveAlert {
  fingerprint: string;
  name: string;
  severity: string;
  startsAt: string;
  suppressed: boolean;
  sourceUrl: string | null;
}

/** One active silence, presented read-only. */
export interface ActiveSilence {
  id: string;
  endsAt: string;
  matchers: string;
}

/** The alertmanager provider's fetch() payload. */
export interface AlertmanagerResult {
  alerts: ActiveAlert[];
  silences: ActiveSilence[];
  firingCount: number;
}

/**
 * The credential wiring: `credentialEnv` names the variable holding the `Authorization` value,
 * read through `env` at fetch time (so a rotated credential is picked up). Naming a credential
 * requires a reader; without `credentialEnv` no credential is sent.
 */
export type AlertmanagerCredential =
  | { credentialEnv?: undefined; env?: EnvReader }
  | { credentialEnv: string; env: EnvReader };

/** Wiring for the single alertmanager provider (needs no query config). */
export type AlertmanagerConfig = {
  baseUrl: string;
} & AlertmanagerCredential;

/** v2 alert status block; `state: "suppressed"` covers silenced OR inhibited alerts. */
interface RawAlertStatus {
  state?: "active" | "suppressed" | "unprocessed";
  silencedBy?: string[];
  inhibitedBy?: string[];
}

/** One entry from GET /api/v2/alerts. */
interface RawGettableAlert {
  fingerprint?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  generatorURL?: string;
  status?: RawAlertStatus;
}

/** v2 matcher; rendered into a compact human string for read-only display. */
interface RawMatcher {
  name?: string;
  value?: string;
  isRegex?: boolean;
  isEqual?: boolean;
}

/** One entry from GET /api/v2/silences. */
interface RawGettableSilence {
  id?: string;
  status?: { state?: "expired" | "active" | "pending" };
  matchers?: RawMatcher[];
  endsAt?: string;
}

export class AlertmanagerProvider implements ProviderSpec<AlertmanagerResult> {
  readonly kind = "alertmanager";

  /** Cached non-I/O health snapshot; updated only by fetch(), never by a health() probe. */
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: AlertmanagerConfig,
  ) {}

  /** Return the cached non-I/O health snapshot from the latest fetch. */
  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(context?: ProviderFetchContext): Promise<AlertmanagerResult> {
    // One controller for both requests: when either fails, the other is aborted (its request or
    // its body read), so a failed poll leaves nothing in flight. The poll's own signal feeds it.
    const controller = new AbortController();
    const signal = context?.signal;
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    try {
      const [rawAlerts, rawSilences] = await Promise.all([
        this.getJson<RawGettableAlert[]>("/api/v2/alerts", "?active=true&silenced=true", controller.signal),
        this.getJson<RawGettableSilence[]>("/api/v2/silences", "", controller.signal),
      ]).catch((error: unknown) => {
        controller.abort();
        throw error;
      });

      const result = normalize(rawAlerts, rawSilences);
      this.latestHealth = {
        ok: true,
        detail: `${result.firingCount} firing, ${result.silences.length} silence(s)`,
      };
      return result;
    } catch (error) {
      // detail carries the error message ONLY (no payload, no credential).
      this.latestHealth = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** GET one endpoint and parse its body; a non-2xx body is drained, never left open. */
  private async getJson<T>(path: string, query: string, signal: AbortSignal): Promise<T> {
    const response = await globalThis.fetch(joinUrl(this.cfg.baseUrl, `${path}${query}`), {
      method: "GET",
      headers: authHeaders(this.cfg),
      signal,
    });
    // Divergence from gatus: a non-2xx from either endpoint is NOT an empty success — reject,
    // so an unreachable Alertmanager can never masquerade as "all clear".
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Alertmanager ${path} responded ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

/** Join a base URL and an absolute path, tolerating a trailing slash on the base. */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

/**
 * Build request headers from a credential ENV-VAR NAME, resolved through the env reader at
 * call time. The value is never stored on the instance or logged; header omitted when unset/empty.
 */
function authHeaders({ credentialEnv, env }: AlertmanagerConfig): Record<string, string> {
  if (!credentialEnv) return {};
  const value = env?.get(credentialEnv);
  if (!value) return {};
  return { Authorization: value };
}

/**
 * Pure transform: raw v2 alerts + silences → normalized AlertmanagerResult.
 * No I/O; deterministic; never throws on unknown/missing fields (defensive per-field guards).
 */
function normalize(
  rawAlerts: readonly RawGettableAlert[],
  rawSilences: readonly RawGettableSilence[],
): AlertmanagerResult {
  const silences: ActiveSilence[] = [];
  for (const raw of rawSilences ?? []) {
    if (raw?.status?.state !== "active" || typeof raw.id !== "string") continue;
    silences.push({
      id: raw.id,
      endsAt: raw.endsAt ?? "",
      matchers: renderMatchers(raw.matchers),
    });
  }

  const alerts: ActiveAlert[] = [];
  for (const raw of rawAlerts ?? []) {
    const fingerprint = raw?.fingerprint;
    if (typeof fingerprint !== "string" || fingerprint.length === 0) continue;
    alerts.push({
      fingerprint,
      name: raw.labels?.alertname || raw.annotations?.summary || "Unnamed alert",
      severity: raw.labels?.severity ?? "",
      startsAt: raw.startsAt ?? "",
      suppressed: isSuppressed(raw.status),
      sourceUrl: raw.generatorURL || null,
    });
  }

  return { alerts, silences, firingCount: alerts.filter((a) => !a.suppressed).length };
}

/** An alert is suppressed by AM state or a non-empty silencedBy. */
function isSuppressed(status: RawAlertStatus | undefined): boolean {
  if (status?.state === "suppressed") return true;
  const silencedBy = status?.silencedBy;
  return Array.isArray(silencedBy) && silencedBy.length > 0;
}

/** Render matchers as a compact, read-only `name<op>"value"` join. */
function renderMatchers(matchers: readonly RawMatcher[] | undefined): string {
  if (!Array.isArray(matchers)) return "";
  return matchers
    .map((m) => `${m?.name ?? ""}${matcherOp(m)}${JSON.stringify(m?.value ?? "")}`)
    .join(", ");
}

function matcherOp(m: RawMatcher): string {
  const equal = m?.isEqual !== false;
  const regex = m?.isRegex === true;
  if (equal && !regex) return "=";
  if (equal && regex) return "=~";
  if (!equal && !regex) return "!=";
  return "!~";
}

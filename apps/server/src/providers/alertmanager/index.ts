import type {
  Provider,
  ProviderConfig,
  ProviderFetchContext,
  ProviderHealth,
} from "../../contract/index.js";
import { register } from "../registry.js";

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

/** Wiring for the single alertmanager provider (needs no query config). */
export interface AlertmanagerConfig {
  baseUrl: string;
  credentialEnv?: string;
  timing?: ProviderConfig;
}

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

export class AlertmanagerProvider implements Provider<AlertmanagerResult> {
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
    const signal = context?.signal;
    try {
      const [alertsRes, silencesRes] = await Promise.all([
        globalThis.fetch(joinUrl(this.cfg.baseUrl, "/api/v2/alerts?active=true&silenced=true"), {
          method: "GET",
          headers: authHeaders(this.cfg.credentialEnv),
          ...(signal ? { signal } : {}),
        }),
        globalThis.fetch(joinUrl(this.cfg.baseUrl, "/api/v2/silences"), {
          method: "GET",
          headers: authHeaders(this.cfg.credentialEnv),
          ...(signal ? { signal } : {}),
        }),
      ]);

      // Divergence from gatus: a non-2xx from either endpoint is NOT an empty success — reject,
      // so an unreachable Alertmanager can never masquerade as "all clear".
      if (!alertsRes.ok) throw new Error(`Alertmanager /api/v2/alerts responded ${alertsRes.status}`);
      if (!silencesRes.ok) throw new Error(`Alertmanager /api/v2/silences responded ${silencesRes.status}`);

      const rawAlerts = (await alertsRes.json()) as RawGettableAlert[];
      const rawSilences = (await silencesRes.json()) as RawGettableSilence[];

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
    }
  }
}

export function registerAlertmanager(id: string, cfg: AlertmanagerConfig): void {
  register(new AlertmanagerProvider(id, cfg), cfg.timing);
}

/** Join a base URL and an absolute path, tolerating a trailing slash on the base. */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

/**
 * Build request headers from a credential ENV-VAR NAME, resolved inline at call time.
 * The value is never stored on the instance or logged; header omitted when unset/empty.
 */
function authHeaders(credentialEnv?: string): Record<string, string> {
  if (!credentialEnv) return {};
  const value = process.env[credentialEnv];
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
  const activeSilenceIds = new Set<string>();
  for (const raw of rawSilences ?? []) {
    if (raw?.status?.state !== "active" || typeof raw.id !== "string") continue;
    activeSilenceIds.add(raw.id);
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
      suppressed: isSuppressed(raw.status, activeSilenceIds),
      sourceUrl: raw.generatorURL || null,
    });
  }

  return { alerts, silences, firingCount: alerts.filter((a) => !a.suppressed).length };
}

/** An alert is suppressed by AM state, a non-empty silencedBy, or a match to an active silence. */
function isSuppressed(status: RawAlertStatus | undefined, activeSilenceIds: ReadonlySet<string>): boolean {
  if (status?.state === "suppressed") return true;
  const silencedBy = status?.silencedBy;
  if (!Array.isArray(silencedBy)) return false;
  // Non-empty silencedBy suppresses; the active-silence cross-check is a defensive redundancy.
  return silencedBy.length > 0 || silencedBy.some((id) => typeof id === "string" && activeSilenceIds.has(id));
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

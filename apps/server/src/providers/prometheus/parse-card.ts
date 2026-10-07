import type { ModuleLogger } from "@deck/module-sdk";

export type ThresholdDirection = "above" | "below";

export interface SummaryQuery {
  id: string;
  label: string;
  query: string;
  unit?: string;
  warning?: number;
  critical?: number;
  direction?: ThresholdDirection;
}

interface Candidate extends Record<string, unknown> {
  present: ReadonlySet<string>;
}

/**
 * Parse untrusted integration card data without allowing one bad declaration to fail boot. Each
 * dropped entry is logged to `logger` (the module's) as `prometheus.summary.dropped`.
 */
export function parseSummaryCard(card: unknown, logger: ModuleLogger): SummaryQuery[] {
  try {
    return parseSummaryCardUnchecked(card, logger);
  } catch {
    // Includes hostile/revoked proxies and exotic arrays; this trust boundary never throws.
    return [];
  }
}

function parseSummaryCardUnchecked(card: unknown, logger: ModuleLogger): SummaryQuery[] {
  let summaries: unknown;
  try {
    if (card === null || typeof card !== "object" || Array.isArray(card)) return [];
    summaries = (card as { summaries?: unknown }).summaries;
  } catch {
    return [];
  }
  if (!Array.isArray(summaries)) return [];

  const parsed: SummaryQuery[] = [];
  const ids = new Set<string>();
  summaries.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      logDrop(logger, index, undefined, "entry_invalid");
      return;
    }

    let candidate: Candidate;
    try {
      const raw = entry as Candidate;
      candidate = {
        present: new Set(
          ["id", "label", "query", "unit", "warning", "critical", "direction"]
            .filter((field) => Object.prototype.hasOwnProperty.call(raw, field)),
        ),
        id: raw.id,
        label: raw.label,
        query: raw.query,
        unit: raw.unit,
        warning: raw.warning,
        critical: raw.critical,
        direction: raw.direction,
      };
    } catch {
      logDrop(logger, index, undefined, "entry_unreadable");
      return;
    }

    const id = usableString(candidate.id) ? candidate.id : undefined;
    const reason = invalidReason(candidate, id, ids);
    if (reason !== null) {
      logDrop(logger, index, id, reason);
      return;
    }

    const result: SummaryQuery = {
      id: id!,
      label: candidate.label as string,
      query: candidate.query as string,
    };
    if (candidate.present.has("unit")) result.unit = candidate.unit as string;
    if (candidate.present.has("warning")) result.warning = candidate.warning as number;
    if (candidate.present.has("critical")) result.critical = candidate.critical as number;
    if (candidate.present.has("direction")) result.direction = candidate.direction as ThresholdDirection;
    ids.add(result.id);
    parsed.push(result);
  });
  return parsed;
}

function invalidReason(candidate: Candidate, id: string | undefined, ids: ReadonlySet<string>): string | null {
  if (id === undefined) return "id_invalid";
  if (ids.has(id)) return "id_duplicate";
  if (!usableString(candidate.label)) return "label_invalid";
  if (!usableString(candidate.query)) return "query_invalid";
  if (candidate.present.has("unit") && !usableString(candidate.unit)) return "unit_invalid";
  if (candidate.present.has("warning") && !finiteNumber(candidate.warning)) return "warning_invalid";
  if (candidate.present.has("critical") && !finiteNumber(candidate.critical)) return "critical_invalid";
  const hasThreshold = candidate.present.has("warning") || candidate.present.has("critical");
  if (candidate.present.has("direction") && candidate.direction !== "above" && candidate.direction !== "below") {
    return "direction_invalid";
  }
  if (hasThreshold && !candidate.present.has("direction")) return "direction_required";
  return null;
}

function usableString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function logDrop(logger: ModuleLogger, index: number, id: string | undefined, reason: string): void {
  try {
    logger.warn(
      { event: "prometheus.summary.dropped", index, ...(id === undefined ? {} : { id }), reason },
      "prometheus summary dropped",
    );
  } catch {
    // Invalid configuration and observability failures must never make parsing throw.
  }
}

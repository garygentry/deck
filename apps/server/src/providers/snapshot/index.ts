import type { ModuleLogger, ProviderTiming } from "@deck/module-sdk";
import {
  supportedSnapshotVersions,
  validateSnapshot,
  type DeckConfigDocument,
  type Finding,
  type SnapshotDocument,
  type ValidationResult,
} from "@deck/schema";

import {
  POLL_DEFAULTS,
  type Provider,
  type ProviderFetchContext,
  type ProviderHealth,
} from "../../contract/index.js";
import type { HostState, SnapshotProviderResult } from "@deck/contract";
import { logger, type SnapshotReadEvent } from "../../log/logger.js";
import { SNAPSHOT_READ_MESSAGES, SnapshotReadFailure, normalizeSnapshotFailure } from "./errors.js";
import { deriveHostStates, parseStaleAfterMs } from "./freshness.js";
import type { SnapshotSource } from "./source.js";

/** Construction inputs for the singleton snapshot provider. */
export interface SnapshotProviderConfig {
  /** One already-resolved immutable source adapter. */
  readonly source: SnapshotSource;
  /** Loaded merged config passed unchanged to snapshot validation. */
  readonly config: DeckConfigDocument;
  /** Injectable clock for deterministic age and timestamp tests. */
  readonly now?: () => Date;
  /** Where `snapshot.read` events go: the module's scoped logger; the shared logger when absent. */
  readonly logger?: Pick<ModuleLogger, "info">;
}

/**
 * Parse changed UTF-8 text once without exposing parser diagnostics.
 *
 * @throws {SnapshotReadFailure} `JSON_INVALID` when `JSON.parse` rejects.
 */
function parseSnapshot(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SnapshotReadFailure("JSON_INVALID", SNAPSHOT_READ_MESSAGES.JSON_INVALID);
  }
}

/**
 * Read the integer schema version defensively from a parsed document. A
 * `VERSION_UNSUPPORTED` finding is only produced for an integer version, so the
 * fallback is unreachable in normal flow.
 */
function readSchemaVersion(parsed: unknown): number {
  const value = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  return typeof value === "number" && Number.isInteger(value) ? value : Number.NaN;
}

/**
 * Convert an estate-contract validation result into accepted typed data or a
 * typed refusal. Classification 2 is refused as `SNAPSHOT_INVALID`; a
 * `VERSION_UNSUPPORTED` finding overrides generic classification-1 acceptance and
 * is refused with the exact sanitized found/supported sentence. Every other
 * classification 0/1 result is served, retaining the exact parsed object and all
 * findings.
 *
 * @throws {SnapshotReadFailure} `SNAPSHOT_INVALID` or `VERSION_UNSUPPORTED`.
 */
function requireAcceptedSnapshot(
  parsed: unknown,
  result: ValidationResult,
): { snapshot: SnapshotDocument; findings: readonly Finding[] } {
  if (result.classification === 2) {
    throw new SnapshotReadFailure("SNAPSHOT_INVALID", SNAPSHOT_READ_MESSAGES.SNAPSHOT_INVALID);
  }

  const hasUnsupportedVersion = result.findings.some(
    (finding) => finding.code === "VERSION_UNSUPPORTED",
  );
  if (hasUnsupportedVersion) {
    const found = readSchemaVersion(parsed);
    const supported = [...supportedSnapshotVersions].sort((a, b) => a - b).join(", ");
    throw new SnapshotReadFailure(
      "VERSION_UNSUPPORTED",
      `Snapshot schemaVersion ${found} is unsupported; supported version(s): ${supported}.`,
    );
  }

  // Classification 0 or remaining classification 1 is accepted. Cast only after
  // this check and retain the exact object and every finding, including drift.
  return { snapshot: parsed as SnapshotDocument, findings: result.findings };
}

/**
 * Reads, validates, and derives state for exactly one snapshot source.
 * Registry scheduling, retention, and envelope freshness remain engine
 * responsibilities.
 */
export class SnapshotProvider implements Provider<SnapshotProviderResult> {
  readonly kind = "snapshot" as const;
  readonly id: "snapshot";

  private readonly source: SnapshotSource;
  private readonly config: DeckConfigDocument;
  private readonly now: () => Date;
  private readonly logger: Pick<ModuleLogger, "info"> | undefined;

  /** Retained accepted snapshot and findings, reused on an unchanged read. */
  private latestSnapshot: SnapshotDocument | null = null;
  private latestFindings: readonly Finding[] = [];
  private latestClassification: 0 | 1 = 0;

  /** Cached non-I/O health; updated by fetch(), never by a health() probe. */
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first snapshot poll" };

  constructor(id: "snapshot", config: SnapshotProviderConfig) {
    this.id = id;
    this.source = config.source;
    this.config = config.config;
    this.now = config.now ?? (() => new Date());
    this.logger = config.logger;
  }

  /** Return the latest in-memory read health without source I/O. */
  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  /**
   * Read once under the registry-owned abort signal.
   *
   * The whole attempt is wrapped so that exactly one `snapshot.read` event is
   * emitted in `finally` for every outcome — clean, findings, unchanged, and every
   * refusal — even when reading, parsing, validation, threshold parsing,
   * acceptance, or event preparation fails. Logging failure is swallowed so
   * observability can never alter poll behavior.
   *
   * @throws {SnapshotReadFailure} For every refused read. The thrown message is safe.
   */
  async fetch(context?: ProviderFetchContext): Promise<SnapshotProviderResult> {
    // Scheduler calls always pass their timeout signal; a direct caller that
    // omits context reads under a live, non-aborted signal.
    const signal = context?.signal ?? new AbortController().signal;
    const startedAt = performance.now();
    const readAt = this.now();

    // Seed a refused event so a throw before any branch still logs safely.
    let event: SnapshotReadEvent = {
      event: "snapshot.read",
      sourceKind: this.source.kind,
      outcome: "refused",
      findingsCount: 0,
      bytes: 0,
      durationMs: 0,
    };

    try {
      const read = await this.source.read(signal);

      if (!read.changed) {
        const result = this.completeUnchanged(readAt);
        event = {
          ...event,
          outcome: "unchanged",
          findingsCount: this.latestFindings.length,
          bytes: read.bytes,
        };
        return result;
      }

      // Changed: parse and validate exactly once.
      const parsed = parseSnapshot(read.text);
      const validation = validateSnapshot(parsed, this.config);
      const { snapshot, findings } = requireAcceptedSnapshot(parsed, validation);

      // Threshold parsing, host-state derivation, and result construction must
      // all succeed before the candidate revision is accepted.
      const staleAfterMs = parseStaleAfterMs(this.config.estate?.freshness?.snapshotStaleAfter);
      const hostStates = deriveHostStates(this.config, snapshot, readAt, staleAfterMs);
      const result = buildResult(snapshot, findings, hostStates, readAt);

      // Accept only after the entire candidate is ready.
      this.source.accept(read.revision);

      const classification = classifyFindings(findings);
      this.latestSnapshot = snapshot;
      this.latestFindings = findings;
      this.latestClassification = classification;
      this.latestHealth = successHealth(classification, findings.length);
      event = {
        ...event,
        outcome: classification === 0 ? "clean" : "findings",
        findingsCount: findings.length,
        bytes: read.bytes,
      };
      return result;
    } catch (error) {
      const failure = normalizeSnapshotFailure(error);
      this.latestHealth = { ok: false, detail: failure.code };
      event = {
        ...event,
        outcome: "refused",
        failureClass: failure.code,
        findingsCount: 0,
        // Declared-size refusals report declared length, streamed refusals report
        // cumulative consumed bytes, and unknown/abort failures report zero. The
        // internal count is never exposed on the public error.
        bytes: failure.details.attemptedBytes ?? 0,
        ...(failure.details.httpStatus === undefined
          ? {}
          : { httpStatus: failure.details.httpStatus }),
      };
      throw failure;
    } finally {
      event.durationMs = Math.max(0, performance.now() - startedAt);
      this.emitReadEvent(event);
    }
  }

  /**
   * Project a failed poll into retained data without recording a successful read.
   * Returns `null` when no successful payload exists yet. Otherwise it retains the
   * accepted `snapshot`, `findings`, and `lastReadAt`, recomputes `hostStates`
   * against `now()`, and sets only a safe `readError`. It never calls the source,
   * never accepts a revision, and never advances `lastReadAt`.
   */
  onFetchError(
    error: unknown,
    retainedData: Readonly<SnapshotProviderResult> | null,
  ): SnapshotProviderResult | null {
    if (retainedData === null) return null;

    const failure = normalizeSnapshotFailure(error);
    const staleAfterMs = parseStaleAfterMs(this.config.estate?.freshness?.snapshotStaleAfter);
    const hostStates = deriveHostStates(this.config, retainedData.snapshot, this.now(), staleAfterMs);

    return Object.freeze({
      snapshot: retainedData.snapshot,
      findings: retainedData.findings,
      hostStates,
      lastReadAt: retainedData.lastReadAt,
      readError: failure.toPublic(),
    });
  }

  /**
   * Complete an unchanged read: reuse the retained snapshot and findings, recompute
   * host ages against the new read time, and advance `lastReadAt`. Invokes neither
   * `JSON.parse` nor `validateSnapshot`. Requires a prior successful result, which
   * the source guarantees before it can report an unchanged revision.
   */
  private completeUnchanged(readAt: Date): SnapshotProviderResult {
    const snapshot = this.latestSnapshot;
    if (snapshot === null) {
      throw new SnapshotReadFailure("INTERNAL", SNAPSHOT_READ_MESSAGES.INTERNAL);
    }
    const staleAfterMs = parseStaleAfterMs(this.config.estate?.freshness?.snapshotStaleAfter);
    const hostStates = deriveHostStates(this.config, snapshot, readAt, staleAfterMs);
    const result = buildResult(snapshot, this.latestFindings, hostStates, readAt);
    this.latestHealth = successHealth(this.latestClassification, this.latestFindings.length);
    return result;
  }

  /**
   * Emit exactly one structured `snapshot.read` event, swallowing any logging
   * failure so observability cannot alter the poll outcome (same isolation
   * convention as the generic provider registry).
   */
  private emitReadEvent(event: SnapshotReadEvent): void {
    try {
      if (this.logger === undefined) logger.info(event, "snapshot read");
      else this.logger.info({ ...event }, "snapshot read");
    } catch {
      // Intentionally ignored: a logging failure must not change fetch behavior.
    }
  }
}

/** Build the exact five-key immutable result with a cleared read error. */
function buildResult(
  snapshot: SnapshotDocument,
  findings: readonly Finding[],
  hostStates: Readonly<Record<string, HostState>>,
  readAt: Date,
): SnapshotProviderResult {
  const result: SnapshotProviderResult = {
    snapshot,
    findings,
    hostStates,
    lastReadAt: readAt.toISOString(),
    readError: null,
  };
  return Object.freeze(result);
}

/** Reproduce the estate-contract classification of an accepted finding set. */
function classifyFindings(findings: readonly Finding[]): 0 | 1 {
  return findings.some((finding) => finding.severity !== "info") ? 1 : 0;
}

/** Non-I/O health for an accepted changed or unchanged successful read. */
function successHealth(classification: 0 | 1, findingsCount: number): ProviderHealth {
  return classification === 0
    ? { ok: true, detail: "Snapshot clean" }
    : { ok: true, detail: `Snapshot accepted with ${findingsCount} finding(s)` };
}

/** The snapshot provider's fixed schedule: slower than the default, retaining age on failure. */
export const SNAPSHOT_TIMING = {
  pollIntervalMs: 60_000,
  ttlMs: 60_000,
  unreachableAfterMs: 180_000,
  timeoutMs: POLL_DEFAULTS.timeoutMs,
  failureFreshness: "age-retained",
} as const satisfies ProviderTiming;

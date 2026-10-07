/**
 * Two-tier append-only audit store for governed actions.
 *
 * Tier 1: a compact `audit.jsonl` index — one atomic `O_APPEND` write per run.
 * Tier 2: per-run `runs/<runId>.log` output files holding the full captured output.
 *
 * `AuditTarget`, `AuditEntry`, `AuditListItem`, `AuditDetail`, `AuditStore`,
 * `AuditOutputSink`, and `AuditLogger` are all DEFINED here. Of those, only the four
 * data types (`AuditTarget`, `AuditEntry`, `AuditListItem`, `AuditDetail`) are
 * re-exported through the `contract` barrel for `apps/web`; `AuditStore`,
 * `AuditOutputSink`, and `AuditLogger` are server-internal seams and stay off the
 * barrel. `ActionOutcome` is imported from `./events.js`; `ResolvedParams` is
 * type-imported from `./validate.js`.
 */

import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ActionOutcome } from "./events.js";
import type { ResolvedParams } from "./validate.js";

/** Target of an action, mirrored verbatim from the frozen Action schema. */
export interface AuditTarget {
  host: string;
  service?: string;
}

/**
 * One append-only audit index line (one JSON object per line in `audit.jsonl`).
 * Deliberately compact: bulk output lives in `runs/<runId>.log`, never here
 * (the compactness invariant that keeps the single-syscall append atomic).
 */
export interface AuditEntry {
  /** crypto.randomUUID(); also the `runs/<runId>.log` filename stem. */
  runId: string;
  /** ISO-8601 UTC timestamp of run start (or refusal time for pre-run rejections). */
  timestamp: string;
  /** Declared action id. */
  actionId: string;
  /** Declared runner NAME — never the resolved absolute path. */
  runner: string;
  /** Resolved/validated parameter values, recorded unredacted in V1. */
  params: ResolvedParams;
  /** Optional host/service target. */
  target?: AuditTarget;
  /** Request origin: X-Forwarded-For[0] -> X-Real-IP -> "unknown". */
  source: string;
  /** Terminal outcome. */
  outcome: ActionOutcome;
  /** Process exit code for succeeded/failed; null otherwise. */
  exitStatus: number | null;
  /** Wall-clock duration in milliseconds (0 for pre-run rejections). */
  durationMs: number;
  /** Byte size of `runs/<runId>.log`; 0 for pre-run rejections (no log file). */
  outputBytes: number;
}

/**
 * List-view projection derived from the index alone. Omits `params`: bulk detail
 * is unnecessary for the list; the detail view reads the full entry plus the `.log`.
 */
export interface AuditListItem {
  runId: string;
  timestamp: string;
  actionId: string;
  runner: string;
  target?: AuditTarget;
  outcome: ActionOutcome;
  exitStatus: number | null;
  durationMs: number;
  outputBytes: number;
}

/** One full audit record returned by the detail route: index entry + captured output. */
export interface AuditDetail {
  entry: AuditEntry;
  /** Full captured output from `runs/<runId>.log`, or "" for pre-run rejections. */
  output: string;
}

/** Append-only two-tier audit store: a compact index plus one output file per run. */
export interface AuditStore {
  /**
   * Append one index line atomically (single O_APPEND write). Used for both terminal
   * outcomes and pre-run rejections.
   */
  append(entry: AuditEntry): Promise<void>;
  /**
   * Open a per-run output sink; the executor writes chunks as they arrive so a
   * disconnected/long run still persists complete output.
   */
  openOutput(runId: string): AuditOutputSink;
  /** List index entries newest-first for the audit list view. */
  list(): Promise<AuditListItem[]>;
  /** Read one entry plus its captured output; undefined if the runId is unknown. */
  read(runId: string): Promise<AuditDetail | undefined>;
}

/** A single-writer sink for one run's captured output (`runs/<runId>.log`). */
export interface AuditOutputSink {
  /** Append a chunk (stdout or stderr, interleaved as produced). */
  write(chunk: Uint8Array): Promise<void>;
  /** Close the sink and return the total bytes written (feeds AuditEntry.outputBytes). */
  close(): Promise<number>;
}

/** Minimal logging surface (mirrors the pino logger seam, logger.ts). */
export interface AuditLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Create the two-tier audit store rooted at `<dataDir>/actions/`.
 * Ensures `actions/` and `actions/runs/` exist (idempotent). Append-only:
 * nothing here rotates, truncates, or deletes.
 *
 * @param dataDir The data root (DECK_DATA_DIR).
 * @param logger  Optional structured logger for corrupt-line warnings.
 * @throws If the directories cannot be created (surfaced at boot, fail-fast).
 */
export function createAuditStore(dataDir: string, logger?: AuditLogger): AuditStore {
  return openAuditStore(join(dataDir, "actions"), logger);
}

/**
 * Open the audit store at `baseDir` itself (the actions module's data dir,
 * `$DECK_DATA_DIR/actions`): `audit.jsonl` plus `runs/`, created if missing.
 */
export function openAuditStore(baseDir: string, logger?: AuditLogger): AuditStore {
  const runsDir = join(baseDir, "runs");
  const indexPath = join(baseDir, "audit.jsonl");
  mkdirSync(runsDir, { recursive: true }); // also creates baseDir
  return new FsAuditStore(baseDir, runsDir, indexPath, logger);
}

const APPEND_FLAGS = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY;

class FsAuditStore implements AuditStore {
  constructor(
    private readonly baseDir: string,
    private readonly runsDir: string,
    private readonly indexPath: string,
    private readonly logger?: AuditLogger,
  ) {}

  async append(entry: AuditEntry): Promise<void> {
    const buf = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    // O_APPEND | O_CREAT | O_WRONLY: open at end, create if missing, write-only.
    // One openSync + one writeSync + closeSync => exactly one append write() syscall.
    let fd: number;
    try {
      fd = openSync(this.indexPath, APPEND_FLAGS, 0o644);
    } catch (cause) {
      throw new Error(`audit: cannot open index for append at ${this.indexPath}`, {
        cause,
      });
    }
    try {
      const written = writeSync(fd, buf); // single write() of the whole compact line
      if (written !== buf.byteLength) {
        // Defensive: a short write would corrupt the invariant. Surface, never ignore.
        throw new Error(`audit: short index write (${written}/${buf.byteLength} bytes)`);
      }
    } catch (cause) {
      throw new Error("audit: failed to append index line", { cause });
    } finally {
      closeSync(fd);
    }
  }

  openOutput(runId: string): AuditOutputSink {
    return new FsAuditOutputSink(this.logPath(runId));
  }

  async list(): Promise<AuditListItem[]> {
    const raw = await this.readIndexText();
    if (raw === undefined) return []; // no runs yet: empty list, not an error

    const lines = raw.split("\n");
    const items: AuditListItem[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue; // blank/trailing newline
      const entry = this.parseIndexLine(line, i, lines.length);
      if (entry === undefined) continue; // corrupt line handled in parseIndexLine
      items.push(toListItem(entry));
    }
    return items.reverse(); // append-order -> newest-first
  }

  async read(runId: string): Promise<AuditDetail | undefined> {
    const raw = await this.readIndexText();
    if (raw === undefined) return undefined;

    const lines = raw.split("\n");
    let entry: AuditEntry | undefined;
    // Scan newest-first so a (schema-forbidden) duplicate id resolves to the latest.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const parsed = this.parseIndexLine(line, i, lines.length);
      if (parsed?.runId === runId) {
        entry = parsed;
        break;
      }
    }
    if (entry === undefined) return undefined;

    const output = entry.outputBytes > 0 ? await this.readLog(runId) : "";
    return { entry, output };
  }

  private logPath(runId: string): string {
    return join(this.runsDir, `${runId}.log`);
  }

  private async readIndexText(): Promise<string | undefined> {
    try {
      return await readFile(this.indexPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`audit: cannot read index at ${this.indexPath}`, {
        cause: err as Error,
      });
    }
  }

  private async readLog(runId: string): Promise<string> {
    try {
      // UTF-8 with lossy replacement; binary-heavy output is not a V1 concern.
      return await readFile(this.logPath(runId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return ""; // log missing: no crash
      throw new Error(`audit: cannot read output log for run ${runId}`, {
        cause: err as Error,
      });
    }
  }

  private parseIndexLine(line: string, index: number, total: number): AuditEntry | undefined {
    try {
      return JSON.parse(line) as AuditEntry;
    } catch (cause) {
      const isFinal = index === total - 1;
      if (isFinal) {
        // Truncated tail from a crash mid-write: expected, drop silently-but-logged.
        this.logger?.warn(
          { path: this.indexPath, line: index },
          "audit: dropping truncated final index line",
        );
      } else {
        // Interior corruption is not expected under O_APPEND atomicity: surface it,
        // but keep the rest of the history readable (no throw).
        this.logger?.warn(
          { path: this.indexPath, line: index, cause: String(cause) },
          "audit: skipping corrupt interior index line",
        );
      }
      return undefined;
    }
  }
}

class FsAuditOutputSink implements AuditOutputSink {
  private fd: number | undefined;
  private bytes = 0;
  private closed = false;

  constructor(private readonly path: string) {
    // Single-writer: open once, O_APPEND|O_CREAT|O_WRONLY, keep fd for the run's life.
    this.fd = openSync(this.path, APPEND_FLAGS, 0o644);
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed || this.fd === undefined) {
      throw new Error("audit: write to a closed output sink");
    }
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const n = writeSync(this.fd, buf);
    this.bytes += n;
  }

  /** Idempotent close; returns total bytes written (feeds AuditEntry.outputBytes). */
  async close(): Promise<number> {
    if (!this.closed && this.fd !== undefined) {
      closeSync(this.fd);
      this.closed = true;
      this.fd = undefined;
    }
    return this.bytes;
  }
}

function toListItem(e: AuditEntry): AuditListItem {
  return {
    runId: e.runId,
    timestamp: e.timestamp,
    actionId: e.actionId,
    runner: e.runner,
    target: e.target,
    outcome: e.outcome,
    exitStatus: e.exitStatus,
    durationMs: e.durationMs,
    outputBytes: e.outputBytes,
  };
}

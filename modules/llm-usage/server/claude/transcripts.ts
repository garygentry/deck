import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { TokenCounts, TranscriptTotals } from "../types.js";

/**
 * Claude transcript scan (`<projects>/**\/*.jsonl`, per-message `message.usage`).
 * Consumption in tokens, never quota percent, over an internal format that changes
 * between versions: a supplement, never a foundation. Only token counts are read; the
 * files also hold prompt and code content, which never leaves this module.
 *
 * Claude Code writes one line per content block and repeats the message's usage on each,
 * so entries are de-duplicated by `message.id` + `requestId` (across files too: a resumed
 * session can carry earlier lines into a new file).
 */

const HOUR_MS = 3_600_000;
export const TRANSCRIPT_WINDOW_MS = 7 * 24 * HOUR_MS;
const SESSION_WINDOW_MS = 5 * HOUR_MS;

const blank = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 });

export function emptyTotals(): TranscriptTotals {
  return { window5h: blank(), window7d: blank(), byModel: {}, files: 0 };
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** One API response's token usage, as read from a transcript line. */
export interface UsageEntry {
  /** De-duplication key (`message.id` + `requestId`), or null when the line has neither. */
  key: string | null;
  at: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * The byte pattern every usage line contains. Inside a JSON string a quote is escaped, so
 * this only matches the structural key: huge tool-result lines that merely mention usage
 * are skipped without being decoded or parsed.
 */
const USAGE_MARKER = Buffer.from("\"usage\":{");

/** Parse one transcript line into a usage entry, or null when it carries none. */
export function parseUsageLine(line: string): UsageEntry | null {
  if (!line.includes("\"usage\":{")) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(entry) || !isRecord(entry.message) || !isRecord(entry.message.usage)) return null;
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const { message } = entry;
  const usage = message.usage as JsonRecord;
  const id = typeof message.id === "string" ? message.id : "";
  const request = typeof entry.requestId === "string" ? entry.requestId : "";
  return {
    key: id || request ? `${id}:${request}` : null,
    at,
    model: typeof message.model === "string" ? message.model : "unknown",
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheCreate: count(usage.cache_creation_input_tokens),
  };
}

function addEntry(totals: TranscriptTotals, entry: UsageEntry, now: number): void {
  if (entry.at < now - TRANSCRIPT_WINDOW_MS) return;
  const add = (acc: TokenCounts) => {
    acc.input += entry.input;
    acc.output += entry.output;
    acc.cacheRead += entry.cacheRead;
    acc.cacheCreate += entry.cacheCreate;
    acc.messages += 1;
  };
  add(totals.window7d);
  if (entry.at >= now - SESSION_WINDOW_MS) add(totals.window5h);
  add((totals.byModel[entry.model] ??= blank()));
}

/** Fold one transcript line into `totals` (mutated). Lines without usage are ignored. */
export function accumulateTranscriptLine(totals: TranscriptTotals, line: string, now: number): void {
  const entry = parseUsageLine(line);
  if (entry) addEntry(totals, entry, now);
}

/** Window totals over entries from any number of files, counting each API response once. */
export function totalsFromEntries(entries: Iterable<UsageEntry>, files: number, now: number): TranscriptTotals {
  const totals = emptyTotals();
  totals.files = files;
  // A response's lines carry growing usage (the last holds the final output count), and
  // copies in other files can differ, so keep the largest rather than trusting file order.
  const unique = new Map<string, UsageEntry>();
  let anonymous = 0;
  for (const entry of entries) {
    const key = entry.key ?? `#${anonymous++}`;
    const kept = unique.get(key);
    if (!kept || entry.output > kept.output || (entry.output === kept.output && entry.at > kept.at)) {
      unique.set(key, entry);
    }
  }
  for (const entry of unique.values()) addEntry(totals, entry, now);
  return totals;
}

/** Passes are cached this long; the totals only feed a supplementary panel. */
export const TRANSCRIPT_CACHE_MS = 60_000;
/** `<projects>/<project>/<session>/subagents/*.jsonl` sits three levels down. */
const MAX_DEPTH = 4;

interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

/** `.jsonl` files under `dir` modified inside the 7-day window. Symlinks are not followed. */
async function recentTranscriptFiles(dir: string, now: number): Promise<TranscriptFile[]> {
  const cutoff = now - TRANSCRIPT_WINDOW_MS;
  const files: TranscriptFile[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (depth === 0) throw error;
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(full);
          if (info.mtimeMs >= cutoff) files.push({ path: full, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino });
        } catch {
          // Removed between readdir and stat.
        }
      }
    }
  };
  await walk(dir, 0);
  return files;
}

const CHUNK_BYTES = 256 * 1024;

/**
 * Read the complete lines of `path` from byte `offset` to `end`, calling `onLine` with each
 * usage line. Returns the offset just past the last complete line: a line still being
 * written is left for the next pass. Lines without the usage marker are never decoded.
 */
async function readAppendedLines(
  path: string,
  offset: number,
  end: number,
  onLine: (line: string) => void,
): Promise<number> {
  const handle = await open(path, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let position = offset;
    let consumed = offset;
    let pending: Buffer[] = [];
    while (position < end) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, end - position), position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let data = chunk.subarray(0, bytesRead);
      let start = 0;
      let newline = data.indexOf(10);
      if (newline === -1) {
        pending.push(Buffer.from(data)); // part of a long line; joined once its end arrives
        continue;
      }
      if (pending.length > 0) {
        data = Buffer.concat([...pending, data]);
        newline += data.length - bytesRead;
        pending = [];
      }
      while (newline !== -1) {
        const line = data.subarray(start, newline);
        if (line.indexOf(USAGE_MARKER) !== -1) onLine(line.toString("utf8"));
        consumed += newline + 1 - start;
        start = newline + 1;
        newline = data.indexOf(10, start);
      }
      if (start < data.length) pending.push(Buffer.from(data.subarray(start)));
    }
    return consumed;
  } finally {
    await handle.close();
  }
}

export type TranscriptScan =
  | { ok: true; totals: TranscriptTotals; scannedAt: number }
  | { ok: false; detail: string; scannedAt: number };

interface FileState {
  ino: number;
  /** Bytes consumed so far: the end of the last complete line read. */
  offset: number;
  entries: UsageEntry[];
}

/**
 * Incremental transcript index. Transcripts are append-only, so each pass stats the tree
 * and reads only the bytes appended since the last pass; a file that shrank or was replaced
 * (new inode) is re-read from the start, and files that vanish or age out are dropped. (A
 * file rewritten in place, same inode, and grown past the old offset between passes would
 * be misread; Claude Code only appends or replaces transcripts.)
 * Memory is the compact usage entries of the last 7 days, never file contents.
 */
export class TranscriptIndex {
  private readonly files = new Map<string, FileState>();

  constructor(private readonly dir: string) {}

  async update(now: number): Promise<TranscriptScan> {
    let listed: TranscriptFile[];
    try {
      listed = await recentTranscriptFiles(this.dir, now);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { ok: false, detail: `transcripts dir unreadable${code ? ` (${code})` : ""}`, scannedAt: now };
    }
    const seen = new Set<string>();
    const cutoff = now - TRANSCRIPT_WINDOW_MS;
    for (const file of listed) {
      seen.add(file.path);
      let state = this.files.get(file.path);
      if (!state || state.ino !== file.ino || file.size < state.offset) {
        state = { ino: file.ino, offset: 0, entries: [] };
        this.files.set(file.path, state);
      }
      if (file.size > state.offset) {
        // Commit a read only once it completes: a failure part-way would otherwise re-add
        // the same lines on the retry.
        const read: UsageEntry[] = [];
        try {
          const offset = await readAppendedLines(file.path, state.offset, file.size, (line) => {
            const entry = parseUsageLine(line);
            if (entry && entry.at >= cutoff) read.push(entry);
          });
          state.offset = offset;
          state.entries.push(...read);
        } catch {
          // Vanished or unreadable mid-pass: the next pass retries from the same offset.
        }
      }
      if (state.entries.length > 0 && state.entries[0]!.at < cutoff) {
        state.entries = state.entries.filter((entry) => entry.at >= cutoff);
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);

    const all = function* (states: Iterable<FileState>) {
      for (const state of states) yield* state.entries;
    };
    return { ok: true, totals: totalsFromEntries(all(this.files.values()), listed.length, now), scannedAt: now };
  }
}

/** One full (non-incremental) scan; kept for callers that need a single pass. */
export async function scanTranscripts(dir: string, now: number): Promise<TranscriptScan> {
  return new TranscriptIndex(dir).update(now);
}

export interface TranscriptScanner {
  /**
   * The latest completed scan, up to {@link TRANSCRIPT_CACHE_MS} old (measured from when
   * it finished), or null before the first one finishes. Never waits: a stale or missing
   * result starts a background pass, so a large projects dir cannot stall an API read.
   */
  latest(): TranscriptScan | null;
  /** Wait for a result fresher than the cache window (starting a pass if needed). */
  refresh(): Promise<TranscriptScan>;
}

/**
 * A {@link TranscriptIndex} behind a {@link TRANSCRIPT_CACHE_MS} cache; concurrent callers
 * share one pass. Freshness counts from a pass's completion, so a slow first pass over a
 * large history is not immediately followed by another.
 */
export function createTranscriptScanner(dir: string, now: () => number = Date.now): TranscriptScanner {
  const index = new TranscriptIndex(dir);
  let cached: TranscriptScan | null = null;
  let completedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<TranscriptScan> | null = null;
  const fresh = () => cached !== null && now() - completedAt < TRANSCRIPT_CACHE_MS;
  const refresh = (): Promise<TranscriptScan> => {
    if (fresh()) return Promise.resolve(cached!);
    inFlight ??= index.update(now()).then((scan) => {
      cached = scan;
      completedAt = now();
      return scan;
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  return {
    latest() {
      // A failed pass keeps the last result; it must never surface as an unhandled rejection.
      if (!fresh()) refresh().catch(() => {});
      return cached;
    },
    refresh,
  };
}

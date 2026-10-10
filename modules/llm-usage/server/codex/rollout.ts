import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseRolloutTail, type RolloutReading } from "./bars.js";

/**
 * Codex rollout tail. Every Codex turn appends a `token_count` event carrying the same
 * rate-limit snapshot the app-server serves, so the newest `rollout-*.jsonl` under
 * `<codexHome>/sessions/YYYY/MM/DD/` picks up activity from any codex process sharing
 * the home: the cross-process signal the app-server's own notification cannot give.
 */

export const TAIL_BYTES = 256 * 1024;
/** Activity stat loop period. */
export const WATCH_INTERVAL_MS = 5_000;
/** How often the watcher re-walks the tree for a newer file, rather than re-stating the last one. */
export const RESCAN_INTERVAL_MS = 60_000;
const MAX_DEPTH = 6;

export interface RolloutFile {
  path: string;
  mtimeMs: number;
}

const isRollout = (name: string) => name.startsWith("rollout-") && name.endsWith(".jsonl");

/** The most recently modified rollout file under `dir`, or null when there is none. Symlinks are not followed. */
export async function findNewestRollout(dir: string): Promise<RolloutFile | null> {
  let best: RolloutFile | null = null;
  const walk = async (current: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (entry.isFile() && isRollout(entry.name)) {
        try {
          const { mtimeMs } = await stat(full);
          if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
        } catch {
          // Removed between readdir and stat.
        }
      }
    }
  };
  await walk(dir, 0);
  return best;
}

export async function readTail(path: string, bytes = TAIL_BYTES): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export type RolloutResult =
  | { status: "ok"; file: RolloutFile; reading: RolloutReading }
  /** No rollout files yet, or the newest has no rate-limit event yet. */
  | { status: "no-data-yet"; detail: string }
  | { status: "error"; detail: string };

export async function readNewestRollout(dir: string): Promise<RolloutResult> {
  const file = await findNewestRollout(dir);
  if (!file) return { status: "no-data-yet", detail: "no rollout files yet" };
  let text: string;
  try {
    text = await readTail(file.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: "error", detail: `rollout unreadable${code ? ` (${code})` : ""}` };
  }
  const reading = parseRolloutTail(text);
  return reading
    ? { status: "ok", file, reading }
    : { status: "no-data-yet", detail: "no rate limits in the newest rollout yet" };
}

/**
 * Cheap activity detector: re-stat the newest known rollout every tick and re-walk the
 * tree every {@link RESCAN_INTERVAL_MS}, calling `onActivity` when the newest mtime moves.
 * The first observation only establishes a baseline. The collector starts it while a
 * viewer is present and stops it when paused.
 */
export class RolloutWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private newest: RolloutFile | null = null;
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private ticking = false;
  private baselined = false;

  constructor(
    private readonly dir: string,
    private readonly onActivity: (file: RolloutFile) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get watching(): boolean {
    return this.timer !== null;
  }

  start(intervalMs = WATCH_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One observation; public so tests can drive it without timers. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let current: RolloutFile | null = null;
      if (this.newest && this.now() - this.lastScanAt < RESCAN_INTERVAL_MS) {
        try {
          current = { path: this.newest.path, mtimeMs: (await stat(this.newest.path)).mtimeMs };
        } catch {
          current = null;
        }
      }
      if (!current) {
        current = await findNewestRollout(this.dir);
        this.lastScanAt = this.now();
      }
      const previous = this.newest;
      const moved = current !== null
        && (previous === null || current.path !== previous.path || current.mtimeMs > previous.mtimeMs);
      this.newest = current;
      if (moved && this.baselined) this.onActivity(current!);
      this.baselined = true;
    } finally {
      this.ticking = false;
    }
  }
}

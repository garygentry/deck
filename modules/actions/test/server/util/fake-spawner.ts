import type { RunnerSpawner, SpawnedRun } from "../../../server/spawn.js";

/**
 * Scripted behaviour for one fake spawn call. Reused by the executor tests and the route
 * integration tests — no Bun, no real subprocess.
 */
export interface FakeSpawnerScript {
  /** stdout chunks yielded incrementally (one wire event per non-empty decode). */
  stdout?: Uint8Array[];
  /** stderr chunks yielded incrementally. */
  stderr?: Uint8Array[];
  /** Exit code the child reports when it exits naturally (default 0). */
  exitCode?: number;
  /** When set, `spawn()` throws this synchronously (maps to outcome "error"). */
  throwOnSpawn?: unknown;
  /** When true, the child never exits on its own; only `kill()`/`releaseHang()` end it. */
  hang?: boolean;
  /** A hanging child that ignores SIGTERM: only SIGKILL ends it. */
  ignoreTerm?: boolean;
  /** Its streams stay open after it exits (something it started holds the pipes). */
  holdStreams?: boolean;
  /** Delay in ms between chunks. Default 0 (a microtask), so chunks arrive "over time". */
  chunkDelayMs?: number;
}

/** Observable state of one spawned fake child. */
export interface FakeSpawnHandle {
  /** Signals passed to `kill()`, in order. */
  killSignals: (NodeJS.Signals | undefined)[];
  /** Manually end a hanging run (resolve its streams + exit). */
  releaseHang(): void;
}

/** One recorded `spawn()` invocation. */
export interface FakeSpawnCall {
  executable: string;
  stdinJson: string;
  handle?: FakeSpawnHandle;
}

export interface FakeSpawner extends RunnerSpawner {
  /** Every `spawn()` call in order (executable + stdin JSON + child handle). */
  calls: FakeSpawnCall[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a fake `RunnerSpawner`. Pass a single script (reused for every call) or an array
 * (one per call, in order) — the array form drives the concurrency test where two runs
 * carry independent scripts.
 */
export function createFakeSpawner(
  scripts: FakeSpawnerScript | FakeSpawnerScript[],
): FakeSpawner {
  const queue = Array.isArray(scripts) ? [...scripts] : null;
  const single = Array.isArray(scripts) ? null : scripts;
  const calls: FakeSpawnCall[] = [];
  let index = 0;

  return {
    calls,
    spawn(executable: string, stdinJson: string): SpawnedRun {
      const script = queue ? (queue[index++] ?? {}) : single!;
      const call: FakeSpawnCall = { executable, stdinJson };
      calls.push(call);

      if (script.throwOnSpawn !== undefined) {
        throw script.throwOnSpawn;
      }

      const delayMs = script.chunkDelayMs ?? 0;
      const hang = script.hang ?? false;
      const exitCode = script.exitCode ?? 0;

      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      let resolveExited: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExited = resolve;
      });

      // When not hanging, the child exits once BOTH streams have been fully consumed.
      let remaining = 2;
      const streamDone = () => {
        if (--remaining === 0 && !hang) resolveExited(exitCode);
      };

      async function* stream(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
        try {
          for (const chunk of chunks) {
            if (delayMs > 0) await delay(delayMs);
            else await Promise.resolve();
            yield chunk;
          }
          if (hang) await gate; // stay open until kill()/releaseHang()
        } finally {
          streamDone();
        }
      }

      const killSignals: (NodeJS.Signals | undefined)[] = [];
      const end = () => {
        if (!script.holdStreams) releaseGate();
        resolveExited(exitCode);
      };

      call.handle = { killSignals, releaseHang: end };

      return {
        stdout: stream(script.stdout ?? []),
        stderr: stream(script.stderr ?? []),
        exited,
        kill(signal?: NodeJS.Signals) {
          killSignals.push(signal);
          if (script.ignoreTerm && signal !== "SIGKILL") return;
          end();
        },
      };
    },
  };
}

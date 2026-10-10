/**
 * The subprocess spawn abstraction for governed actions.
 *
 * `RunnerSpawner` / `SpawnedRun` are the injection seam: the executor is coded
 * against these interfaces so unit tests inject a fake yielding scripted chunks (no Bun,
 * no real subprocess). `createBunRunnerSpawner()` is the production implementation,
 * backed by `Bun.spawn`. Following the `lazyServeStatic` discipline in
 * `apps/server/src/server/app.ts`, the `Bun` global is referenced ONLY inside `spawn()`,
 * never at module scope — so importing this file under Node/vitest never touches Bun.
 */

/**
 * A spawned runner process, abstracted so unit tests inject a fake yielding scripted
 * chunks and a chosen exit code.
 */
export interface SpawnedRun {
  /** Incremental stdout chunks as produced. */
  stdout: AsyncIterable<Uint8Array>;
  /** Incremental stderr chunks as produced. */
  stderr: AsyncIterable<Uint8Array>;
  /** Resolves with the process exit code when the child exits. */
  exited: Promise<number>;
  /**
   * Signal the child and anything it started locally (its process group): timeout and
   * cancel send SIGTERM, then SIGKILL if it has not exited.
   */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Spawns an allowlisted executable with structured JSON on stdin and NO interpolated
 * argv. The real implementation lazily uses `Bun.spawn`.
 */
export interface RunnerSpawner {
  /**
   * @param executable Absolute path resolved from the runner manifest (never built).
   * @param stdinJson  Serialized StructuredRunnerInput written to the child's stdin.
   * @throws when the process cannot be started (mapped to outcome "error").
   */
  spawn(executable: string, stdinJson: string): SpawnedRun;
}

/**
 * Minimal `Bun.spawn` typing, declared ambiently so this module type-checks under Node
 * (vitest) without @types/bun and without importing anything Bun-only at module scope.
 * Mirrors the `declare const Bun` pattern already used in apps/server/src/server/boot.ts.
 */
declare const Bun: {
  spawn(options: {
    cmd: string[];
    stdin?: Uint8Array;
    stdout?: "pipe";
    stderr?: "pipe";
    detached?: boolean;
  }): {
    pid: number;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
  };
};

/**
 * The production RunnerSpawner. Spawns the allowlisted executable with:
 *   - `cmd: [executable]` ONLY — deck controls argv[0] (the manifest-resolved absolute
 *     path) and nothing else. No parameter value is ever placed on the command line.
 *   - the StructuredRunnerInput JSON as raw bytes on the child's stdin; passing a
 *     Uint8Array as `stdin` writes it and closes stdin, so the child sees a single
 *     complete JSON document then EOF.
 *
 * `Bun.spawn` throws synchronously when the executable cannot be started (ENOENT/EACCES);
 * that throw propagates to the executor and maps to outcome "error".
 */
export function createBunRunnerSpawner(): RunnerSpawner {
  return {
    spawn(executable: string, stdinJson: string): SpawnedRun {
      const proc = Bun.spawn({
        cmd: [executable], // argv[0] only — never interpolated
        stdin: new TextEncoder().encode(stdinJson),
        stdout: "pipe",
        stderr: "pipe",
        // Its own process group, so a kill reaches what it starts (a backgrounded child that
        // inherits the output pipe would otherwise hold it open after the runner dies).
        detached: true,
      });
      return {
        stdout: readableToIterable(proc.stdout),
        stderr: readableToIterable(proc.stderr),
        exited: proc.exited,
        // Signals the runner's local process group. Estate-side cleanup beyond this host
        // is the runner's responsibility, not deck's.
        kill: (signal?: NodeJS.Signals) => {
          try {
            process.kill(-proc.pid, signal ?? "SIGTERM");
          } catch {
            proc.kill(signal); // the group is already gone: signal the child itself
          }
        },
      };
    },
  };
}

/**
 * Adapt a ReadableStream<Uint8Array> to an AsyncIterable<Uint8Array> so SpawnedRun's
 * contract holds regardless of whether the underlying stream is natively
 * async-iterable. The executor consumes chunks as they arrive.
 */
async function* readableToIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

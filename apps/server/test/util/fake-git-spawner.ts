import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitSpawner, SpawnedGit } from "../../src/sources/acquire.js";

/**
 * Scripted behaviour for one fake `git clone`. Applied per CLONE spawn (in order for the
 * array form); non-clone git calls (e.g. `rev-parse HEAD`) are answered generically with a
 * canned commit sha. Mirrors `test/util/fake-spawner.ts` but for the argv-based `GitSpawner`
 * seam (`clone --depth 1 --branch <ref> <repo> <dir>` with a cwd/env) — no Bun, no real git.
 */
export interface FakeGitScript {
  /** Files to stage into the clone target dir (argv's last positional) to simulate a clone. */
  writeFiles?: Record<string, string | Uint8Array>;
  /** Exit code (default 0). Non-zero simulates a clone/fetch failure. */
  exitCode?: number;
  /** stderr lines the fake git emits (asserted to NEVER contain a credential). */
  stderr?: string[];
  /** When set, spawn() throws (simulates `git` absent / ENOENT). */
  throwOnSpawn?: unknown;
  /** Gate `exited` until released — drives the atomic-swap interleave test (§3.2). */
  hang?: boolean;
}

/** One recorded `spawn()` invocation: the full argv, cwd, and env, plus a hang release. */
export interface FakeGitCall {
  argv: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** True for the `git clone …` call this script drove (vs. `rev-parse` etc.). */
  isClone: boolean;
  /** Release a hanging clone (resolve its streams + exit). No-op when not hanging. */
  releaseHang(): void;
}

export interface FakeGitSpawner extends GitSpawner {
  /** Every spawn() call: the full argv, cwd, and env (so tests assert the argv shape + no secret). */
  calls: FakeGitCall[];
}

/** An ENOENT-shaped error mimicking a `git` binary that is absent from PATH. */
export function gitAbsentError(): NodeJS.ErrnoException {
  const err = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  err.syscall = "spawn git";
  return err;
}

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function isClone(argv: readonly string[]): boolean {
  return argv.includes("clone");
}

/** The clone target dir is argv's last positional (after the `--` terminator). */
function cloneDest(argv: readonly string[]): string {
  return argv[argv.length - 1] ?? "";
}

function stageFiles(dest: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dest, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
}

/**
 * Build a fake `GitSpawner`. Pass a single script (reused for every clone) or an array (one
 * per clone, in order). Non-clone git invocations always succeed with a canned HEAD sha.
 */
export function createFakeGitSpawner(scripts: FakeGitScript | FakeGitScript[]): FakeGitSpawner {
  const queue = Array.isArray(scripts) ? [...scripts] : null;
  const single = Array.isArray(scripts) ? null : scripts;
  const calls: FakeGitCall[] = [];
  let cloneIndex = 0;

  return {
    calls,
    spawn(argv: readonly string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): SpawnedGit {
      const clone = isClone(argv);
      const call: FakeGitCall = {
        argv: [...argv],
        cwd: opts?.cwd,
        env: opts?.env,
        isClone: clone,
        releaseHang: () => {},
      };
      calls.push(call);

      // rev-parse HEAD (and any other non-clone probe) → canned sha, exit 0, no hang.
      if (!clone) {
        return staticChild(`${HEAD_SHA}\n`, [], 0);
      }

      const script = queue ? (queue[cloneIndex++] ?? {}) : single!;

      if (script.throwOnSpawn !== undefined) {
        throw script.throwOnSpawn;
      }

      // Stage the clone's files synchronously so the target dir is complete before `exited`.
      if (script.writeFiles) stageFiles(cloneDest(argv), script.writeFiles);

      const exitCode = script.exitCode ?? 0;
      const stderr = script.stderr ?? [];
      const hang = script.hang ?? false;

      let resolveExited: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExited = resolve;
      });
      if (!hang) resolveExited(exitCode);

      const release = () => resolveExited(exitCode);
      call.releaseHang = release;

      return {
        stdout: emptyStream(),
        stderr: stringStream(stderr),
        exited,
        kill: () => release(),
      };
    },
  };
}

function staticChild(stdout: string, stderr: string[], exitCode: number): SpawnedGit {
  return {
    stdout: stringStream([stdout]),
    stderr: stringStream(stderr),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* emptyStream(): AsyncIterable<Uint8Array> {
  // no chunks
}

async function* stringStream(lines: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const line of lines) {
    await Promise.resolve();
    yield encoder.encode(line);
  }
}

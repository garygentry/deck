/**
 * Acquisition for the sources capability: turn one declared `Source.location` (a local
 * `path` or a git `repo`) into a confined, complete, last-good on-disk tree root that the
 * read side (`tree.ts` / `confine.ts`) walks.
 *
 * Local-path sources are used in place (no clone, no copy). Git sources are shallow-cloned
 * through the injected `GitSpawner` seam into a bounded per-source cache and published
 * atomically via a symlink swap so a reader never observes a half-updated tree. Writes ONLY
 * under `deps.cacheDir`, never to the source.
 *
 * Private-repo auth: when a git source declares `Source.credentialEnv`,
 * the token named by that env var is read (through `AcquireDeps.env`) at acquisition time and sent as an
 * ephemeral `http.extraheader: Authorization: Basic …` injected via `GIT_CONFIG_*` env for the
 * clone spawn ONLY. The token is NEVER placed in the clone URL or argv — git persists the remote
 * URL to the clone's `.git/config` (and reflog), so URL-embedded userinfo would leave the
 * credential on disk in the source cache. Env-injected `-c` config is process-scoped: git never
 * writes it to the repo config, and it stays out of the process arg list. The token is never
 * logged (git stdout/stderr are drained and discarded; `events.ts` logs only
 * `{ sourceId, failureKind }`). Public repos and local paths read no credential.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Source } from "@deck/schema";
import { SourceFailure, normalizeSourceFailure } from "./errors.js";
import { logAcquireFailure } from "./events.js";

/**
 * A spawned `git` process. Mirrors `engine-core`'s `SpawnedRun` shape, but the source git
 * seam takes an ARGV ARRAY plus cwd/env (git needs `clone --depth 1 …`, a working dir, and
 * an in-memory credential env) — it deliberately does NOT reuse `modules/actions/server/spawn.ts`
 * `RunnerSpawner`, which is argv[0]-only + stdin-JSON.
 */
export interface SpawnedGit {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  /** Resolves with the git exit code. */
  exited: Promise<number>;
  /** Terminate the child (timeout/abort). */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Spawns the system `git` binary with an explicit argv (never a shell string) and an
 * optional cwd/env. The production impl lazily uses `Bun.spawn` (Bun referenced only
 * inside spawn(), the lazyServeStatic discipline); unit tests inject a fake.
 */
export interface GitSpawner {
  /**
   * @param argv  Full argument vector, e.g. ["git","clone","--depth","1", …]. argv[0] is "git".
   * @param opts  Working directory and process env (credential injected in-memory only).
   * @throws when the process cannot be started (git absent ⇒ acquisition SOURCE_UNAVAILABLE).
   */
  spawn(argv: readonly string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): SpawnedGit;
}

/** The outcome of one acquisition — the freshly-published confined root + resolved ref. */
export interface AcquiredTree {
  /** Absolute path to the confined, published tree root (never crosses the wire). */
  root: string;
  /** Resolved git ref/commit for repo sources; undefined for local-path sources. */
  ref?: string;
}

/**
 * The injected collaborators for acquisition, held by the source's store (built by its
 * data-source module's kind handler) and passed to every `acquireSource` call for it.
 * Everything beyond the pure filesystem is injected so unit tests run with a fake git and a
 * scratch cache dir — no real `git`, no Bun.
 */
export interface AcquireDeps {
  /** Absolute on-disk cache root — `SourcesRuntime.cacheDir`, from DECK_SOURCES_CACHE_DIR. */
  readonly cacheDir: string;
  /** The git spawn seam. Production: Bun.spawn-backed. Tests: a fake. */
  readonly git: GitSpawner;
  /** Wall clock for generation-dir naming; injectable for deterministic tests. Default: Date.now. */
  readonly now?: () => number;
  /**
   * Reads the variable `Source.credentialEnv` names. The source's data-source module passes
   * the reader its kind handler got for this source, so only that source's credential is
   * readable. Default: the process env.
   */
  readonly env?: { get(name: string): string | undefined };
}

/**
 * Per-acquisition context. `signal` is the provider's `ProviderFetchContext.signal` — the
 * registry aborts it on the poll timeout, which this core maps to `ACQUIRE_TIMEOUT`.
 */
export interface AcquireContext {
  readonly deps: AcquireDeps;
  /** Abort signal threaded from the provider fetch context; abort ⇒ ACQUIRE_TIMEOUT. */
  readonly signal: AbortSignal;
}

/**
 * Acquire (or refresh) one source into a confined, complete, last-good on-disk tree and
 * return its root. Local-path sources are used in place; git sources are shallow-cloned to a
 * bounded per-source cache and published atomically. Writes ONLY under `deps.cacheDir`.
 *
 * @throws {SourceFailure} `SOURCE_UNAVAILABLE` (git missing / clone non-zero / local root
 *   unreadable) or `ACQUIRE_TIMEOUT` (signal aborted).
 */
export async function acquireSource(src: Source, ctx: AcquireContext): Promise<AcquiredTree> {
  const { path, repo } = src.location;
  if (typeof path === "string" && path !== "") return acquireLocalPath(src, path);
  if (typeof repo === "string" && repo !== "") return acquireGitRepo(src, repo, ctx);
  // Neither form present ⇒ a malformed source; treated as unavailable (not a crash).
  throw logAndRethrow(
    src,
    new SourceFailure("SOURCE_UNAVAILABLE", undefined, {
      sourceId: src.id,
      failureKind: "no-location",
    }),
  );
}

// --- Local-path acquisition -----------------------

/**
 * Acquire a local-path source: resolve its realpath and confirm it is a readable directory.
 * The "current root" is the realpath-resolved `path` (symlinks collapsed here so the store's
 * per-access confinement has a stable, canonical root). No credential is ever read. Deck
 * writes NOTHING — this arm is read-only stat/realpath.
 */
async function acquireLocalPath(src: Source, path: string): Promise<AcquiredTree> {
  try {
    const root = await realpath(path); // collapse symlinks once → canonical root
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new SourceFailure("SOURCE_UNAVAILABLE", undefined, {
        sourceId: src.id,
        failureKind: "local-not-dir",
      });
    }
    return { root }; // no `ref` for local sources
  } catch (error) {
    if (error instanceof SourceFailure) throw logAndRethrow(src, error);
    // A missing / unreadable acquisition root is an availability problem (ENOENT here is the
    // ROOT, not a confined file — so it is SOURCE_UNAVAILABLE, not PATH_NOT_FOUND).
    throw logAndRethrow(
      src,
      new SourceFailure("SOURCE_UNAVAILABLE", undefined, { sourceId: src.id, failureKind: "read-local" }, {
        cause: error,
      }),
    );
  }
}

// --- Git shallow-clone acquisition ----------------------

/**
 * Acquire a git-repo source: shallow-clone into a fresh incoming generation dir, resolve the
 * checked-out commit, then atomically publish by swapping the `current` symlink. On any
 * failure the incoming dir is removed and `current` (last-good) is left untouched.
 */
async function acquireGitRepo(src: Source, repo: string, ctx: AcquireContext): Promise<AcquiredTree> {
  const { deps, signal } = ctx;
  const sourceDir = sourceCacheDir(deps.cacheDir, src.id);
  await mkdir(sourceDir, { recursive: true });

  // Sweep crash-leftover generations, but keep the live `current` target (last-good) so a
  // refresh never discards a good tree before its replacement is published.
  const liveBefore = await currentTarget(sourceDir);
  await pruneGenerations(sourceDir, liveBefore);

  const now = deps.now ?? Date.now;
  const incoming = join(sourceDir, `gen-${now()}-${randomToken()}`);

  try {
    await runGit(
      deps.git,
      // The clone URL is the declared repo VERBATIM — no credential is ever embedded in the URL
      // or argv (that would persist to the clone's .git/config on disk). When a token applies it
      // rides an ephemeral `http.extraheader` injected via env for THIS spawn only (never
      // persisted, never in the arg list, never logged).
      buildCloneArgv(repo, src.location.ref, incoming),
      { cwd: sourceDir, env: { ...gitEnv(), ...gitAuthEnv(src, repo, deps.env ?? processEnv) } },
      signal,
      src,
      "clone",
    );

    const ref = await resolveCommit(deps.git, incoming, signal);
    const root = await publish(sourceDir, incoming, signal, src);
    await pruneGenerations(sourceDir, root); // drop the superseded generation
    return ref !== undefined ? { root, ref } : { root };
  } catch (error) {
    // Remove the half-cloned incoming dir; leave `current` (last-good) untouched.
    await removeDir(incoming);
    throw logAndRethrow(src, asSourceFailure(error, src, "clone"));
  }
}

/** Build the shallow-clone argv. Hardened: no credential persistence, no interactive prompt. */
function buildCloneArgv(remoteUrl: string, ref: string | undefined, dest: string): string[] {
  const argv = [
    "git",
    // -c options MUST precede the subcommand. Disable on-disk credential storage.
    "-c",
    "credential.helper=",
    "clone",
    "--depth",
    "1", // shallow: only the tip tree, not history
    "--single-branch", // fetch only the target branch's tip
  ];
  if (typeof ref === "string" && ref !== "") {
    argv.push("--branch", ref); // pin to the declared ref/branch/tag
  }
  // `--` terminates options so a hostile repo/ref string can never be read as a flag.
  argv.push("--", remoteUrl, dest);
  return argv;
}

/**
 * Compute the ephemeral git auth config for a private HTTPS repo. Public repos, local paths, and
 * ssh:// / git@ remotes need no credential — returns an empty env. When
 * `Source.credentialEnv` names a SET env var and the repo is an HTTPS URL, the token becomes an
 * `http.extraheader: Authorization: Basic base64("x-access-token:<token>")` carried through
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` — applied to the clone spawn ONLY.
 *
 * This deliberately does NOT put the token in the clone URL/argv: git writes the remote URL into
 * the clone's `.git/config` (and reflog), so URL-embedded userinfo would persist the credential to
 * disk in the source cache. Env-injected `-c` config is process-scoped — git never writes it to the
 * repo config, and it stays out of the process arg list too. The token is never logged
 * (git output is drained/discarded; `events.ts` logs id + kind only).
 *
 * Mirrors the `modules/prometheus` `authHeaders(credentialEnv)` convention: config carries the
 * environment-variable NAME, deck reads the VALUE at acquisition time and never persists it.
 *
 * @param src  The source; `credentialEnv` names the env var holding the token (never its value).
 * @param repo The declared `location.repo`.
 * @param env  Reads the credential variable (`AcquireDeps.env`, else the process env).
 */
function gitAuthEnv(src: Source, repo: string, env: { get(name: string): string | undefined }): NodeJS.ProcessEnv {
  const envName = src.credentialEnv;
  if (envName === undefined || envName === "") return {}; // public/local — no credential

  const token = env.get(envName);
  if (token === undefined || token === "") return {}; // named but unset ⇒ attempt unauthenticated

  // Only HTTPS remotes accept an Authorization header; ssh:// / git@ remotes use their own key
  // agent and are left untouched (a token cannot help there).
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return {};
  }
  if (url.protocol !== "https:") return {};

  // GitHub/GitLab PAT convention: Basic auth, username "x-access-token", password = the token.
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** The process env, for a caller that injects no reader. */
const processEnv = { get: (name: string): string | undefined => process.env[name] };

/** Env for every git spawn: never prompt (paired with stdin:"ignore" in the Bun impl). */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "never",
  };
}

/**
 * Spawn one git invocation, drain its output, and enforce the abort signal. Exit code 0 ⇒
 * success. A non-zero exit, or a spawn throw (git absent), ⇒ SOURCE_UNAVAILABLE. An aborted
 * signal (poll timeout) ⇒ ACQUIRE_TIMEOUT after killing the child. Git's stdout/stderr are
 * drained and DISCARDED — never logged — because a failing clone can echo the remote URL.
 */
async function runGit(
  git: GitSpawner,
  argv: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  signal: AbortSignal,
  src: Source,
  failureKind: string,
): Promise<void> {
  let child: SpawnedGit;
  try {
    child = git.spawn(argv, opts); // may throw synchronously if `git` is absent (ENOENT)
  } catch (cause) {
    throw forceUnavailable(normalizeSourceFailure(cause, { sourceId: src.id, failureKind }));
  }

  const onAbort = () => child.kill("SIGTERM");
  if (signal.aborted) child.kill("SIGTERM");
  else signal.addEventListener("abort", onAbort, { once: true });

  // Drain-and-discard both streams so pipes never block; content is never inspected/logged.
  const drained = Promise.allSettled([drain(child.stdout), drain(child.stderr)]);
  try {
    const code = await child.exited;
    await drained;
    if (signal.aborted) {
      throw new SourceFailure("ACQUIRE_TIMEOUT", undefined, { sourceId: src.id, failureKind });
    }
    if (code !== 0) {
      throw new SourceFailure("SOURCE_UNAVAILABLE", undefined, { sourceId: src.id, failureKind });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Consume an async byte stream to EOF, discarding every chunk (never logged). */
async function drain(stream: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    // discard: output may contain a tokenized URL — never inspected or logged.
  }
}

/**
 * Resolve the checked-out commit so `SourceManifest.ref` reflects exactly what is served.
 * Best-effort: a failure here does NOT fail acquisition (the tree is already cloned) — it
 * just leaves `ref` undefined.
 */
async function resolveCommit(
  git: GitSpawner,
  genDir: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let child: SpawnedGit;
  try {
    child = git.spawn(["git", "-C", genDir, "rev-parse", "HEAD"], { cwd: genDir });
  } catch {
    return undefined;
  }
  if (signal.aborted) child.kill("SIGTERM");
  try {
    let out = "";
    const decoder = new TextDecoder();
    const collect = (async () => {
      for await (const chunk of child.stdout) out += decoder.decode(chunk, { stream: true });
    })();
    const drainErr = drain(child.stderr);
    const code = await child.exited;
    await Promise.allSettled([collect, drainErr]);
    if (code !== 0) return undefined;
    const line = out.split("\n", 1)[0]?.trim();
    return line !== undefined && line !== "" ? line : undefined;
  } catch {
    return undefined;
  }
}

// --- Atomic publish ---------------------------------------

/** The per-source cache directory. `id` is a config-declared source id (no traversal risk). */
function sourceCacheDir(cacheDir: string, sourceId: string): string {
  return join(cacheDir, sourceId);
}

/** The stable path readers resolve through — a symlink to the live generation. */
function currentLink(sourceDir: string): string {
  return join(sourceDir, "current");
}

/** Realpath of the live `current` generation, or undefined when no `current` exists yet. */
async function currentTarget(sourceDir: string): Promise<string | undefined> {
  try {
    return await realpath(currentLink(sourceDir));
  } catch {
    return undefined;
  }
}

/**
 * Atomically publish `incoming` as the new `current`. Creates a temporary
 * symlink to the new generation, then renames it onto `current` — an atomic replace of the
 * symlink within the one filesystem. Returns the realpath of the newly-published generation.
 */
async function publish(
  sourceDir: string,
  incoming: string,
  signal: AbortSignal,
  src: Source,
): Promise<string> {
  if (signal.aborted) {
    throw new SourceFailure("ACQUIRE_TIMEOUT", undefined, {
      sourceId: src.id,
      failureKind: "publish",
    });
  }
  const link = currentLink(sourceDir);
  const tmpLink = `${link}.tmp-${randomToken()}`;
  await symlink(incoming, tmpLink); // create the new symlink out of the reader's path
  await rename(tmpLink, link); // ATOMIC replace of the `current` symlink
  return realpath(link); // resolve to the just-published generation dir
}

// --- Bounded cache & pruning -------------------------------------------

/**
 * Keep the per-source cache bounded to the published generation plus, transiently, one
 * in-flight clone. Removes every `gen-*` directory except `keep` (a generation's realpath) —
 * clearing crash-leftover generations before a clone and the superseded generation after a
 * swap. Never removes `current`/`current.tmp-*` or an unrelated file.
 */
async function pruneGenerations(sourceDir: string, keep: string | undefined): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch {
    return;
  }
  const live = keep ? await realpath(keep).catch(() => keep) : undefined;
  for (const name of entries) {
    if (!name.startsWith("gen-")) continue; // never touch `current`/`current.tmp-*`
    const full = join(sourceDir, name);
    const resolved = await realpath(full).catch(() => full);
    if (live !== undefined && resolved === live) continue; // keep the published generation
    await removeDir(full);
  }
}

/**
 * Prune every source cache directory whose name is not a currently-declared source id, so a
 * removed source releases its cache. Used by the boot-time runtime reconciliation.
 * Only ever removes children of `cacheDir`.
 */
export async function pruneOrphanSources(
  cacheDir: string,
  declaredIds: Iterable<string>,
): Promise<void> {
  const keep = new Set(declaredIds);
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    await removeDir(join(cacheDir, name));
  }
}

/** `rm -rf` one directory (Node fs). Best-effort; a leftover is not fatal. */
async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

// --- Error handling & observability ---------------------

/**
 * Coerce any throwable into a SourceFailure carrying the source id + failure kind. A generic
 * normalizer result that landed on INTERNAL (e.g. a bare fs error during clone) is forced to
 * SOURCE_UNAVAILABLE — an acquisition failure is always an availability problem, never a
 * confinement one.
 */
function asSourceFailure(error: unknown, src: Source, failureKind: string): SourceFailure {
  if (error instanceof SourceFailure) return error;
  return forceUnavailable(normalizeSourceFailure(error, { sourceId: src.id, failureKind }));
}

/** Reclassify an INTERNAL failure as SOURCE_UNAVAILABLE, preserving id + kind + cause. */
function forceUnavailable(failure: SourceFailure): SourceFailure {
  if (failure.code !== "INTERNAL") return failure;
  return new SourceFailure("SOURCE_UNAVAILABLE", undefined, failure.details, {
    cause: (failure as { cause?: unknown }).cause,
  });
}

/** Log { sourceId, failureKind } (never the credential/URL/path) and return the failure. */
function logAndRethrow(src: Source, failure: SourceFailure): SourceFailure {
  logAcquireFailure({
    sourceId: src.id,
    failureKind: failure.details.failureKind ?? "acquire",
    code: failure.code,
  });
  return failure;
}

/** Short unguessable token for generation-dir names and the temp publish symlink. */
function randomToken(): string {
  return randomUUID();
}

// --- Production GitSpawner (Bun-backed) ------------------------------------------------

/**
 * Minimal `Bun.spawn` typing, declared ambiently so this module type-checks under Node
 * (vitest) without @types/bun and without importing anything Bun-only at module scope.
 * Mirrors the `declare const Bun` pattern in `modules/actions/server/spawn.ts` / `server/boot.ts`.
 */
declare const Bun: {
  spawn(options: {
    cmd: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: "ignore";
    stdout?: "pipe";
    stderr?: "pipe";
  }): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
  };
};

/**
 * The production `GitSpawner`. Spawns the system `git` binary with an explicit argv array
 * (argv[0] === "git", never a shell string), a working directory, and an in-memory env. The
 * credential (when `Source.credentialEnv` is set) is injected as an ephemeral `http.extraheader`
 * via `GIT_CONFIG_*` env for this spawn only (see `gitAuthEnv`) — never in the clone URL or argv,
 * so it is never persisted to the clone's `.git/config` or reflog. Following the
 * `lazyServeStatic` / `createBunRunnerSpawner` discipline, the `Bun` global is referenced
 * ONLY inside `spawn()`, so importing this file under Node/vitest never touches Bun.
 *
 * `Bun.spawn` throws synchronously when `git` cannot be started (ENOENT); that throw
 * propagates to `runGit`, which maps it to `SOURCE_UNAVAILABLE`. `stdin` is ignored so a
 * credential prompt can never block acquisition (paired with `GIT_TERMINAL_PROMPT=0`).
 */
export function createBunGitSpawner(): GitSpawner {
  return {
    spawn(argv: readonly string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): SpawnedGit {
      const proc = Bun.spawn({
        cmd: [...argv],
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.env !== undefined ? { env: opts.env } : {}),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        stdout: readableToIterable(proc.stdout),
        stderr: readableToIterable(proc.stderr),
        exited: proc.exited,
        kill: (signal?: NodeJS.Signals) => proc.kill(signal),
      };
    },
  };
}

/**
 * Adapt a `ReadableStream<Uint8Array>` to an `AsyncIterable<Uint8Array>` so `SpawnedGit`'s
 * contract holds regardless of whether the underlying stream is natively async-iterable.
 * `runGit` drains both streams and discards every chunk (never logged).
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

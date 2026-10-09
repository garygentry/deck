/**
 * One long-lived `codex app-server` child speaking newline-delimited JSON-RPC over stdio.
 * Keeping it alive avoids process startup on every poll, and it is the only way to
 * receive the `account/rateLimits/updated` push.
 *
 * The child is spawned through an injected {@link AppServerSpawner} (tests inject a fake;
 * production is Bun-backed) with an explicit argv and an allowlisted env carrying
 * `CODEX_HOME`, so none of deck's own secrets reach it. When the child exits, pending
 * calls reject and the next {@link AppServer.call} starts a fresh one; the collector's
 * poll cadence bounds how often that can happen.
 */

export const REQUEST_TIMEOUT_MS = 15_000;
/** JSON-RPC error codex returns for `account/*` reads without auth. */
export const AUTH_REQUIRED_CODE = -32600;

export interface SpawnedAppServer {
  /** Write one already-framed line to the child's stdin. */
  write(line: string): void;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  /** Resolves with the exit code. */
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface AppServerSpawner {
  /** @throws when the executable cannot be started. */
  spawn(argv: readonly string[], opts: { env: NodeJS.ProcessEnv }): SpawnedAppServer;
}

export class AppServerRpcError extends Error {
  constructor(readonly method: string, readonly code: number | null, message: string) {
    super(`${method}: ${message}`);
    this.name = "AppServerRpcError";
  }
}

/** The codex executable could not be started (usually: not mounted, or the wrong path). */
export class AppServerSpawnError extends Error {
  constructor(readonly command: string, cause: unknown) {
    super(`cannot start ${command}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AppServerSpawnError";
  }
}

/**
 * True when codex rejected a read because the account is not signed in. Codex uses
 * -32600 for every invalid request (e.g. an unknown method on an older binary), so the
 * message must say so too.
 */
export const isAuthRequired = (error: unknown): boolean =>
  error instanceof AppServerRpcError
  && error.code === AUTH_REQUIRED_CODE
  && /authentication required/i.test(error.message);

/** Env vars the child may inherit; everything else (including deck's secrets) is withheld. */
const INHERITED_ENV = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
] as const;

export function appServerEnv(codexHome: string, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) {
    if (from[name] !== undefined) env[name] = from[name];
  }
  env.CODEX_HOME = codexHome;
  return env;
}

export interface AppServerOptions {
  command: string;
  codexHome: string;
  spawner: AppServerSpawner;
  /** Server-initiated notifications, e.g. `account/rateLimits/updated`. */
  onNotify?: (method: string, params: unknown) => void;
  clientVersion?: string;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class AppServer {
  private proc: SpawnedAppServer | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  /** Why the last child went away, for diagnostics. */
  lastError: string | null = null;

  constructor(private readonly opts: AppServerOptions) {}

  get running(): boolean {
    return this.proc !== null;
  }

  /** Start the child and complete the `initialize` handshake. Idempotent while running. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("app-server closed"));
    if (this.ready) return this.ready;

    let proc: SpawnedAppServer;
    try {
      proc = this.opts.spawner.spawn([this.opts.command, "app-server"], {
        env: this.opts.env ?? appServerEnv(this.opts.codexHome),
      });
    } catch (error) {
      const failure = new AppServerSpawnError(this.opts.command, error);
      this.lastError = failure.message;
      return Promise.reject(failure);
    }
    this.proc = proc;
    void drain(proc.stderr); // app-server chatters on stderr; never surfaced
    void this.readLines(proc);
    void proc.exited.then((code) => this.onExit(proc, `app-server exited (${code})`));

    const ready = this.request("initialize", {
      clientInfo: { name: "deck", version: this.opts.clientVersion ?? "0" },
    }).then(() => {
      this.send({ method: "initialized" });
      this.lastError = null;
    });
    // A failed handshake must not pin a dead promise; the next call retries.
    ready.catch(() => {
      if (this.ready === ready) this.stop(proc);
    });
    this.ready = ready;
    return ready;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    await this.start();
    return this.request(method, params);
  }

  /** Kill the child and refuse further calls. */
  close(): void {
    this.closed = true;
    if (this.proc) this.stop(this.proc);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error("app-server not running"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  private send(message: JsonRecord): void {
    try {
      this.proc?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    } catch {
      // Broken pipe: the child is exiting; onExit rejects whatever is pending.
    }
  }

  private async readLines(proc: SpawnedAppServer): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const chunk of proc.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          this.dispatch(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
        }
      }
    } catch {
      // Stream torn down with the child; onExit reports it.
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === "number" && this.pending.has(message.id) && !("method" in message)) {
      const call = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (isRecord(message.error)) {
        const code = typeof message.error.code === "number" ? message.error.code : null;
        const text = typeof message.error.message === "string" ? message.error.message : "request failed";
        call.reject(new AppServerRpcError(call.method, code, text));
      } else {
        call.resolve(message.result);
      }
    } else if (typeof message.method === "string" && message.id === undefined) {
      this.opts.onNotify?.(message.method, message.params);
    }
  }

  private onExit(proc: SpawnedAppServer, reason: string): void {
    if (this.proc !== proc) return;
    this.lastError = reason;
    this.reset(reason);
  }

  private stop(proc: SpawnedAppServer): void {
    if (this.proc === proc) this.reset("app-server stopped");
    proc.kill();
  }

  private reset(reason: string): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(`${call.method}: ${reason}`));
    }
    this.pending.clear();
    this.proc = null;
    this.ready = null;
  }
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const _ of stream) {
      // discard
    }
  } catch {
    // ignore
  }
}

/**
 * Minimal `Bun.spawn` typing, declared ambiently so this module type-checks under Node
 * (vitest) without @types/bun. `Bun` is referenced only inside `spawn()`.
 */
declare const Bun: {
  spawn(options: {
    cmd: string[];
    env?: NodeJS.ProcessEnv;
    stdin: "pipe";
    stdout: "pipe";
    stderr: "pipe";
  }): {
    stdin: { write(data: string): number; flush(): void };
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
  };
};

export function createBunAppServerSpawner(): AppServerSpawner {
  return {
    spawn(argv, opts) {
      const proc = Bun.spawn({ cmd: [...argv], env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      return {
        write(line) {
          proc.stdin.write(line);
          proc.stdin.flush();
        },
        stdout: readableToIterable(proc.stdout),
        stderr: readableToIterable(proc.stderr),
        exited: proc.exited,
        kill: (signal) => proc.kill(signal),
      };
    },
  };
}

async function* readableToIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
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

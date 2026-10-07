import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { fetchOauthUsage, OAUTH_BETA, OAUTH_USAGE_URL, retryAfterMs, type OauthDeps } from "../src/llm-usage/claude/oauth.js";
import { createTranscriptScanner, scanTranscripts, totalsFromEntries, TranscriptIndex } from "../src/llm-usage/claude/transcripts.js";
import {
  AppServer,
  AppServerRpcError,
  appServerEnv,
  AUTH_REQUIRED_CODE,
  isAuthRequired,
  type AppServerSpawner,
  type SpawnedAppServer,
} from "../src/llm-usage/codex/app-server.js";
import { findNewestRollout, readNewestRollout, RolloutWatcher } from "../src/llm-usage/codex/rollout.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const TOKEN = "sk-ant-oat01-SECRET";

describe("fetchOauthUsage", () => {
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, subscriptionType: "max", expiresAt: NOW - 1 } });

  function deps(response: Response | Error, file: string | Error = creds): OauthDeps & { fetch: Mock<Parameters<typeof fetch>, Promise<Response>> } {
    return {
      readFile: vi.fn(async () => {
        if (file instanceof Error) throw file;
        return file;
      }),
      fetch: vi.fn<Parameters<typeof fetch>, Promise<Response>>(async () => {
        if (response instanceof Error) throw response;
        return response;
      }),
      now: () => NOW,
    };
  }

  it("sends the bearer token and beta header, and returns the body and plan", async () => {
    const d = deps(new Response(JSON.stringify({ limits: [] }), { status: 200 }));
    const result = await fetchOauthUsage("/creds.json", d);
    expect(result).toEqual({ ok: true, body: { limits: [] }, plan: "max" });
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe(OAUTH_USAGE_URL);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "anthropic-beta": OAUTH_BETA });
  });

  it("re-reads the credentials file on every call", async () => {
    const d = deps(new Response("{}", { status: 200 }));
    await fetchOauthUsage("/creds.json", d);
    d.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await fetchOauthUsage("/creds.json", d);
    expect(d.readFile).toHaveBeenCalledTimes(2);
  });

  it("maps a missing file or token to not-configured without calling out", async () => {
    const missing = Object.assign(new Error("nope"), { code: "ENOENT" });
    const noFile = deps(new Response("{}"), missing);
    expect(await fetchOauthUsage("/creds.json", noFile)).toMatchObject({ ok: false, kind: "not-configured", detail: expect.stringContaining("ENOENT") });
    expect(noFile.fetch).not.toHaveBeenCalled();

    const noToken = deps(new Response("{}"), JSON.stringify({ claudeAiOauth: {} }));
    expect(await fetchOauthUsage("/creds.json", noToken)).toMatchObject({ ok: false, kind: "not-configured" });
    expect(await fetchOauthUsage("/creds.json", deps(new Response("{}"), "not json"))).toMatchObject({ kind: "not-configured" });
  });

  it("trusts only a positive Retry-After and never echoes the token", async () => {
    const limited = await fetchOauthUsage("/c", deps(new Response(`bad ${TOKEN}`, { status: 429, headers: { "retry-after": "272" } })));
    expect(limited).toEqual({ ok: false, kind: "error", detail: "HTTP 429", retryAfterMs: 272_000 });

    const zero = await fetchOauthUsage("/c", deps(new Response("", { status: 429, headers: { "retry-after": "0" } })));
    expect(zero).toMatchObject({ retryAfterMs: 0 });

    const expired = await fetchOauthUsage("/c", deps(new Response("", { status: 401 })));
    expect(expired).toMatchObject({ kind: "error", detail: expect.stringContaining("token expired") });
    expect(JSON.stringify([limited, zero, expired])).not.toContain(TOKEN);
  });

  it("maps transport failures and non-JSON bodies to error", async () => {
    expect(await fetchOauthUsage("/c", deps(new TypeError("fetch failed")))).toMatchObject({ ok: false, kind: "error", detail: "request failed: TypeError" });
    expect(await fetchOauthUsage("/c", deps(new Response("<html>", { status: 200 })))).toMatchObject({ kind: "error", detail: "response was not JSON" });
  });

  it("parses Retry-After tolerantly", () => {
    expect(retryAfterMs(null)).toBe(0);
    expect(retryAfterMs("")).toBe(0);
    expect(retryAfterMs("-5")).toBe(0);
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(0);
    expect(retryAfterMs("1.5")).toBe(1500);
  });
});

/** A scripted fake `codex app-server`: answers requests via `respond`, can push and exit. */
class FakeChild implements SpawnedAppServer {
  readonly written: Record<string, unknown>[] = [];
  private queue: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private exit!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => {
    this.exit = resolve;
  });
  killed = false;

  constructor(private readonly respond: (msg: Record<string, unknown>) => unknown) {}

  write(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.written.push(msg);
    if (typeof msg.id === "number") {
      const reply = this.respond(msg);
      if (reply !== undefined) this.emit({ jsonrpc: "2.0", id: msg.id, ...(reply as object) });
    }
  }

  emit(message: unknown, raw?: string): void {
    this.queue.push(new TextEncoder().encode(raw ?? `${JSON.stringify(message)}\n`));
    this.wake?.();
  }

  close(code = 0): void {
    this.done = true;
    this.wake?.();
    this.exit(code);
  }

  kill(): void {
    this.killed = true;
    this.close(143);
  }

  readonly stdout: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: async function* (this: FakeChild) {
      for (;;) {
        while (this.queue.length) yield this.queue.shift()!;
        if (this.done) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    }.bind(this),
  };

  readonly stderr: AsyncIterable<Uint8Array> = (async function* () {})();
}

const results: Record<string, unknown> = {
  initialize: { userAgent: "codex" },
  "account/rateLimits/read": { rateLimits: { limitId: "codex" } },
};

function fakeSpawner(respond: (msg: Record<string, unknown>) => unknown = (msg) => ({ result: results[msg.method as string] ?? null })) {
  const children: FakeChild[] = [];
  const spawner: AppServerSpawner & { calls: { argv: readonly string[]; env: NodeJS.ProcessEnv }[] } = {
    calls: [],
    spawn(argv, opts) {
      spawner.calls.push({ argv, env: opts.env });
      const child = new FakeChild(respond);
      children.push(child);
      return child;
    },
  };
  return { spawner, children };
}

describe("AppServer", () => {
  it("handshakes once, then serves calls over the same child", async () => {
    const { spawner, children } = fakeSpawner();
    const server = new AppServer({ command: "codex", codexHome: "/data/codex", spawner });
    await expect(server.call("account/rateLimits/read")).resolves.toEqual({ rateLimits: { limitId: "codex" } });
    await server.call("account/rateLimits/read");
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]!.argv).toEqual(["codex", "app-server"]);
    expect(children[0]!.written.map((m) => m.method)).toEqual([
      "initialize", "initialized", "account/rateLimits/read", "account/rateLimits/read",
    ]);
    expect(children[0]!.written[1]).not.toHaveProperty("id");
    server.close();
  });

  it("surfaces JSON-RPC errors, flagging sign-in needed", async () => {
    const { spawner } = fakeSpawner((msg) => msg.method === "initialize"
      ? { result: {} }
      : { error: { code: AUTH_REQUIRED_CODE, message: "codex account authentication required to read rate limits" } });
    const server = new AppServer({ command: "codex", codexHome: "/h", spawner });
    const error = await server.call("account/rateLimits/read").catch((e: unknown) => e);
    expect(isAuthRequired(error)).toBe(true);
    expect(isAuthRequired(new Error("x"))).toBe(false);
    // Codex also uses -32600 for an unknown method; that is not a sign-in problem.
    expect(isAuthRequired(new AppServerRpcError("account/bogus/read", AUTH_REQUIRED_CODE, "Invalid request: unknown variant"))).toBe(false);
    server.close();
  });

  it("forwards notifications and ignores junk lines", async () => {
    const onNotify = vi.fn();
    const { spawner, children } = fakeSpawner();
    const server = new AppServer({ command: "codex", codexHome: "/h", spawner, onNotify });
    await server.start();
    children[0]!.emit(null, "not json\n");
    children[0]!.emit(null, '{"jsonrpc":"2.0","method":"account/rateLimits/updated",');
    children[0]!.emit(null, '"params":{"rateLimits":{}}}\n');
    await vi.waitFor(() => expect(onNotify).toHaveBeenCalledWith("account/rateLimits/updated", { rateLimits: {} }));
    server.close();
  });

  it("rejects pending calls when the child exits and respawns on the next call", async () => {
    const { spawner, children } = fakeSpawner((msg) => (msg.method === "slow" ? undefined : { result: results[msg.method as string] ?? null }));
    const server = new AppServer({ command: "codex", codexHome: "/h", spawner });
    const pending = server.call("slow");
    await vi.waitFor(() => expect(children[0]!.written.some((m) => m.method === "slow")).toBe(true));
    children[0]!.close(1);
    await expect(pending).rejects.toThrow("app-server exited (1)");
    expect(server.lastError).toBe("app-server exited (1)");
    expect(server.running).toBe(false);

    await expect(server.call("account/rateLimits/read")).resolves.toBeTruthy();
    expect(spawner.calls).toHaveLength(2);
    expect(server.lastError).toBeNull();
    server.close();
    expect(children[1]!.killed).toBe(true);
    await expect(server.call("account/rateLimits/read")).rejects.toThrow("closed");
  });

  it("times out an unanswered request", async () => {
    const { spawner } = fakeSpawner((msg) => (msg.method === "initialize" ? { result: {} } : undefined));
    const server = new AppServer({ command: "codex", codexHome: "/h", spawner, requestTimeoutMs: 20 });
    await expect(server.call("account/usage/read")).rejects.toThrow("account/usage/read timed out");
    server.close();
  });

  it("reports a spawn failure and retries on the next call", async () => {
    const spawner: AppServerSpawner = {
      spawn: vi.fn(() => {
        throw new Error("ENOENT");
      }),
    };
    const server = new AppServer({ command: "codex", codexHome: "/h", spawner });
    await expect(server.call("x")).rejects.toThrow("cannot start codex: ENOENT");
    await expect(server.call("x")).rejects.toThrow();
    expect(spawner.spawn).toHaveBeenCalledTimes(2);
  });

  it("passes CODEX_HOME and withholds everything outside the env allowlist", () => {
    const env = appServerEnv("/data/codex", { PATH: "/bin", HOME: "/root", DECK_LLM_USAGE_INGEST_TOKEN: "t", GITHUB_TOKEN: "g" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/root", CODEX_HOME: "/data/codex" });
  });
});

describe("filesystem readers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "deck-llm-usage-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const at = (ms: number) => new Date(ms);
  async function put(path: string, body: string, mtimeMs: number): Promise<string> {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
    await utimes(full, at(mtimeMs), at(mtimeMs));
    return full;
  }
  const rolloutLine = (percent: number) => `${JSON.stringify({
    timestamp: "2026-09-24T11:59:00Z",
    type: "event_msg",
    payload: { type: "token_count", rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: 1788814634 } } },
  })}\n`;

  describe("rollout", () => {
    it("reads the newest rollout's last snapshot", async () => {
      await put("2026/09/23/rollout-a.jsonl", rolloutLine(10), NOW - 86_400_000);
      const newest = await put("2026/09/24/rollout-b.jsonl", `partial"}\n${rolloutLine(20)}${rolloutLine(30)}`, NOW - 1000);
      await put("2026/09/24/notes.jsonl", rolloutLine(99), NOW);

      expect((await findNewestRollout(dir))?.path).toBe(newest);
      const result = await readNewestRollout(dir);
      expect(result).toMatchObject({ status: "ok", file: { path: newest }, reading: { snapshot: { primary: { usedPercent: 30 } } } });
    });

    it("distinguishes no files, no snapshot yet and a missing dir", async () => {
      expect(await readNewestRollout(join(dir, "absent"))).toMatchObject({ status: "no-data-yet", detail: "no rollout files yet" });
      await put("rollout-x.jsonl", '{"type":"session_meta"}\n', NOW);
      expect(await readNewestRollout(dir)).toMatchObject({ status: "no-data-yet", detail: expect.stringContaining("no rate limits") });
    });

    it("watcher reports mtime movement and new files after a baseline", async () => {
      let clock = NOW;
      const onActivity = vi.fn();
      const watcher = new RolloutWatcher(dir, onActivity, () => clock);
      await watcher.tick();
      const first = await put("2026/09/24/rollout-a.jsonl", rolloutLine(1), NOW);
      clock += 61_000; // past the rescan interval, so the new file is discovered
      await watcher.tick();
      expect(onActivity).toHaveBeenLastCalledWith({ path: first, mtimeMs: NOW });

      await watcher.tick();
      expect(onActivity).toHaveBeenCalledTimes(1);
      await utimes(first, at(NOW + 5000), at(NOW + 5000));
      await watcher.tick();
      expect(onActivity).toHaveBeenCalledTimes(2);
    });
  });

  describe("transcripts", () => {
    const usageLine = (iso: string, output: number) => `${JSON.stringify({
      timestamp: iso,
      message: { model: "claude-opus", usage: { input_tokens: 1, output_tokens: output } },
    })}\n`;

    it("scans recent files, including nested subagent transcripts", async () => {
      await put("proj/s1.jsonl", usageLine("2026-09-24T11:00:00Z", 10) + usageLine("2026-09-20T11:00:00Z", 5), NOW);
      await put("proj/s1/subagents/a.jsonl", usageLine("2026-09-24T11:30:00Z", 7), NOW);
      await put("proj/old.jsonl", usageLine("2026-09-24T11:00:00Z", 1000), NOW - 8 * 86_400_000);

      const scan = await scanTranscripts(dir, NOW);
      expect(scan.ok).toBe(true);
      if (!scan.ok) return;
      expect(scan.totals.files).toBe(2);
      expect(scan.totals.window5h.output).toBe(17);
      expect(scan.totals.window7d.output).toBe(22);
      expect(scan.totals.byModel["claude-opus"]?.messages).toBe(3);
    });

    const block = (id: string, output: number, iso = "2026-09-24T11:00:00Z", extra: object = {}) => `${JSON.stringify({
      timestamp: iso,
      requestId: `req_${id}`,
      message: { id, model: "claude-opus", usage: { input_tokens: 1, output_tokens: output } },
      ...extra,
    })}\n`;

    it("counts a response once, though Claude Code logs a line per content block", async () => {
      // Two content blocks of one response, one other response, and the same response
      // copied into a resumed session's file.
      await put("p/a.jsonl", block("msg_1", 5) + block("msg_1", 5) + block("msg_2", 7), NOW);
      await put("p/b.jsonl", block("msg_1", 5), NOW);
      const scan = await scanTranscripts(dir, NOW);
      expect(scan.ok && scan.totals.window7d).toMatchObject({ output: 12, messages: 2 });
    });

    it("keeps the largest copy of a response whatever the file order", async () => {
      const partial = { key: "msg_1:req_1", at: NOW - 60_000, model: "m", input: 1, output: 3, cacheRead: 0, cacheCreate: 0 };
      const final = { ...partial, output: 40 };
      expect(totalsFromEntries([final, partial], 1, NOW).window7d).toMatchObject({ output: 40, messages: 1 });
      expect(totalsFromEntries([partial, final], 1, NOW).window7d).toMatchObject({ output: 40, messages: 1 });
    });

    it("skips usage mentioned inside content without parsing it", async () => {
      const toolResult = `${JSON.stringify({ timestamp: "2026-09-24T11:00:00Z", message: { content: '{"usage":{"output_tokens":999}}' } })}\n`;
      await put("p/a.jsonl", toolResult + block("msg_1", 3), NOW);
      const scan = await scanTranscripts(dir, NOW);
      expect(scan.ok && scan.totals.window7d.output).toBe(3);
    });

    it("reads only appended bytes, and waits for a line still being written", async () => {
      const index = new TranscriptIndex(dir);
      const file = await put("p/a.jsonl", block("msg_1", 1), NOW);
      expect((await index.update(NOW)).ok).toBe(true);

      const next = block("msg_2", 2);
      await appendFile(file, next.slice(0, 20)); // a half-written line
      let scan = await index.update(NOW);
      expect(scan.ok && scan.totals.window7d).toMatchObject({ output: 1, messages: 1 });

      await appendFile(file, next.slice(20));
      scan = await index.update(NOW);
      expect(scan.ok && scan.totals.window7d).toMatchObject({ output: 3, messages: 2 });
      scan = await index.update(NOW); // nothing new: no double count
      expect(scan.ok && scan.totals.window7d.output).toBe(3);
    });

    it("re-reads a replaced or truncated file and forgets deleted ones", async () => {
      const index = new TranscriptIndex(dir);
      await put("p/a.jsonl", block("msg_1", 10) + block("msg_2", 10), NOW);
      await put("p/b.jsonl", block("msg_3", 100), NOW);
      expect((await index.update(NOW)).ok && (await index.update(NOW))).toMatchObject({ totals: { window7d: { output: 120 } } });

      await put("p/a.jsonl", block("msg_4", 4), NOW); // rewritten shorter
      await rm(join(dir, "p/b.jsonl"));
      const scan = await index.update(NOW);
      expect(scan.ok && scan.totals).toMatchObject({ files: 1, window7d: { output: 4, messages: 1 } });
    });

    it("handles a line longer than one read chunk", async () => {
      const long = block("msg_1", 8, "2026-09-24T11:00:00Z", { padding: "x".repeat(700_000) });
      await put("p/a.jsonl", block("msg_0", 1) + long + block("msg_2", 2), NOW);
      const scan = await new TranscriptIndex(dir).update(NOW);
      expect(scan.ok && scan.totals.window7d).toMatchObject({ output: 11, messages: 3 });
    });

    it("measures freshness from when a slow pass finished, not when it started", async () => {
      await put("p/a.jsonl", block("msg_1", 1), NOW);
      // Scripted clock: the pass starts at +0 and finishes at +170s (a very large history);
      // the next read comes at +200s, 30s after completion but 200s after the start.
      const times = [NOW, NOW + 170_000, NOW + 200_000];
      const scanner = createTranscriptScanner(dir, () => times.shift() ?? NOW + 200_000);
      const first = await scanner.refresh();
      expect(await scanner.refresh()).toBe(first);
    });

    it("reports an unreadable dir", async () => {
      expect(await scanTranscripts(join(dir, "absent"), NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("ENOENT") });
    });

    it("serves the cached scan without waiting and rescans in the background", async () => {
      let clock = NOW;
      await put("p/a.jsonl", usageLine("2026-09-24T11:00:00Z", 1), NOW);
      const scanner = createTranscriptScanner(dir, () => clock);
      expect(scanner.latest()).toBeNull(); // starts the first scan
      const [a, b] = await Promise.all([scanner.refresh(), scanner.refresh()]);
      expect(a).toBe(b);
      expect(scanner.latest()).toBe(a);

      await put("p/b.jsonl", usageLine("2026-09-24T11:00:00Z", 1), NOW);
      clock += 60_000;
      expect(scanner.latest()).toBe(a); // stale, returned immediately
      const fresh = await scanner.refresh(); // joins the background rescan
      expect(fresh).not.toBe(a);
      expect(fresh.ok && fresh.totals.files).toBe(2);
      expect(scanner.latest()).toBe(fresh);
    });
  });
});

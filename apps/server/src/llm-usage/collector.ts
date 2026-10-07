import { barsFromOauth, readStatusline, statuslinePlan, type StatuslineVerdict } from "./claude/bars.js";
import { mergeClaudeBars, STATUSLINE_FRESH_MS } from "./claude/merge.js";
import { fetchOauthUsage, type OauthResult } from "./claude/oauth.js";
import { createTranscriptScanner, type TranscriptScanner } from "./claude/transcripts.js";
import { FORCE_FLOOR_MS, MAX_TIMER_MS, OAUTH_FLOOR_MS, nextDelay, pollMode, type CadenceState } from "./cadence.js";
import { AppServer, AppServerSpawnError, createBunAppServerSpawner, isAuthRequired } from "./codex/app-server.js";
import { barsFromSnapshotMap, codexPlan, historyFromUsage } from "./codex/bars.js";
import { readNewestRollout, RolloutWatcher, type RolloutResult } from "./codex/rollout.js";
import { DEFAULT_THRESHOLDS, type ResolvedLlmUsageConfig } from "./config.js";
import { finalizeBars } from "./severity.js";
import type {
  ClaudeUsage,
  CodexUsage,
  LlmUsageHealth,
  LlmUsageResponse,
  UsageBar,
  UsageSourceStatus,
} from "./types.js";

/**
 * The LLM usage collector. Deliberately not a registry provider: the registry polls on a
 * fixed interval with no consumer pause, while this needs the adaptive cadence in
 * `cadence.ts` (active/idle/backoff), presence gating and the OAuth floor.
 *
 * One self-scheduling loop polls the upstream sources (Claude OAuth, Codex app-server).
 * The next poll is always `lastPollAt + nextDelay(...)`, so re-arming on a push, a Codex
 * turn or a returning viewer can bring a poll forward but never below the floor. With no
 * viewer inside `idlePauseMs` the loop and the rollout watcher stop; the next read wakes
 * them. Local sources (rollout tail, transcripts) are read on demand when a viewer asks.
 */

/** Codex history moves slowly; refetch at most this often. */
export const HISTORY_TTL_MS = 300_000;

/** The slice of {@link AppServer} the collector uses; tests inject a fake. */
export interface AppServerClient {
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

export interface CollectorDeps {
  now?: () => number;
  fetchOauth?: (credentialsFile: string) => Promise<OauthResult>;
  /** Build the Codex client; `onNotify` receives server notifications. */
  createAppServer?: (onNotify: (method: string) => void) => AppServerClient;
  readRollout?: (dir: string) => Promise<RolloutResult>;
  transcripts?: TranscriptScanner;
  /** Build the rollout activity watcher. */
  createWatcher?: (onActivity: () => void) => { start(): void; stop(): void };
}

interface Fetched<T> {
  value: T | null;
  observedAt: number | null;
  /** Last failure, cleared on success. `notConfigured` marks a sign-in/credential gap. */
  error: { detail: string; notConfigured: boolean } | null;
}

const empty = <T>(): Fetched<T> => ({ value: null, observedAt: null, error: null });

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A Codex call failure as a source error. A missing binary and a signed-out account are
 * setup gaps (`not-configured`), each with the fix; anything else is a real error.
 */
function codexFailure(error: unknown): { detail: string; notConfigured: boolean } {
  if (error instanceof AppServerSpawnError) {
    return {
      detail: `codex not found at "${error.command}": mount the host's codex binary and set llmUsage.codex.command`,
      notConfigured: true,
    };
  }
  if (isAuthRequired(error)) return { detail: "sign-in needed (run codex login)", notConfigured: true };
  return { detail: errorText(error), notConfigured: false };
}

/**
 * Map a fetched value to a source status. Any failure after a success keeps the last good
 * value on screen, so it reads `stale` (with the reason), even a lost credential.
 */
function statusOf<T>(id: UsageSourceStatus["id"], fetched: Fetched<T>): UsageSourceStatus {
  const { value, observedAt, error } = fetched;
  if (error?.notConfigured && value === null) return { id, state: "not-configured", observedAt, detail: error.detail };
  if (error) return { id, state: value === null ? "error" : "stale", observedAt, detail: error.detail };
  if (value === null) return { id, state: "no-data-yet", observedAt, detail: null };
  return { id, state: "available", observedAt, detail: null };
}

const notConfigured = (id: UsageSourceStatus["id"], detail: string): UsageSourceStatus =>
  ({ id, state: "not-configured", observedAt: null, detail });

export class LlmUsageCollector {
  private readonly now: () => number;
  private readonly fetchOauth: (file: string) => Promise<OauthResult>;
  private readonly readRollout: (dir: string) => Promise<RolloutResult>;
  private readonly transcripts: TranscriptScanner | null;
  private readonly appServer: AppServerClient | null;
  private readonly watcher: { start(): void; stop(): void } | null;

  private statusline: { payload: unknown; verdict: StatuslineVerdict; at: number } | null = null;
  private oauth: Fetched<{ body: unknown; plan: string | null }> = empty();
  private codexLimits: Fetched<unknown> = empty();
  private codexHistory: Fetched<unknown> = empty();

  private lastPollAt: number | null = null;
  private lastOauthAttemptAt: number | null = null;
  private lastForcedAt: number | null = null;
  private lastViewerAt: number | null = null;
  private lastChangeAt: number | null = null;
  private consecutiveErrors = 0;
  private retryAfterMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextPollAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly config: ResolvedLlmUsageConfig, deps: CollectorDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.fetchOauth = deps.fetchOauth ?? ((file) => fetchOauthUsage(file));
    this.readRollout = deps.readRollout ?? readNewestRollout;
    const transcriptsDir = config.claude?.transcriptsDir ?? null;
    this.transcripts = transcriptsDir === null
      ? null
      : deps.transcripts ?? createTranscriptScanner(transcriptsDir, this.now);

    const codex = config.codex;
    const onNotify = (method: string) => {
      if (method === "account/rateLimits/updated") void this.onCodexPush();
    };
    this.appServer = codex === null
      ? null
      : deps.createAppServer?.(onNotify) ?? new AppServer({
        command: codex.command,
        codexHome: codex.codexHome,
        spawner: createBunAppServerSpawner(),
        onNotify,
      });
    const onActivity = () => {
      this.lastChangeAt = this.now();
      this.schedule();
    };
    this.watcher = codex === null
      ? null
      : deps.createWatcher?.(onActivity) ?? new RolloutWatcher(codex.rolloutDir, onActivity, this.now);
  }

  /** `GET /api/llm-usage`: marks a viewer present (waking a paused loop) and builds the response. */
  async read(): Promise<LlmUsageResponse> {
    this.markViewer();
    return this.snapshot();
  }

  /** `GET /api/llm-usage/refresh`: an immediate poll, debounced by {@link FORCE_FLOOR_MS}. */
  async refresh(): Promise<LlmUsageResponse> {
    this.markViewer();
    const now = this.now();
    if (this.lastForcedAt === null || now - this.lastForcedAt >= FORCE_FLOOR_MS) {
      this.lastForcedAt = now;
      await this.poll(true);
      this.schedule();
    }
    return this.snapshot();
  }

  /** A statusLine push from the ingest route. Counts as activity, not as a viewer. */
  ingestStatusline(payload: unknown): void {
    const now = this.now();
    this.statusline = { payload, verdict: readStatusline(payload), at: now };
    this.schedule();
  }

  health(): LlmUsageHealth {
    return { mode: pollMode(this.cadence()), lastPollAt: this.lastPollAt, consecutiveErrors: this.consecutiveErrors };
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.watcher?.stop();
    this.appServer?.close();
  }

  private markViewer(): void {
    this.lastViewerAt = this.now();
    this.schedule();
  }

  private cadence(): CadenceState {
    return {
      now: this.now(),
      activeMs: this.config.claude?.activeMs ?? 0,
      idleMs: this.config.claude?.idleMs ?? 0,
      idlePauseMs: this.config.idlePauseMs,
      lastPushAt: this.statusline?.at ?? null,
      lastChangeAt: this.lastChangeAt,
      lastViewerAt: this.lastViewerAt,
      consecutiveErrors: this.consecutiveErrors,
      retryAfterMs: this.retryAfterMs,
    };
  }

  /** (Re)arm the poll timer from current state; stops everything while paused. */
  private schedule(): void {
    if (this.stopped) return;
    const delay = nextDelay(this.cadence());
    if (delay === null) {
      this.clearTimer();
      this.watcher?.stop();
      return;
    }
    this.watcher?.start();
    const now = this.now();
    const at = this.lastPollAt === null ? now : Math.max(now, this.lastPollAt + delay);
    if (this.timer !== null && this.nextPollAt === at) return;
    this.clearTimer();
    this.nextPollAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextPollAt = null;
      // The viewer may have left since this was armed; schedule() then stands down.
      if (pollMode(this.cadence()) === "paused") return this.schedule();
      void this.poll(false).finally(() => this.schedule());
    }, Math.min(at - now, MAX_TIMER_MS)); // a longer timeout would overflow and fire at once
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextPollAt = null;
  }

  /**
   * One upstream poll; concurrent callers share it. A `forced` poll (manual refresh) always
   * re-reads Codex, but calls OAuth only when not backing off and at least
   * {@link OAUTH_FLOOR_MS} after the last attempt; when it skips OAuth it leaves the
   * schedule and the backoff untouched.
   */
  private poll(forced: boolean): Promise<void> {
    this.inFlight ??= this.pollOnce(forced).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pollOnce(forced: boolean): Promise<void> {
    const started = this.now();
    const before = this.fingerprint();
    const first = this.lastPollAt === null;
    const backingOff = this.consecutiveErrors > 0 || this.retryAfterMs > 0;
    const oauthDue = !forced || (!backingOff
      && (this.lastOauthAttemptAt === null || started - this.lastOauthAttemptAt >= OAUTH_FLOOR_MS));
    let failed: boolean;
    try {
      const outcomes = await Promise.all([
        oauthDue ? this.pollOauth() : Promise.resolve(false),
        this.pollCodexLimits(),
        this.pollCodexHistory(),
      ]);
      failed = outcomes.some(Boolean);
    } catch {
      // Sources report failures as values; a throw is a bug, but it must neither stop the
      // loop nor re-arm it at once, so it counts as a failed poll and backs off.
      failed = true;
    }
    const finished = this.now();
    // Populating from nothing is not activity; only a value that moved is.
    if (!first && this.fingerprint() !== before) this.lastChangeAt = finished;
    if (!oauthDue) return;
    this.consecutiveErrors = failed ? this.consecutiveErrors + 1 : 0;
    this.lastPollAt = finished;
  }

  /** @returns true when the poll failed in a way that should back off. */
  private async pollOauth(): Promise<boolean> {
    const file = this.config.claude?.credentialsFile;
    if (!file) return false;
    this.lastOauthAttemptAt = this.now();
    const result = await this.fetchOauth(file);
    const now = this.now();
    if (result.ok) {
      this.oauth = { value: { body: result.body, plan: result.plan }, observedAt: now, error: null };
      this.retryAfterMs = 0;
      return false;
    }
    this.oauth = { ...this.oauth, error: { detail: result.detail, notConfigured: result.kind === "not-configured" } };
    this.retryAfterMs = result.retryAfterMs;
    return result.kind === "error";
  }

  private async pollCodexLimits(): Promise<boolean> {
    if (!this.appServer) return false;
    try {
      const value = await this.appServer.call("account/rateLimits/read");
      this.codexLimits = { value, observedAt: this.now(), error: null };
      return false;
    } catch (error) {
      this.codexLimits = { ...this.codexLimits, error: codexFailure(error) };
      return false; // A local child failing is not a reason to slow the OAuth cadence.
    }
  }

  private async pollCodexHistory(): Promise<boolean> {
    if (!this.appServer) return false;
    const { observedAt } = this.codexHistory;
    if (observedAt !== null && this.now() - observedAt < HISTORY_TTL_MS) return false;
    try {
      const value = await this.appServer.call("account/usage/read");
      this.codexHistory = { value, observedAt: this.now(), error: null };
    } catch (error) {
      this.codexHistory = { ...this.codexHistory, error: codexFailure(error) };
    }
    return false;
  }

  /** `account/rateLimits/updated` is sparse, so refetch the full snapshot (a local RPC). */
  private async onCodexPush(): Promise<void> {
    this.lastChangeAt = this.now();
    await this.pollCodexLimits();
    this.schedule();
  }

  /** Percent values across upstream sources, to detect a value that moved. */
  private fingerprint(): string {
    const oauth = barsFromOauth(this.oauth.value?.body).map((bar) => `${bar.key}=${bar.percent}`);
    const limits = isRecord(this.codexLimits.value) ? this.codexLimits.value : {};
    const codex = barsFromSnapshotMap(limits.rateLimitsByLimitId, limits.rateLimits)
      .map((bar) => `${bar.key}=${bar.percent}`);
    return [...oauth, ...codex].join(",");
  }

  private async snapshot(): Promise<LlmUsageResponse> {
    const cadence = this.cadence();
    const [claude, codex] = await Promise.all([this.claudeUsage(), this.codexUsage()]);
    return {
      enabled: true,
      now: cadence.now,
      poll: { mode: pollMode(cadence), nextPollAt: this.nextPollAt, consecutiveErrors: this.consecutiveErrors },
      thresholds: this.config.thresholds,
      claude,
      codex,
    };
  }

  private async claudeUsage(): Promise<ClaudeUsage | null> {
    const cfg = this.config.claude;
    if (!cfg) return null;
    const now = this.now();
    const { thresholds } = this.config;
    const sources: UsageSourceStatus[] = [];

    const push = this.statusline;
    let statuslineBars: UsageBar[] = [];
    if (cfg.statusLineCredentialEnv === null) {
      sources.push(notConfigured("claude.statusLine", "ingest not enabled"));
    } else if (!push) {
      sources.push({ id: "claude.statusLine", state: "no-data-yet", observedAt: null, detail: "no statusLine push yet" });
    } else if (push.verdict.kind === "not-applicable") {
      sources.push({ id: "claude.statusLine", state: "not-applicable", observedAt: push.at, detail: "plan limits do not apply to this auth" });
    } else {
      const stale = now - push.at >= STATUSLINE_FRESH_MS;
      const hasBars = push.verdict.kind === "bars";
      sources.push({
        id: "claude.statusLine",
        state: !hasBars ? "no-data-yet" : stale ? "stale" : "available",
        observedAt: push.at,
        detail: !hasBars ? "no rate limits in the last push" : stale ? "no recent push" : null,
      });
      if (push.verdict.kind === "bars") statuslineBars = finalizeBars(push.verdict.bars, "statusLine", push.at, thresholds);
    }

    sources.push(cfg.credentialsFile === null
      ? notConfigured("claude.oauth", "no credentialsFile configured")
      : statusOf("claude.oauth", this.oauth));
    const oauthBars = this.oauth.value && this.oauth.observedAt !== null
      ? finalizeBars(barsFromOauth(this.oauth.value.body), "oauth", this.oauth.observedAt, thresholds)
      : [];

    let transcripts: ClaudeUsage["transcripts"] = null;
    if (!this.transcripts) {
      sources.push(notConfigured("claude.transcripts", "no transcriptsDir configured"));
    } else {
      const scan = this.transcripts.latest();
      if (scan === null) {
        sources.push({ id: "claude.transcripts", state: "no-data-yet", observedAt: null, detail: "first scan in progress" });
      } else {
        if (scan.ok) transcripts = scan.totals;
        sources.push({
          id: "claude.transcripts",
          state: scan.ok ? "available" : "error",
          observedAt: scan.scannedAt,
          detail: scan.ok ? null : scan.detail,
        });
      }
    }

    return {
      plan: (push ? statuslinePlan(push.payload) : null) ?? this.oauth.value?.plan ?? null,
      bars: mergeClaudeBars(statuslineBars, push?.at ?? null, oauthBars, now),
      sources,
      transcripts,
    };
  }

  private async codexUsage(): Promise<CodexUsage | null> {
    const cfg = this.config.codex;
    if (!cfg) return null;
    const { thresholds } = this.config;
    const limits = isRecord(this.codexLimits.value) ? this.codexLimits.value : null;

    const byKey = new Map<string, UsageBar>();
    if (limits && this.codexLimits.observedAt !== null) {
      const drafts = barsFromSnapshotMap(limits.rateLimitsByLimitId, limits.rateLimits);
      for (const bar of finalizeBars(drafts, "app-server", this.codexLimits.observedAt, thresholds)) byKey.set(bar.key, bar);
    }

    const rollout = await this.readRollout(cfg.rolloutDir);
    let rolloutStatus: UsageSourceStatus;
    let rolloutPlan: string | null = null;
    if (rollout.status === "ok") {
      const at = rollout.reading.at ?? rollout.file.mtimeMs;
      rolloutStatus = { id: "codex.rollout", state: "available", observedAt: at, detail: null };
      rolloutPlan = typeof rollout.reading.snapshot.planType === "string" ? rollout.reading.snapshot.planType : null;
      // The rollout reflects the latest turn of any codex process; it wins only when newer.
      for (const bar of finalizeBars(barsFromSnapshotMap(null, rollout.reading.snapshot), "rollout", at, thresholds)) {
        const current = byKey.get(bar.key);
        if (!current || current.observedAt < bar.observedAt) byKey.set(bar.key, bar);
      }
    } else {
      rolloutStatus = { id: "codex.rollout", state: rollout.status, observedAt: null, detail: rollout.detail };
    }
    const rank = (bar: UsageBar) => (bar.key.startsWith("codex:") ? 0 : 10) + (bar.group === "session" ? 0 : 1);

    const credits = limits && isRecord(limits.rateLimitResetCredits) ? limits.rateLimitResetCredits.availableCount : null;
    return {
      plan: (limits ? codexPlan(limits.rateLimitsByLimitId, limits.rateLimits) : null) ?? rolloutPlan,
      resetCredits: typeof credits === "number" ? credits : null,
      bars: [...byKey.values()].sort((a, b) => rank(a) - rank(b)),
      sources: [statusOf("codex.appServer", this.codexLimits), rolloutStatus, statusOf("codex.history", this.codexHistory)],
      history: historyFromUsage(this.codexHistory.value),
    };
  }
}

/** The response when the config has no `llmUsage` section. */
export function disabledResponse(now: number): LlmUsageResponse {
  return {
    enabled: false,
    now,
    poll: { mode: "paused", nextPollAt: null, consecutiveErrors: 0 },
    thresholds: DEFAULT_THRESHOLDS,
    claude: null,
    codex: null,
  };
}

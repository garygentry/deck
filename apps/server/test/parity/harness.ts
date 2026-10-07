/**
 * Parity golden harness: boots the real server composition (`boot()`) against an estate
 * and captures its semantic projection, so a refactor of how deck is wired can be checked
 * against a frozen, committed golden.
 *
 * A projection holds, per case:
 * - `validate`: the `deck validate` exit class and output;
 * - only when the estate loads clean, each GET below as `{ status, contentType, body }`:
 *   - `config` (`/api/config`), `providers` (`/api/providers`), `health` (`/api/health`);
 *   - `envelopes`: `/api/providers/<id>` for every listed id, plus {@link UNKNOWN_PROVIDER}
 *     for the 404 shape;
 *   - `actions` (`/api/actions`), `actionRefusals` (governance-refused POSTs, see
 *     {@link ACTION_PROBES}), `actionsAudit` (`/api/actions/audit`, holding their records) and
 *     `llmUsage` (`/api/llm-usage`);
 * - `routes`: the registered route table as sorted `METHOD path` lines. Hono records one
 *   entry per handler, so a method + path with N > 1 entries (a middleware chain, or a second
 *   registration that would shadow the first) carries a `×N` suffix and any change shows.
 *
 * Determinism:
 * - `Date` is frozen at {@link FIXED_NOW}, so uptime, freshness ages and poll timestamps are
 *   stable as captured. The values that still vary (latencies measured with
 *   `performance.now`, random audit run ids) are masked at their known paths
 *   ({@link VOLATILE_PATHS}) to a typed token; a value of another shape is left as-is so the
 *   diff shows it.
 * - `fetch` is {@link upstreamFetch}: canned bodies for known URLs, a rejection otherwise.
 *   `Bun.spawn` throws and `Bun.serve` is a stub, so there is no network, subprocess or port.
 *   Every provider settles after one poll, and the harness waits for that before capturing.
 * - All `DECK_*` env vars are cleared, then set from the case. The sources cache, actions data
 *   dir and web dist live in a temp dir masked as `<tmp>`; the estate dir is `<estate>`, the
 *   repo root `<repo>` and the OS temp dir `<os-tmp>`.
 *
 * Source paths in estate config resolve against the process cwd, which is `apps/server` for
 * both `pnpm -r test` and `bunx vitest run`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Hono } from "hono";
import { expect, vi } from "vitest";

import { logger } from "../../src/log/logger.js";
import { runSnapshotValidate } from "../../src/cli/snapshot.js";
import { runValidate } from "../../src/cli/validate.js";
import { listMetrics, stopScheduler } from "../../src/providers/registry.js";
import { boot } from "../../src/server/boot.js";
import { POLL_DEFAULTS } from "../../src/contract/index.js";
import { setUpstreamOffline, upstreamFetch } from "./upstream.js";

/** The frozen wall clock every capture runs at. */
export const FIXED_NOW = Date.parse("2026-01-01T00:00:00.000Z");

/** `apps/server`, the cwd estate source paths resolve against. */
export const SERVER_ROOT = resolve(__dirname, "../..");
export const REPO_ROOT = resolve(SERVER_ROOT, "../..");
export const GOLDEN_DIR = join(SERVER_ROOT, "test/golden/parity");

/** A provider id no estate registers; its envelope request pins the 404 shape. */
export const UNKNOWN_PROVIDER = "parity-unknown-provider";

/**
 * Opt-in golden refresh, read at call time. Unset (the default, and always in CI), a
 * mismatch or a missing golden fails. Set to `1` to rewrite the goldens from the current
 * code, then review the diff:
 *   DECK_UPDATE_GOLDENS=1 pnpm --filter @deck/server exec vitest run test/parity-golden.test.ts
 */
export function updateRequested(): boolean {
  return process.env.DECK_UPDATE_GOLDENS === "1";
}

/**
 * Apps created by `createApp` during a capture. The test file feeds this through a
 * `vi.mock` of `src/server/app.ts` (mocks must live in the test file), so the route
 * table is read from the real Hono instance `boot()` serves.
 */
export const createdApps: Hono[] = [];

export interface ParityCase {
  /** Golden file name (without `.json`). */
  id: string;
  /** Estate config dir, relative to `apps/server` or absolute. */
  dir: string;
  /**
   * Extra env for boot. `<tmp>` in a value expands to the case's temp dir, and `<server>`
   * to `apps/server`.
   */
  env?: Record<string, string>;
  /** Pass `webDistDir` to boot, so the static/SPA routes are in the table. */
  web?: boolean;
  /** Also capture the freshness transitions ({@link captureTransitions}). */
  transitions?: boolean;
}

export interface CliProjection {
  exitClass: number;
  stdout: string;
  stderr: string;
}

export interface HttpProjection {
  status: number;
  contentType: string | null;
  body: unknown;
}

export interface Projection {
  validate: CliProjection;
  config?: HttpProjection;
  providers?: HttpProjection;
  envelopes?: Record<string, HttpProjection>;
  health?: HttpProjection;
  actions?: HttpProjection;
  /** POSTs that every refusal gate rejects before a runner could spawn ({@link ACTION_PROBES}). */
  actionRefusals?: Record<string, HttpProjection>;
  /** Read after the refusals, so it holds their audit records. */
  actionsAudit?: HttpProjection;
  /** Read last: a read marks a viewer and arms the llm-usage collector. */
  llmUsage?: HttpProjection;
  routes?: string[];
  /** Envelopes and health later in time, when the case asks for them. */
  transitions?: Transitions;
}

export interface Transitions {
  /** Clock past `ttlMs` with no new poll: fresh data reads stale. */
  pastTtl: Record<string, HttpProjection>;
  /** Clock past `unreachableAfterMs` with no new poll: data reads unreachable by age. */
  pastUnreachableAfter: Record<string, HttpProjection>;
  /** Upstreams go unrouted and one scheduled poll runs: last-known data, failed poll. */
  afterOutage: { envelopes: Record<string, HttpProjection>; health: HttpProjection };
}

/** A volatile value's mask: the token it becomes, and the shape it must have to be masked. */
interface VolatileMask {
  token: string;
  matches(value: unknown): boolean;
}

const MEASURED_MS: VolatileMask = { token: "<time:number>", matches: (value) => typeof value === "number" };
const UUID: VolatileMask = {
  token: "<uuid:string>",
  matches: (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
};

/**
 * Projection paths whose values the frozen `Date` does not fix. `*` matches any one key. A
 * value is masked only when it has the expected shape, so a type change still shows.
 */
export const VOLATILE_PATHS: Readonly<Record<string, VolatileMask>> = {
  // http-health measures its request with performance.now().
  "envelopes.*.body.data.latencyMs": MEASURED_MS,
  "transitions.*.*.body.data.latencyMs": MEASURED_MS,
  "transitions.afterOutage.envelopes.*.body.data.latencyMs": MEASURED_MS,
  // Audit records get a random run id.
  "actionsAudit.body.*.runId": UUID,
};

const volatilePatterns = Object.entries(VOLATILE_PATHS).map(([path, mask]) => ({ parts: path.split("."), mask }));

function volatileMask(path: readonly string[]): VolatileMask | undefined {
  return volatilePatterns.find(
    ({ parts }) => parts.length === path.length && parts.every((part, i) => part === "*" || part === path[i]),
  )?.mask;
}

/**
 * Mask machine-specific paths in strings, and volatile values at {@link VOLATILE_PATHS}.
 * Each `[path, token]` in `masks` is replaced first (most specific first), then the repo
 * root and the OS temp dir.
 */
export function normalise(
  value: unknown,
  masks: ReadonlyArray<readonly [string, string]> = [],
  path: readonly string[] = [],
): unknown {
  const mask = volatileMask(path);
  if (mask?.matches(value)) return mask.token;
  if (typeof value === "string") {
    let text = value;
    for (const [from, token] of [...masks, [REPO_ROOT, "<repo>"], [tmpdir(), "<os-tmp>"]] as const) {
      text = text.split(from).join(token);
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalise(item, masks, [...path, String(index)]));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalise(item, masks, [...path, key]);
    return out;
  }
  return value;
}

function captureCli(run: () => number): CliProjection {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const exitClass = run();
    return { exitClass, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** Run `deck validate <dir>` in-process and capture its exit class and output. */
export function captureValidate(dir: string): CliProjection {
  return captureCli(() => runValidate([dir]));
}

/** Run `deck snapshot validate <file>` in-process, with the file path masked as `<snapshot>`. */
export function captureSnapshotValidate(file: string): CliProjection {
  return normalise(captureCli(() => runSnapshotValidate([file])), [[file, "<snapshot>"]]) as CliProjection;
}

/** How long the harness waits for providers to settle; the test timeout must exceed it. */
export const SETTLE_TIMEOUT_MS = 10_000;

function attempts(): Map<string, number> {
  return new Map(listMetrics().map((m) => [m.id, m.successTotal + m.failureTotal]));
}

/** Wait until every registered provider has more poll attempts than in `after` (default none). */
async function settleProviders(after: ReadonlyMap<string, number> = new Map(), skip: ReadonlySet<string> = new Set()): Promise<void> {
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const pending = listMetrics().filter(
      (m) => !skip.has(m.id) && m.successTotal + m.failureTotal <= (after.get(m.id) ?? 0),
    );
    if (pending.length === 0) return;
    if (performance.now() > deadline) {
      throw new Error(`providers never settled: ${pending.map((m) => m.id).join(", ")}`);
    }
    await new Promise((done) => setTimeout(done, 5));
  }
}

function withDeckEnv(env: Record<string, string>): () => void {
  const saved = Object.entries(process.env).filter(([key]) => key.startsWith("DECK_"));
  for (const [key] of saved) delete process.env[key];
  Object.assign(process.env, env);
  return () => {
    for (const key of Object.keys(process.env)) if (key.startsWith("DECK_")) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
  };
}

async function get(app: Hono, path: string): Promise<HttpProjection> {
  const response = await app.request(path);
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  let body: unknown = text;
  if (contentType?.includes("json")) body = JSON.parse(text);
  return { status: response.status, contentType, body };
}

/**
 * Action runs that the governance gates refuse before spawning anything: an undeclared id,
 * an unprovisioned runner, and invalid params. With the capability off, each is the
 * disabled refusal instead.
 */
export const ACTION_PROBES: Record<string, { path: string; body: unknown }> = {
  unknownAction: { path: "/api/actions/parity-undeclared", body: {} },
  runnerUnresolved: { path: "/api/actions/orphan", body: {} },
  paramsInvalid: { path: "/api/actions/deploy", body: { count: "many", mode: "reckless" } },
};

async function post(app: Hono, path: string, body: unknown): Promise<HttpProjection> {
  const response = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  return { status: response.status, contentType, body: contentType?.includes("json") ? JSON.parse(text) : text };
}

async function readEnvelopes(app: Hono, ids: readonly string[]): Promise<Record<string, HttpProjection>> {
  const out: Record<string, HttpProjection> = {};
  for (const id of ids) out[id] = await get(app, `/api/providers/${encodeURIComponent(id)}`);
  return out;
}

/**
 * Move the frozen clock and the upstream, and re-read what the freshness model derives:
 * - past `ttlMs`, then past `unreachableAfterMs` (both with the default timing and no poll);
 * - then every upstream goes unrouted and the scheduler's next interval runs one poll per
 *   polled provider, so each holds its last-known data beside a failed poll.
 */
async function captureTransitions(app: Hono, ids: readonly string[], linkIds: ReadonlySet<string>): Promise<Transitions> {
  vi.setSystemTime(FIXED_NOW + POLL_DEFAULTS.ttlMs + 15_000);
  const pastTtl = await readEnvelopes(app, ids);
  vi.setSystemTime(FIXED_NOW + POLL_DEFAULTS.unreachableAfterMs + 10_000);
  const pastUnreachableAfter = await readEnvelopes(app, ids);

  setUpstreamOffline(true);
  const before = attempts();
  // Faked setInterval: one interval period fires each polled provider's timer once (the
  // in-flight guard drops any repeat), and advances the frozen clock by that period.
  vi.advanceTimersByTime(POLL_DEFAULTS.pollIntervalMs);
  await settleProviders(before, linkIds);
  return {
    pastTtl,
    pastUnreachableAfter,
    afterOutage: { envelopes: await readEnvelopes(app, ids), health: await get(app, "/api/health") },
  };
}

/** The route table: sorted `METHOD path` lines, `×N` when N > 1 handler entries share one. */
export function routeTable(routes: ReadonlyArray<{ method: string; path: string }>): string[] {
  const counts = new Map<string, number>();
  for (const route of routes) {
    const line = `${route.method} ${route.path}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, count]) => (count > 1 ? `${line} ×${count}` : line)).sort();
}

export interface CaptureOptions {
  /** Called with the booted app once providers settle, before the projection is read. */
  onApp?: (app: Hono) => Promise<void>;
}

/** Capture one case's normalised projection. */
export async function capture(parityCase: ParityCase, options: CaptureOptions = {}): Promise<Projection> {
  const dir = resolve(SERVER_ROOT, parityCase.dir);
  const tmp = mkdtempSync(join(tmpdir(), "deck-parity-"));
  const expand = (value: string) => value.replaceAll("<tmp>", tmp).replaceAll("<server>", SERVER_ROOT);
  const env: Record<string, string> = {
    DECK_LOG_LEVEL: "silent",
    DECK_SOURCES_CACHE_DIR: join(tmp, "sources-cache"),
  };
  for (const [key, value] of Object.entries(parityCase.env ?? {})) env[key] = expand(value);
  const restoreEnv = withDeckEnv(env);
  // The registry logs through the shared logger, created before the case env applies.
  const logLevel = logger.level;
  logger.level = "silent";

  // Intervals are faked too, so the scheduler polls only when a capture advances the clock.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: FIXED_NOW });
  vi.stubGlobal("fetch", upstreamFetch);
  vi.stubGlobal("Bun", {
    serve: () => ({ stop: async () => undefined }),
    spawn: () => {
      throw new Error("process spawn disabled in parity harness");
    },
  });
  createdApps.length = 0;

  // The estate dir is masked before the repo root, so an in-memory fixture's temp dir and a
  // committed fixture dir both print as `<estate>`.
  const masks = [[dir, "<estate>"], [tmp, "<tmp>"]] as const;
  try {
    const projection: Projection = { validate: captureValidate(dir) };
    if (projection.validate.exitClass !== 0) return normalise(projection, masks) as Projection;

    const webDistDir = join(tmp, "web-dist");
    if (parityCase.web) mkdirSync(webDistDir);
    const handle = await boot({ configDir: dir, port: 0, ...(parityCase.web ? { webDistDir } : {}) });
    try {
      await settleProviders();
      const app = createdApps.at(-1);
      if (app === undefined) throw new Error("boot() did not create an app; is createApp mocked?");
      await options.onApp?.(app);
      projection.config = await get(app, "/api/config");
      projection.providers = await get(app, "/api/providers");
      const ids = (projection.providers.body as { providers: Array<{ id: string }> }).providers.map((p) => p.id);
      projection.envelopes = await readEnvelopes(app, [...ids, UNKNOWN_PROVIDER]);
      projection.health = await get(app, "/api/health");
      projection.actions = await get(app, "/api/actions");
      projection.actionRefusals = {};
      for (const [name, probe] of Object.entries(ACTION_PROBES)) {
        projection.actionRefusals[name] = await post(app, probe.path, probe.body);
      }
      projection.actionsAudit = await get(app, "/api/actions/audit");
      projection.llmUsage = await get(app, "/api/llm-usage");
      projection.routes = routeTable(app.routes);
      if (parityCase.transitions) {
        const listed = (projection.providers.body as { providers: Array<{ id: string; kind: string }> }).providers;
        const linkIds = new Set(listed.filter((p) => p.kind === "link").map((p) => p.id));
        projection.transitions = await captureTransitions(app, ids, linkIds);
      }
    } finally {
      await handle.stop();
    }
    return normalise(projection, masks) as Projection;
  } finally {
    stopScheduler();
    setUpstreamOffline(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreEnv();
    logger.level = logLevel;
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Write in-memory config layers (file name → document) as a temp estate dir. */
export function layersDir(layers: Record<string, unknown>): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "deck-parity-doc-"));
  // JSON is valid YAML, and keeps the layer byte-stable across `yaml` versions.
  for (const [name, document] of Object.entries(layers)) {
    writeFileSync(join(dir, name), JSON.stringify(document, null, 2));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface GoldenOptions {
  /**
   * Rewrite the frozen golden before comparing. A later migration (v1 → v2 config) uses this
   * to compare its output with the frozen v1 golden under a declared path mapping, instead
   * of re-freezing the golden. Update mode refuses to write through it.
   */
  transformGolden?: (golden: unknown) => unknown;
  /** Override {@link updateRequested} (the harness self-tests pin both modes). */
  update?: boolean;
}

export function goldenPath(id: string): string {
  return join(GOLDEN_DIR, `${id}.json`);
}

export function readGolden(id: string): unknown {
  return JSON.parse(readFileSync(goldenPath(id), "utf8"));
}

/** Compare `actual` with the committed golden `id` (or rewrite it when opted in). */
export function expectGolden(id: string, actual: unknown, options: GoldenOptions = {}): void {
  const path = goldenPath(id);
  const serialised = `${JSON.stringify(actual, null, 2)}\n`;
  if (options.update ?? updateRequested()) {
    if (options.transformGolden !== undefined) {
      // A transformed comparison is against a frozen baseline: writing `actual` here would
      // replace that baseline with the migrated output.
      throw new Error(`refusing to refresh frozen golden ${id} through transformGolden`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialised);
    return;
  }
  let golden: unknown;
  try {
    golden = readGolden(id);
  } catch {
    throw new Error(`missing parity golden ${path}; run with DECK_UPDATE_GOLDENS=1 to create it`);
  }
  const expected = options.transformGolden ? options.transformGolden(golden) : golden;
  expect(JSON.parse(serialised)).toEqual(expected);
}

/**
 * Actions-capability runtime resolution from deck-deployment environment variables.
 *
 * `ActionsRuntime`, `ActionsDeps`, `ACTIONS_ENV`, `DEFAULT_ACTION_TIMEOUT_MS`, and
 * `DEFAULT_ACTIONS_ENABLED` are DEFINED here (deck-deployment settings, NOT estate
 * config). `resolveActionsRuntime(env)` implements their resolution once at
 * boot: disabled → an inert runtime reading no manifest; enabled → require the
 * data dir + runners file, parse the timeout, and load the runner allowlist, failing
 * fast on any misconfiguration.
 */
import type { AuditStore } from "./audit.js";
import type { ActionExecutor } from "./executor.js";
import { loadRunners } from "./runners.js";

/**
 * Deck-deployment settings for the actions capability, resolved once in boot() from
 * environment variables. These are deck settings, NOT estate config fields.
 */
export interface ActionsRuntime {
  /** Master capability switch. When false the capability is off. */
  enabled: boolean;
  /** Default maximum run duration in ms; DECK_ACTION_TIMEOUT_MS. */
  timeoutMs: number;
  /** Audit store root directory; DECK_DATA_DIR. */
  dataDir: string;
  /** Runner name -> absolute executable path allowlist; from DECK_RUNNERS_FILE. */
  runners: ReadonlyMap<string, string>;
}

/**
 * The actions dependency bundle injected into the Hono app. Absent — or present with
 * `runtime.enabled === false` — means the capability is off (the routes gate on both).
 */
export interface ActionsDeps {
  runtime: ActionsRuntime;
  executor: ActionExecutor;
  audit: AuditStore;
}

/** Environment variable names for the actions capability (deck-deployment settings). */
export const ACTIONS_ENV = {
  /** Master capability switch. */
  ENABLED: "DECK_ACTIONS_ENABLED",
  /** Default max run duration in ms. */
  TIMEOUT_MS: "DECK_ACTION_TIMEOUT_MS",
  /** Audit store root directory. */
  DATA_DIR: "DECK_DATA_DIR",
  /** Runner manifest path. */
  RUNNERS_FILE: "DECK_RUNNERS_FILE",
} as const;

/** Default max run duration: 10 minutes. */
export const DEFAULT_ACTION_TIMEOUT_MS = 600_000;

/**
 * Default for DECK_ACTIONS_ENABLED: false. Safe-by-default — every existing deployment
 * stays pure read-only until an operator opts in AND provisions runners + data dir.
 */
export const DEFAULT_ACTIONS_ENABLED = false;

/**
 * Resolve the actions-capability deployment settings once from the environment.
 *
 * Called from boot() alongside the existing DECK_CONFIG_DIR / DECK_PORT /
 * DECK_SNAPSHOT_SOURCE reads. Deck-deployment settings, NOT estate config.
 *
 * Fail-fast posture (mirrors a bad config): when the capability is ENABLED but a
 * required setting is missing/invalid, or the manifest is malformed, this throws — the
 * process must not boot a half-configured write path. When DISABLED, it returns a
 * benign, inert runtime (no manifest read, no dir requirement) so a pure read-only
 * deployment boots unchanged.
 *
 * @param env  Process environment (defaults to process.env; injectable for tests).
 * @returns    A fully-resolved ActionsRuntime.
 * @throws {Error & { code: "ACTIONS_CONFIG_INVALID" }} enabled but DECK_DATA_DIR or
 *         DECK_RUNNERS_FILE unset, or DECK_ACTION_TIMEOUT_MS not a positive integer.
 * @throws {Error & { code: "RUNNERS_MANIFEST_INVALID" }} propagated from loadRunners.
 */
export function resolveActionsRuntime(
  env: NodeJS.ProcessEnv = process.env,
): ActionsRuntime {
  const enabled = parseBool(env[ACTIONS_ENV.ENABLED], DEFAULT_ACTIONS_ENABLED);

  if (!enabled) {
    // Inert runtime: capability off. No manifest read, no dir requirement.
    return {
      enabled: false,
      timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
      dataDir: "",
      runners: new Map<string, string>(),
    };
  }

  const dataDir = requireEnv(env, ACTIONS_ENV.DATA_DIR);
  const runnersFile = requireEnv(env, ACTIONS_ENV.RUNNERS_FILE);
  const timeoutMs = parseTimeoutMs(env[ACTIONS_ENV.TIMEOUT_MS]);
  const runners = loadRunners(runnersFile); // may throw RUNNERS_MANIFEST_INVALID

  return { enabled: true, timeoutMs, dataDir, runners };
}

/** "true" / "1" (case-insensitive) => true; unset => fallback; anything else => false. */
export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1";
}

/** Require a non-empty env var when the capability is enabled; else fail fast. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw configError(`${name} is required when ${ACTIONS_ENV.ENABLED} is true.`);
  }
  return value;
}

/**
 * Parse DECK_ACTION_TIMEOUT_MS. Unset => DEFAULT_ACTION_TIMEOUT_MS (10 min).
 * Set-but-not-a-positive-integer => fail fast (a mis-set duration must not
 * silently fall back to the default and surprise an operator).
 */
function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ACTION_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw configError(
      `${ACTIONS_ENV.TIMEOUT_MS} must be a positive integer (ms); got "${raw}".`,
    );
  }
  return n;
}

function configError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "ACTIONS_CONFIG_INVALID";
  return error;
}

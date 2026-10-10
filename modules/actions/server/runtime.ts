/**
 * Actions-capability runtime resolution from deck-deployment environment variables.
 *
 * `ActionsRuntime`, `ActionsDeps`, `ACTIONS_ENV` and `DEFAULT_ACTION_TIMEOUT_MS` are DEFINED
 * here (deck-deployment settings, NOT estate config). `resolveActionsRuntime(env)` runs once
 * when the actions module starts: it requires the runners file, parses the timeout, and
 * loads the runner allowlist, failing fast on any misconfiguration.
 */
import type { AuditStore } from "./audit.js";
import type { ActionExecutor } from "./executor.js";
import { loadRunners } from "./runners.js";

/**
 * Deck-deployment settings for the actions capability, resolved once by the actions module's
 * init (which runs only while DECK_ACTIONS_ENABLED is on) from environment variables. These
 * are deck settings, NOT estate config fields.
 */
export interface ActionsRuntime {
  /** Default maximum run duration in ms; DECK_ACTION_TIMEOUT_MS. */
  timeoutMs: number;
  /** Runner name -> absolute executable path allowlist; from DECK_RUNNERS_FILE. */
  runners: ReadonlyMap<string, string>;
}

/** The actions dependency bundle the routes serve: the module builds it only while it runs. */
export interface ActionsDeps {
  runtime: ActionsRuntime;
  executor: ActionExecutor;
  audit: AuditStore;
}

/** A structured log event the actions code writes (its `event` names are `action.*`). */
export interface ActionsLogEvent {
  event: string;
  [field: string]: unknown;
}

/** The logging surface the actions code writes to: the module's scoped logger in deck. */
export interface ActionsLogger {
  info(event: ActionsLogEvent, message?: string): void;
  warn(event: ActionsLogEvent, message?: string): void;
  error(event: ActionsLogEvent, message?: string): void;
}

/**
 * Environment variable names the actions module owns (deck-deployment settings). The audit
 * store lives in the module's data dir, `$DECK_DATA_DIR/actions`.
 */
export const ACTIONS_ENV = {
  /** Master capability switch (the module's `enabledBy.env`). */
  ENABLED: "DECK_ACTIONS_ENABLED",
  /** Default max run duration in ms. */
  TIMEOUT_MS: "DECK_ACTION_TIMEOUT_MS",
  /** Runner manifest path. */
  RUNNERS_FILE: "DECK_RUNNERS_FILE",
} as const;

/** Default max run duration: 10 minutes. */
export const DEFAULT_ACTION_TIMEOUT_MS = 600_000;

/**
 * Resolve the actions settings once, when the module starts (the capability is on).
 *
 * Fail-fast posture (mirrors a bad config): a required setting that is missing or invalid,
 * or a malformed runner manifest, throws — the process must not boot a half-configured
 * write path.
 *
 * @param env  The module's env (its declared names).
 * @returns    A fully-resolved ActionsRuntime.
 * @throws {Error & { code: "ACTIONS_CONFIG_INVALID" }} DECK_RUNNERS_FILE unset, or
 *         DECK_ACTION_TIMEOUT_MS not a positive integer.
 * @throws {Error & { code: "RUNNERS_MANIFEST_INVALID" }} propagated from loadRunners.
 */
export function resolveActionsRuntime(env: Readonly<Record<string, string | undefined>>): ActionsRuntime {
  const runnersFile = requireEnv(env, ACTIONS_ENV.RUNNERS_FILE);
  const timeoutMs = parseTimeoutMs(env[ACTIONS_ENV.TIMEOUT_MS]);
  const runners = loadRunners(runnersFile); // may throw RUNNERS_MANIFEST_INVALID
  return { timeoutMs, runners };
}

/** Require a non-empty env var when the capability is enabled; else fail fast. */
function requireEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
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

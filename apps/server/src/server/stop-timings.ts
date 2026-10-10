/**
 * Bounds on the stages of a deck shutdown. The stages that run one after another (the
 * module stage; then the request grace; then the forced close) must
 * fit inside the overall shutdown deadline with room to spare, so a stop that uses every
 * bound still exits cleanly instead of at the deadline.
 */
export interface StopTimings {
  /** Per module: waiting for its in-flight scheduled runs. */
  drainTimeoutMs?: number;
  /** Per module stop hook. */
  hookTimeoutMs?: number;
  /**
   * The whole module stage: every module's drain and hooks, including early hooks with their
   * own bound (a module cancelling work still in flight, say).
   */
  modulesMs?: number;
  /** In-flight requests finishing once the listener has closed. */
  graceMs?: number;
}

/** How long Bun's forced close is awaited; the connections are already closed by then. */
export const FORCE_CLOSE_WAIT_MS = 500;

/** Time the deadline keeps free beyond every stage, for logging and the process exit. */
export const SHUTDOWN_MARGIN_MS = 1_500;

export const DEFAULT_STOP_TIMINGS: Readonly<Required<StopTimings>> = Object.freeze({
  drainTimeoutMs: 2_000,
  hookTimeoutMs: 1_000,
  modulesMs: 4_000,
  graceMs: 2_500,
});

/** The defaults with any given override applied. */
export function resolveStopTimings(overrides: StopTimings = {}): Required<StopTimings> {
  const defined = Object.entries(overrides).filter(([, value]) => value !== undefined);
  return { ...DEFAULT_STOP_TIMINGS, ...Object.fromEntries(defined) };
}

/** The longest a stop can take with these bounds: the module stage, the grace, the forced close. */
export function stopBudgetMs(timings: Required<StopTimings>): number {
  return timings.modulesMs + timings.graceMs + FORCE_CLOSE_WAIT_MS;
}

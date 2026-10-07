/**
 * Wall-clock budgets for the E2E performance gates.
 *
 * The budgets are set for an idle CI runner. On a loaded host (e.g. a 2-CPU box
 * also running other suites) set DECK_E2E_PERF_SCALE to stretch every budget by
 * that factor instead of editing the gates; CI leaves it unset (scale 1).
 */
const scale = Number(process.env.DECK_E2E_PERF_SCALE ?? 1);
const PERF_SCALE = Number.isFinite(scale) && scale >= 1 ? scale : 1;

export function perfBudget(ms: number): number {
  return ms * PERF_SCALE;
}

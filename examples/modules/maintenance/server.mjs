// @ts-check
// The server half of a runtime module. It imports nothing from deck at runtime: everything it
// uses comes through `ctx`, and `@deck/module-sdk` is imported for types only.
import manifest from "./deck-module.json" with { type: "json" };

/** @typedef {{ name: string, start: string, durationMinutes: number }} Window */
/** @typedef {{ windows: Window[] }} MaintenanceConfig */

// A date-time with an explicit offset (`Z` or `±hh:mm`), so every reader agrees on the instant.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Pure config rule: every start must be a date-time with an offset.
 * @type {import("@deck/module-sdk").ConfigRule<MaintenanceConfig>}
 */
const startsAreDateTimes = (section) =>
  (section.windows ?? []).flatMap((window, index) =>
    DATE_TIME.test(window.start) && !Number.isNaN(Date.parse(window.start))
      ? []
      : [{ code: "MAINTENANCE_START_INVALID", path: `/windows/${index}/start`, message: `"${window.start}" is not a date-time with an offset.` }],
  );

/**
 * Where `now` falls among the windows: the one in progress, and the next to start.
 * @param {Window[]} windows
 * @param {number} now
 */
function summarise(windows, now) {
  const spans = windows
    .map((window) => {
      const start = Date.parse(window.start);
      return { ...window, startMs: start, endMs: start + window.durationMinutes * 60_000 };
    })
    .sort((a, b) => a.startMs - b.startMs);
  const active = spans.find((span) => span.startMs <= now && now < span.endMs) ?? null;
  const next = spans.find((span) => span.startMs > now) ?? null;
  const strip = (/** @type {typeof spans[number] | null} */ span) =>
    span === null ? null : { name: span.name, start: span.start, end: new Date(span.endMs).toISOString() };
  return { active: strip(active), next: strip(next), count: spans.length };
}

/** @type {import("@deck/module-sdk").ServerModule<MaintenanceConfig>} */
export default {
  manifest,
  configRules: [startsAreDateTimes],
  init(ctx) {
    const windows = ctx.config?.windows ?? [];
    // A provider: polled by the kernel and served at /api/providers/maintenance.
    ctx.providers.register(
      {
        id: "maintenance",
        kind: "maintenance",
        health: async () => ({ ok: true }),
        fetch: async () => summarise(windows, ctx.clock.now()),
      },
      { pollIntervalMs: 60_000 },
    );
    // A route of the module's own: GET /api/m/maintenance/windows.
    ctx.http.get("/windows", (c) => c.json({ windows }));
    ctx.health.report(() => ({ state: "ok", detail: `${windows.length} window(s)` }));
  },
};

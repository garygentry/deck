/**
 * An import of the monitoring module's implementation: its web or server half (by the
 * co-located `monitoring/{web,server}/` path, the old `alerts-and-health` feature path or the
 * `@deck/module-monitoring` package). Drift's guards hold drift to importing none of it.
 * `@deck/contract/modules/monitoring` is the shared contract, not the implementation, so it
 * does not match.
 */
export const MONITORING_IMPLEMENTATION_IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(?\s*)["'](?:[^"']*\/)?(?:alerts-and-health|monitoring\/(?:web|server)\/|@deck\/module-monitoring)/;

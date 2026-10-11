import { finding, type Finding } from "../../findings.js";

/**
 * Check a readable schema version before shape validation.
 *
 * The caller rejects non-integers as a tool error before invoking this helper.
 */
export function checkVersion(version: number, supported: ReadonlySet<number>): Finding | null {
  if (supported.has(version)) return null;

  return finding(
    "VERSION_UNSUPPORTED",
    "/schemaVersion",
    `schemaVersion ${version} is not supported; this library supports version(s) ` +
      `${[...supported].join(", ")}. Re-render with the projector pinned to ` +
      `the matching deck revision.`,
  );
}

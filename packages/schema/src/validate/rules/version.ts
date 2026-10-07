import { finding, type Finding } from "../../findings.js";
import { supportedVersions } from "../../version.js";

/**
 * Check a readable schema version before shape validation.
 *
 * The caller rejects non-integers as a tool error before invoking this helper.
 */
export function checkVersion(version: number): Finding | null {
  if (supportedVersions.has(version)) return null;

  return finding(
    "VERSION_UNSUPPORTED",
    "/schemaVersion",
    `schemaVersion ${version} is not supported; this library supports version(s) ` +
      `${[...supportedVersions].join(", ")}. Re-render with the projector pinned to ` +
      `the matching deck revision.`,
  );
}

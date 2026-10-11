import { UI_RELOAD_FINDING_CODES, type UiFinding } from "@deck/module-sdk";
import { Callout } from "@/ui";
import { useUiManifest, type UiManifestState } from "../data/index.js";

/**
 * The manifest's findings about reloading the config: it changed and no longer loads, or
 * changed outside `ui`. Other findings (about resolving the config) are not the shell's to show.
 */
export function reloadFindings(manifest: UiManifestState): readonly UiFinding[] {
  if (manifest.status !== "ready" || !Array.isArray(manifest.manifest.findings)) return [];
  // Findings are not checked when the manifest is read: keep only well-formed ones.
  return manifest.manifest.findings.filter(
    (finding) => typeof finding?.message === "string" && UI_RELOAD_FINDING_CODES.includes(finding.code),
  );
}

/** Says a config change was not applied, and why, while the server keeps serving the last good config. */
export function ReloadNotice() {
  const findings = reloadFindings(useUiManifest());
  if (findings.length === 0) return null;
  const restart = findings.every((finding) => finding.code === "UI_RESTART_REQUIRED");
  return (
    <Callout tone="warn" title={restart ? "Restart deck to apply the config change" : "Config change not applied"} className="mb-4">
      {findings.map((finding) => (
        <p key={`${finding.code}:${finding.message}`}>{finding.message}</p>
      ))}
    </Callout>
  );
}

/**
 * Verbatim / no-redaction operator notice (REQ-SEC-04).
 *
 * A short, dismissible notice stating deck's security posture in-product: deck renders configured
 * files verbatim and does not scan or redact. Dismissal is remembered for the browser session via
 * `sessionStorage` (per-surface key) so it does not nag on every navigation, but a new session
 * shows it again. The persistence lives here, in the feature: `Callout` only renders the dismiss
 * button. `role="note"` (informational, not an alert); it offers no control that changes
 * behaviour (REQ-RO-01).
 */

import { useState } from "react";
import type { JSX } from "react";
import { Callout } from "@/ui";

export interface VerbatimNoticeProps {
  /** Which surface is mounting it — used only for a stable per-surface dismissal key. */
  readonly surface: "docs" | "configs";
}

/** sessionStorage key prefix for the per-surface dismissal flag. */
const DISMISS_KEY_PREFIX = "deck.sources.verbatimNotice.dismissed.";

/** The single canonical posture message (REQ-SEC-04). */
export const VERBATIM_NOTICE_TEXT =
  "deck renders configured files verbatim and does not scan or redact. " +
  "Curate what is exposed via each source's include/exclude.";

function readDismissed(surface: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(DISMISS_KEY_PREFIX + surface) === "1";
  } catch {
    return false; // sessionStorage unavailable (private mode / SSR) — show the notice.
  }
}

export function VerbatimNotice({ surface }: VerbatimNoticeProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed(surface));
  if (dismissed) return null;

  const dismiss = (): void => {
    try {
      globalThis.sessionStorage?.setItem(DISMISS_KEY_PREFIX + surface, "1");
    } catch {
      /* ignore storage failure — dismissal is best-effort */
    }
    setDismissed(true);
  };

  return (
    <Callout
      tone="info"
      role="note"
      aria-label="Security notice"
      onDismiss={dismiss}
      dismissLabel="Dismiss security notice"
      compact
    >
      {VERBATIM_NOTICE_TEXT}
    </Callout>
  );
}

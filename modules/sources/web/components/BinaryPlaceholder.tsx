/**
 * "Binary — not shown" notice for a binary config file (REQ-CFG-04, SC-02).
 *
 * A binary file (NUL-sniffed in the leading 8 KiB) is LISTED in the tree but never rendered as
 * text and — because the page gates the content load off for binary nodes — its content is never
 * fetched. This notice renders directly from the manifest flag. `role="status"`: an expected
 * condition, not an error.
 */

import type { JSX } from "react";
import { Callout } from "@/ui";
import { FILE_NOTICE } from "../status.js";

export interface BinaryPlaceholderProps {
  /** The file path (for the accessible name). Optional — the tree already labels it. */
  readonly path?: string;
}

export function BinaryPlaceholder({ path }: BinaryPlaceholderProps): JSX.Element {
  const { tone, icon, role } = FILE_NOTICE.binary;
  return (
    <Callout tone={tone} icon={icon} role={role}>
      {path !== undefined ? `${path} is a binary file` : "This is a binary file"} — not shown.
    </Callout>
  );
}

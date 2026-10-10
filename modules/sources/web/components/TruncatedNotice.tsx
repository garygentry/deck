/**
 * "Too large — not shown" notice for an oversized config file (REQ-CFG-03, SC-02).
 *
 * Shown when the server returns `truncated: true` (file over MAX_FILE_BYTES, 1 MiB): the body is
 * NOT shipped, so the whole file never reaches the client (REQ-PERF-02). `role="status"`: an
 * expected condition, not an error.
 */

import type { JSX } from "react";
import { Callout } from "@/ui";
import { FILE_NOTICE } from "../status.js";

export interface TruncatedNoticeProps {
  /** The file path (for the accessible name). */
  readonly path: string;
  /** Byte size on disk (FileReadResult.size), reported even though content is omitted. */
  readonly size: number;
}

/** Human MiB string from a byte count, e.g. 1_468_006 → "1.4 MiB" (matches the 1 MiB cap). */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function TruncatedNotice({ path, size }: TruncatedNoticeProps): JSX.Element {
  const { tone, icon, role } = FILE_NOTICE.truncated;
  return (
    <Callout tone={tone} icon={icon} role={role} aria-label={`${path} is too large`}>
      This file is too large to display ({formatMegabytes(size)}) and is not shown.
    </Callout>
  );
}

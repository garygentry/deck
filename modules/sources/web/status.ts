/**
 * Presentation of the source browser's file-level notices (REQ-CFG-03/04, SC-14): each one pairs
 * a tone and a decorative icon with a text label, so colour is never the only signal. Expected
 * conditions, not failures, so both announce politely (`role="status"`).
 */

import { defineStatusMap } from "@/ui";

export type FileNoticeKind = "binary" | "truncated";

export const FILE_NOTICE = defineStatusMap<FileNoticeKind>({
  binary: { tone: "neutral", icon: "file-binary", label: "Binary file", role: "status" },
  truncated: { tone: "warn", icon: "triangle-alert", label: "Too large", role: "status" },
});

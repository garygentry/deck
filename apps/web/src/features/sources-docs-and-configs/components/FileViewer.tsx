/**
 * Read-only config file view (REQ-CFG-02/03/04, REQ-RO-01, SC-02).
 *
 * Presentational: it receives the selected `SourceTreeNode` (from the manifest) and the store's
 * `FileState` slice (driven by `useFileLoad`), and performs NO fetch of its own. A binary node
 * renders the placeholder directly from the manifest flag — the page gates the content load off
 * for binary nodes, so a binary file's content is never fetched as text (REQ-CFG-04). An
 * oversized file renders the truncation notice, never a body (REQ-CFG-03).
 *
 * The body is a `CodeBlock` fed with `highlightCode` output: highlight.js token markup around
 * ESCAPED source text, or fully escaped plaintext. The config surface never renders authored
 * HTML, so no DOMPurify pass is needed (contrast the markdown surface). There is no editing
 * affordance anywhere (REQ-RO-01).
 */

import type { JSX } from "react";
import type { SourceTreeNode } from "@deck/server/sources";
import { CodeBlock, EmptyState, ErrorState, LoadingState } from "@/ui";
import type { FileState } from "../client.js";
import { highlightCode, languageForName } from "../highlight.js";
import { TruncatedNotice } from "./TruncatedNotice.js";
import { BinaryPlaceholder } from "./BinaryPlaceholder.js";

export interface FileViewerProps {
  /** The selected manifest node, or null when no file is selected / path not in the tree. */
  readonly node: SourceTreeNode | null;
  /** The browse store's current file slice (FileState). */
  readonly file: FileState;
}

export function FileViewer({ node, file }: FileViewerProps): JSX.Element {
  if (node === null) {
    return <EmptyState icon="file" title="Select a file from the tree to view it." />;
  }
  if (node.type === "dir") {
    return (
      <EmptyState icon="folder-open" title="This is a folder. Select a file to view its contents." />
    );
  }
  // Binary — listed in the tree but never rendered as text and never fetched (REQ-CFG-04, SC-02).
  if (node.binary === true) return <BinaryPlaceholder path={node.path} />;

  // Text file — reflect the store's FileState (driven by useFileLoad).
  if (file.status === "idle" || file.status === "loading") {
    return <LoadingState label="Loading file…" rows={6} />;
  }
  if (file.status === "error") {
    return <ErrorState title="This file could not be read" message={file.error.message} />;
  }

  const { result } = file;
  // Over the 1 MiB cap — a notice, not the file body (REQ-CFG-03, SC-02).
  if (result.truncated) return <TruncatedNotice path={result.path} size={result.size} />;
  // The server also flags binary defensively even if the manifest lagged (REQ-CFG-04).
  if (result.binary) return <BinaryPlaceholder path={result.path} />;

  // Highlight by the server hint when present, else resolve by extension. The plaintext fallback
  // never throws on an unknown language.
  const content = result.content ?? "";
  const hinted = result.language ?? languageForName(result.path);
  const { value, language } = highlightCode(content, hinted);
  return (
    <CodeBlock
      code={content}
      highlightedHtml={value}
      language={language ?? undefined}
      caption={result.path}
    />
  );
}

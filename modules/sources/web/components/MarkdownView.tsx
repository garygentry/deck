/**
 * Docs document view (REQ-DOCS-02/03, REQ-RO-01/SC-10).
 *
 * Renders the selected markdown document read-only via the {@link renderMarkdown} pipeline. This
 * is the ONLY place the Docs view's sanitized HTML reaches the DOM:
 * `Prose` injects the pipeline's already-sanitized return value (the XSS boundary — `Prose` itself
 * does not sanitize); there is no second, un-sanitized injection path. No editing affordance
 * exists (read-only); task-list checkboxes render disabled.
 */

import type { JSX } from "react";
import { Callout, EmptyState, ErrorState, LoadingState, Prose } from "@/ui";
// ui-deep-import: the markdown pipeline is not in the barrel, so it stays out of the main bundle.
import { renderMarkdown } from "@/ui/lib/markdown.js";
import type { FileState } from "../client.js";
import { docsMarkdownContext } from "../markdown-context.js";
import { FILE_NOTICE } from "../status.js";

export interface MarkdownViewProps {
  /** The active source id (passed to renderMarkdown for relative rewriting). */
  readonly sourceId: string;
  /** Read state of the selected document. */
  readonly file: FileState;
  /** The selected doc path, or null when nothing is open. */
  readonly selectedPath: string | null;
}

export function MarkdownView({ sourceId, file, selectedPath }: MarkdownViewProps): JSX.Element {
  if (selectedPath === null || file.status === "idle") {
    return <EmptyState icon="book-open" title="Select a document to read." />;
  }

  if (file.status === "loading") {
    return <LoadingState label="Loading document…" rows={6} />;
  }

  if (file.status === "error") {
    return <ErrorState title="This document could not be read" message={file.error.message} />;
  }

  // status === "ready"
  const { result } = file;
  if (result.truncated) {
    const { tone, icon, role } = FILE_NOTICE.truncated;
    return (
      <Callout tone={tone} icon={icon} role={role}>
        This document is too large to display ({result.size} bytes).
      </Callout>
    );
  }
  if (result.binary) {
    const { tone, icon, role } = FILE_NOTICE.binary;
    return (
      <Callout tone={tone} icon={icon} role={role}>
        This file is not a text document.
      </Callout>
    );
  }

  const html = renderMarkdown(result.content ?? "", docsMarkdownContext(sourceId, result.path));
  return (
    <article aria-label="Document" className="min-w-0">
      {/* Already sanitized by renderMarkdown (DOMPurify); Prose does not sanitize. */}
      <Prose sanitizedHtml={html} />
    </article>
  );
}

import { Prose } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";
// The docs view's pipeline, so a widget's markdown is sanitised by the same DOMPurify boundary.
// ui-deep-import: the markdown pipeline is not in the barrel, so it stays out of the main bundle.
import { renderMarkdown } from "@/ui/lib/markdown.js";
import { UnexpectedValue } from "./UnexpectedValue.js";

/**
 * `core/markdown`: markdown from `options.content`, else the widget's value (text), rendered
 * and sanitised by the docs view's pipeline, its headings below the card's. Loaded on first use
 * (markdown-it, DOMPurify and highlight.js stay out of the main bundle).
 */
export default function MarkdownWidget({ value, options, widget }: WidgetProps<{ content?: string }>) {
  const markdown = options.content ?? value;
  if (typeof markdown !== "string") return <UnexpectedValue type={widget.type} expected="markdown text (options.content, or text from its source)" value={value} />;
  // Headings move below the card's h3 inside the pipeline, before its sanitiser runs.
  // A widget a sidecar contributes keeps only external links (its content, raw HTML or data).
  const externalLinksOnly = widget.linkPolicy === "external";
  return <Prose sanitizedHtml={renderMarkdown(markdown, undefined, { headingOffset: 3, externalLinksOnly })} />;
}


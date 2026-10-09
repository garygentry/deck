import { Prose } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";
// The docs view's pipeline, so a widget's markdown is sanitised by the same DOMPurify boundary.
import { renderMarkdown } from "../sources-docs-and-configs/markdown.js";
import { UnexpectedValue } from "./UnexpectedValue.js";

/**
 * `core/markdown`: markdown from `options.content`, else the widget's value (text), rendered
 * and sanitised by the docs view's pipeline. Loaded on first use (markdown-it, DOMPurify and
 * highlight.js stay out of the main bundle).
 */
export default function MarkdownWidget({ value, options, widget }: WidgetProps<{ content?: string }>) {
  const markdown = options.content ?? value;
  if (typeof markdown !== "string") return <UnexpectedValue type={widget.type} expected="markdown text (options.content, or text from its source)" value={value} />;
  return <Prose sanitizedHtml={renderMarkdown(markdown)} />;
}

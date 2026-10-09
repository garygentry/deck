import { Prose } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";
// The docs view's pipeline, so a widget's markdown is sanitised by the same DOMPurify boundary.
import { renderMarkdown } from "../sources-docs-and-configs/markdown.js";
import { UnexpectedValue } from "./UnexpectedValue.js";

/**
 * `core/markdown`: markdown from `options.content`, else the widget's value (text), rendered
 * and sanitised by the docs view's pipeline, its headings below the card's. Loaded on first use
 * (markdown-it, DOMPurify and highlight.js stay out of the main bundle).
 */
export default function MarkdownWidget({ value, options, widget }: WidgetProps<{ content?: string }>) {
  const markdown = options.content ?? value;
  if (typeof markdown !== "string") return <UnexpectedValue type={widget.type} expected="markdown text (options.content, or text from its source)" value={value} />;
  return <Prose sanitizedHtml={demoteHeadings(renderMarkdown(markdown), 3)} />;
}

/**
 * Sanitised HTML with every heading moved `by` levels down (at most `h6`), so a widget's
 * markdown (`# Title`, or a raw `<h1>`) sits under its card's `h3` and never adds a second `h1`.
 * It works on parsed nodes in an inert template, renaming tags and keeping their attributes and
 * children, so it adds nothing the sanitiser did not already pass.
 */
export function demoteHeadings(html: string, by: number): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const heading of template.content.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const level = Math.min(6, Number(heading.tagName.slice(1)) + by);
    const demoted = document.createElement(`h${level}`);
    for (const { name, value } of heading.attributes) demoted.setAttribute(name, value);
    demoted.append(...heading.childNodes);
    heading.replaceWith(demoted);
  }
  return template.innerHTML;
}

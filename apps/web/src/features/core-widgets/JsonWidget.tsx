import { CodeBlock } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";

/** `core/json`: the widget's value as formatted JSON, for looking at what a source and select give. */
export function JsonWidget({ value, options }: WidgetProps<{ wrap?: boolean }>) {
  return <CodeBlock code={JSON.stringify(value, null, 2) ?? "null"} language="json" wrap={options.wrap === true} maxHeight="24rem" />;
}

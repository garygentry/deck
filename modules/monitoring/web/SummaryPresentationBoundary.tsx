import type { ReactNode } from "react";
import { FragmentBoundary } from "@/ui";

interface SummaryBoundaryProps {
  readonly segment: "alerts" | "metrics";
  readonly href: string;
  readonly children: ReactNode;
}

/**
 * Isolates one health-header segment: a render throw degrades to a fixed
 * "{Alerts|Metrics} summary unavailable" alert link to the owning section, and
 * never exposes the exception or breaks sibling segments.
 */
export function SummaryPresentationBoundary({ segment, href, children }: SummaryBoundaryProps) {
  const label = segment === "alerts" ? "Alerts summary" : "Metrics summary";
  return (
    <FragmentBoundary label={label} href={href}>
      {children}
    </FragmentBoundary>
  );
}

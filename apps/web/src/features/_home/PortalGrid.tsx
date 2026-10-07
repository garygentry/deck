import type { FreshnessStamp } from "@deck/server";
import { Section } from "@/ui";

export interface PortalGridProps {
  data: unknown | null;
  freshness: FreshnessStamp;
}

export function PortalGrid(_props: PortalGridProps) {
  return <Section title="Portal links" headingId="portal-links-heading" />;
}

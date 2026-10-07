import type { JSX } from "react";
import { Button, EmptyState, PageHeader } from "@/ui";

export interface InventoryNotFoundProps {
  /** Entity kind controls heading and list destination. */
  kind: "host" | "service";
}

/** The not-found heading id (one per page). */
const HEADING_ID = "inventory-not-found-heading";

/**
 * Render an accessible feature-owned unknown-entity result with a recovery link.
 *
 * This is an expected lookup outcome, not a server failure, so the explanatory
 * text is a polite `role="status"` empty state. The recovery anchor is a normal
 * link, naturally keyboard reachable with visible focus. No raw route bytes are
 * echoed, so an undecodable navigation cannot inject text or markup here.
 */
export function InventoryNotFound({ kind }: InventoryNotFoundProps): JSX.Element {
  const isHost = kind === "host";
  return (
    <section aria-labelledby={HEADING_ID} className="flex flex-col gap-4">
      <PageHeader id={HEADING_ID} title={isHost ? "Host not found" : "Service not found"} />
      <EmptyState
        icon="search-x"
        title={
          isHost
            ? "No declared or observed host matches this route."
            : "No declared or observed service matches this route."
        }
        action={
          <Button asChild variant="outline" size="sm">
            <a href={isHost ? "/hosts" : "/services"}>{isHost ? "Back to hosts" : "Back to services"}</a>
          </Button>
        }
      />
    </section>
  );
}

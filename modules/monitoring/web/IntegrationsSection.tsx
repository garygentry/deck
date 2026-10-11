import type { Integration } from "@deck/schema";
import type { JSX } from "react";
import { CardGrid, LoadingState, Section, VisuallyHidden } from "@/ui";

import { IntegrationCard, type LiveStatus } from "./IntegrationCard.js";
import { NotConfiguredNotice } from "./SectionNotice.js";
import type { AlertmanagerData } from "./useAlertmanagerData.js";
import type { PrometheusData } from "./usePrometheusData.js";

export interface IntegrationsSectionProps {
  /** All estate-declared integrations (may be empty). */
  integrations: Integration[];
  /** True while config has not yet resolved — drives a pending render. */
  configLoading: boolean;
  /** Shared alertmanager view — the same data the header uses; NO new endpoint. */
  alertmanager: AlertmanagerData;
  /** Shared prometheus view — same data as the header. */
  prometheus: PrometheusData;
}

/**
 * Render one deep-link tile per integration, grouped by kind (groups sorted alphabetically, tiles
 * within a group in declaration order). Only the first integration of a matching provider kind
 * carries live status — a second same-kind tile is a plain deep-link, mirroring the single provider
 * bound to the first matching integration server-side.
 */
export function IntegrationsSection(props: IntegrationsSectionProps): JSX.Element {
  const { integrations, configLoading, alertmanager, prometheus } = props;

  if (configLoading) {
    return (
      <Section id="integrations" title="Integrations">
        <LoadingState label="Loading integrations…" rows={2} />
      </Section>
    );
  }

  if (integrations.length === 0) {
    return (
      <Section id="integrations" title="Integrations" data-state="empty">
        <NotConfiguredNotice>No integrations configured.</NotConfiguredNotice>
      </Section>
    );
  }

  const byKind = new Map<string, Integration[]>();
  for (const integ of integrations) {
    const list = byKind.get(integ.kind) ?? [];
    list.push(integ);
    byKind.set(integ.kind, list);
  }
  const kinds = [...byKind.keys()].sort();

  // Only these in-deck provider kinds back a live status; everything else is a plain deep-link.
  const liveFor = (kind: string): LiveStatus => {
    if (kind === "alertmanager") return { kind: "alertmanager", view: alertmanager };
    if (kind === "prometheus") return { kind: "prometheus", view: prometheus };
    return null;
  };

  return (
    <Section id="integrations" title="Integrations">
      <div className="flex flex-col gap-5">
        {kinds.map((kind) => (
          <CardGrid
            key={kind}
            level={3}
            heading={
              <>
                {kind}
                <VisuallyHidden> integrations</VisuallyHidden>
              </>
            }
          >
            {(byKind.get(kind) ?? []).map((integ, indexInKind) => (
              <IntegrationCard
                key={integ.id}
                integration={integ}
                live={indexInKind === 0 ? liveFor(kind) : null}
              />
            ))}
          </CardGrid>
        ))}
      </div>
    </Section>
  );
}

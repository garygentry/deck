import type { Integration } from "@deck/schema";
import { useRef, type FunctionComponent } from "react";
import { PageHeader, useListNavigation, usePageHeadingId, useScrollToHash } from "@/ui";

import { useConfig } from "../../data/index.js";
import { AlertsSection } from "./AlertsSection.js";
import { IntegrationsSection } from "./IntegrationsSection.js";
import { MetricsSection } from "./MetricsSection.js";
import { useAlertmanagerData } from "./useAlertmanagerData.js";
import { usePrometheusData } from "./usePrometheusData.js";

const PAGE_TITLE = "Monitoring";

/**
 * The page's keyboard-navigation targets, in visual order: the linkable alert rows (firing groups in
 * severity order, then the suppressed group), then the integration tiles (kind groups sorted
 * alphabetically). Display-only alerts (no source URL) are not links, so they are skipped.
 */
const NAV_ITEMS = '#alerts [data-slot="list-item"] a[href], #integrations a[data-slot="link-tile"]';

/**
 * The `/monitoring` page. Reads the two provider hooks and `useConfig()`, then composes the three
 * sections in fixed order. Each section receives only its own hook view, so a stalled provider never
 * blocks a sibling from resolving. j/k/Home/End/G/gg/Enter move real focus over the alert rows and
 * integration tiles (`useListNavigation`, which ignores keys typed into editable controls).
 */
export const MonitoringPage: FunctionComponent = () => {
  const alertmanager = useAlertmanagerData();
  const prometheus = usePrometheusData();
  const config = useConfig();
  const integrations: Integration[] =
    config.status === "ready" ? config.config.integrations ?? [] : [];
  const headingId = usePageHeadingId(PAGE_TITLE);

  // /monitoring#alerts and #metrics (the health-header links) land on their section.
  useScrollToHash();

  const rootRef = useRef<HTMLElement>(null);
  useListNavigation({
    getItems: () => rootRef.current?.querySelectorAll<HTMLElement>(NAV_ITEMS) ?? [],
  });

  return (
    <section
      data-slot="monitoring-page"
      data-testid="monitoring"
      aria-labelledby={headingId}
      ref={rootRef}
      className="flex flex-col gap-8"
    >
      <PageHeader title={PAGE_TITLE} />
      <AlertsSection view={alertmanager} />
      <MetricsSection view={prometheus} />
      <IntegrationsSection
        integrations={integrations}
        configLoading={config.status === "loading"}
        alertmanager={alertmanager}
        prometheus={prometheus}
      />
    </section>
  );
};

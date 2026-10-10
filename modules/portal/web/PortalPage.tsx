import { PORTAL_UI } from "@deck/contract/modules/portal";
import type { FunctionComponent } from "react";
import { PageHeader, usePageHeadingId } from "@/ui";
import { PageLayoutSections, usePageLayout } from "@/shell/config-page/layout.js";

/** The portal's page, whose default dashboard its manifest declares. */
const PORTAL_PAGE = PORTAL_UI.contributes!.pages![0]!;

/**
 * The portal page: a dashboard. Its layout comes from the UI manifest (the portal's declared
 * one with overrides applied): the `portal/summary` slot's cards, then the `portal/groups`
 * widget as the page's own list, without card chrome. Before the manifest loads, or when it
 * cannot be read, the declared layout renders.
 */
export const PortalPage: FunctionComponent = () => {
  const headingId = usePageHeadingId("Portal");
  const layout = usePageLayout(PORTAL_PAGE);
  return (
    <section
      data-slot="portal-page"
      data-testid="portal"
      aria-labelledby={headingId}
      className="flex flex-col gap-6"
    >
      <PageHeader title="Portal" />
      <PageLayoutSections layout={layout} placement="page" />
    </section>
  );
};

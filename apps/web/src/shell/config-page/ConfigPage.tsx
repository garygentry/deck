import type { UiPage, UiWidgetSection } from "@deck/module-sdk";
import { PageHeader, Section, cn } from "@/ui";

import { WidgetHost } from "./WidgetHost.js";

// Static class maps (Tailwind sees every class literally): one column below `md`.
const GRID_COLUMNS: Record<UiWidgetSection["columns"], string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
};

/**
 * A config page (`ui.pages`): its title as the page's one `h1`, then each section as an `h2`
 * over a grid of its widgets. Widgets flow in config order, which is also DOM and reading
 * order: the grid never reorders them (no dense packing). A config page's sections are all
 * titled widget sections (the routes take no other).
 */
export function ConfigPage({ page }: { page: UiPage }) {
  const sections = (page.layout?.sections ?? []) as UiWidgetSection[];
  return (
    <div data-slot="config-page" data-page-id={page.id} className="flex flex-col gap-6">
      <PageHeader title={page.title} />
      {sections.map((section, index) => (
        <Section key={index} title={section.title}>
          <div
            data-slot="widget-grid"
            data-columns={section.columns}
            className={cn("grid grid-cols-1 gap-4 md:auto-rows-[minmax(8rem,auto)]", GRID_COLUMNS[section.columns])}
          >
            {section.widgets.map((widget) => (
              <WidgetHost key={widget.id} widget={widget} />
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

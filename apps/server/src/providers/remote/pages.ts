import { REMOTE_MODULE, type JsonValue } from "@deck/module-sdk";

import type { ConfigSection, ConfigWidget } from "../../ui/config-pages.js";
import type { RuntimePages } from "../../ui/runtime-pages.js";
import { REMOTE_LINKS_WIDGET } from "./describe.js";
import type { RemoteContribution } from "./directory.js";

/** What the page shows while its sidecar contributes nothing (or has not described itself yet). */
const WAITING = "This sidecar has not described any widgets yet.";

/**
 * The remote integrations' pages, as config pages of module `remote` (`page:remote/<id>`):
 * one section of the sidecar's widgets (each reading that integration, never another
 * provider), then its links as a full-width `core/link-tiles`, or a placeholder until it
 * describes any. Its nav entries join the page's own sidebar group, so they are listed only when
 * the integration gives its page a sidebar entry. Each describe problem or note is a finding.
 */
export function remotePagesOf(contributions: readonly RemoteContribution[]): RuntimePages {
  const result: RuntimePages = { pages: [], nav: [], findings: [] };
  for (const contribution of contributions) {
    const { instance, page, describe } = contribution;
    const pageId = `page:${REMOTE_MODULE}/${instance}`;
    const title = describe?.title ?? contribution.title;
    const columns = describe?.columns ?? 1;
    const widgets: ConfigWidget[] = (describe?.widgets ?? []).map((widget) => ({ ...structuredClone(widget), source: instance }));
    if (describe !== undefined && describe.links.length > 0) {
      widgets.push({
        id: REMOTE_LINKS_WIDGET,
        type: "core/link-tiles",
        title: "Links",
        span: columns,
        options: { links: structuredClone(describe.links) as unknown as JsonValue[] },
      });
    }
    const waiting = widgets.length === 0;
    if (waiting) widgets.push({ id: "waiting", type: "core/markdown", options: { content: WAITING } });
    const sections: ConfigSection[] = [{ title, columns: waiting ? 1 : columns, widgets }];
    result.pages.push({
      module: REMOTE_MODULE,
      id: instance,
      path: page.path,
      title: contribution.title,
      ...(page.icon === undefined ? {} : { icon: page.icon }),
      ...(page.nav === undefined ? {} : { nav: structuredClone(page.nav) }),
      sections,
    });

    const navEntries = describe?.nav ?? [];
    if (navEntries.length > 0 && page.nav === undefined) {
      result.findings.push({
        code: "REMOTE_NAV_UNPLACED",
        severity: "info",
        message: `remote integration "${instance}" describes ${navEntries.length} nav entries, which show only when its page has a sidebar entry (page.nav)`,
        id: pageId,
      });
    }
    if (page.nav !== undefined) {
      const { group, order } = page.nav;
      for (const entry of navEntries) {
        const navOrder = entry.order ?? order;
        result.nav.push({
          id: `nav:${REMOTE_MODULE}/${instance}.${entry.id}`,
          module: REMOTE_MODULE,
          href: entry.href,
          group,
          label: entry.label,
          ...(entry.icon === undefined ? {} : { icon: entry.icon }),
          ...(navOrder === undefined ? {} : { order: navOrder }),
        });
      }
    }

    if (contribution.problem !== undefined) {
      result.findings.push({
        code: contribution.problem.code,
        severity: "warning",
        message: `remote integration "${instance}": ${contribution.problem.message}${describe === undefined ? "" : "; its last good describe still renders"}`,
        id: pageId,
      });
    }
    for (const note of contribution.notes ?? []) {
      result.findings.push({ code: "REMOTE_DESCRIBE_ID_MISMATCH", severity: "info", message: `remote integration "${instance}": ${note}`, id: pageId });
    }
  }
  return result;
}

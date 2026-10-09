// The web half of a runtime module: native ESM with no build step. `react/jsx-runtime` and
// `@deck/sdk` resolve through the page's import map to deck's own copies, so these components
// share deck's React, data cache and look. The manifest is the module's own deck-module.json
// (a JSON module import), which must match what the server loaded.
import { jsx, jsxs } from "react/jsx-runtime";
import {
  defineWebModule,
  EmptyState,
  HealthPill,
  KeyValueList,
  LoadingState,
  formatTimestamp,
  PageHeader,
  Section,
  StatusBadge,
  useProvider,
} from "@deck/sdk";
import manifest from "./deck-module.json" with { type: "json" };

/** The `maintenance` provider's data: the window in progress and the next one, if any. */
function useWindows() {
  const { envelope, loading } = useProvider("maintenance");
  return { data: envelope?.data ?? null, loading };
}

/** A window's name, with when it starts (or ends), in the viewer's time zone. */
function windowValue(window, edge) {
  return jsxs("span", {
    children: [window.name, " ", jsx("span", { className: "maintenance-when", children: `${edge === "end" ? "ends" : "starts"} ${formatTimestamp(window[edge])}` })],
  });
}

function MaintenancePage() {
  const { data, loading } = useWindows();
  const header = jsx(PageHeader, { title: "Maintenance", description: "Planned maintenance windows for this estate." });
  if (loading) return jsxs("div", { "data-slot": "maintenance-page", children: [header, jsx(LoadingState, { label: "Loading windows…" })] });
  if (data === null || data.count === 0) {
    return jsxs("div", { "data-slot": "maintenance-page", children: [header, jsx(EmptyState, { icon: "calendar-clock", title: "No maintenance windows", description: "Add windows under modules.maintenance in the estate config." })] });
  }
  return jsxs("div", {
    "data-slot": "maintenance-page",
    children: [
      header,
      jsx(Section, {
        title: "Now",
        children: jsx(KeyValueList, {
          items: [
            {
              label: "Status",
              value: data.active
                ? jsx(StatusBadge, { tone: "warn", icon: "maintenance/wrench", label: "In maintenance" })
                : jsx(StatusBadge, { tone: "ok", icon: "circle-check", label: "No window in progress" }),
            },
            { label: "In progress", value: data.active ? windowValue(data.active, "end") : "None" },
            { label: "Next window", value: data.next ? windowValue(data.next, "start") : "None planned" },
            { label: "Windows", value: String(data.count) },
          ],
        }),
      }),
    ],
  });
}

function MaintenancePill() {
  const { data } = useWindows();
  if (data === null) return null;
  return jsx(HealthPill, {
    tone: data.active ? "warn" : "ok",
    icon: "maintenance/wrench",
    label: data.active ? "In maintenance" : "Maintenance",
    href: "/maintenance",
  });
}

export default defineWebModule(manifest, { components: { MaintenancePage, MaintenancePill } });

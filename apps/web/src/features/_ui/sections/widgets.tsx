import type { StatusMapData, UiWidgetInstance } from "@deck/module-sdk";
import { Suspense, type ComponentType } from "react";
import { LoadingState, Section } from "@/ui";
import type { WidgetProps } from "../../../registry/registry.js";
import { coreWidgetsWebModule } from "../../core-widgets/index.js";
import { StatusMapsOverride } from "../../core-widgets/status-maps.js";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

// Fixed data only: the workbench is snapshotted, so nothing here may vary per render.
const STATUS_MAPS: Record<string, StatusMapData> = {
  load: { rules: [{ lt: 60, tone: "ok" }, { lt: 85, tone: "warn" }, { tone: "danger" }] },
  battery: { rules: [{ lte: 20, tone: "danger" }, { lte: 50, tone: "warn" }, { tone: "ok" }] },
  state: { values: { running: "ok", degraded: "warn", stopped: "danger", starting: "pending", unknown: "neutral" } },
  outlet: { values: { on: "ok", off: "neutral", fault: "danger" } },
};

const UPS = { load_pct: 42, battery_pct: 87, runtime_s: 5_460, input_v: 231.4, model: "Eaton 5P", on_battery: false };
const OUTLETS = [
  { name: "nas-01", watts: 61.5, state: "on" },
  { name: "switch", watts: 14, state: "on" },
  { name: "lab-pi", watts: 0, state: "off" },
  { name: "printer", watts: 0, state: "fault" },
];
const SERVICES = [
  { name: "media", status: "running", host: "nas-01", url: "/services/nas-01/media" },
  { name: "backup", status: "degraded", host: "nas-01" },
  { name: "dns", status: "running", host: "edge" },
  { name: "metrics", status: "starting", host: "edge" },
  { name: "printer", status: "stopped", host: "lab-pi" },
];
const MARKDOWN = "**On call:** check the UPS before patching.\n\n- Runbook: [patching](/docs)\n- Vendor: [support](https://vendor.example)";

// Each widget's options are checked by its type's schema; the demos pass them as plain objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the table holds every widget's own options type
const COMPONENTS = coreWidgetsWebModule.components as unknown as Record<string, ComponentType<WidgetProps<any>>>;

function instance(type: string, title: string, options: Record<string, unknown>): UiWidgetInstance {
  return { id: `widget:ui/workbench.${type.slice(5)}`, type, title, source: null, options: options as UiWidgetInstance["options"], span: 1, rows: 1 };
}

/** One widget as a config page frames it: a card titled by the widget, over its type's component. */
function Demo({ component, type, title, value, options = {} }: { component: string; type: string; title: string; value: unknown; options?: Record<string, unknown> }) {
  const Widget = COMPONENTS[component]!;
  return (
    <Section variant="card" level={3} title={title} className="w-full max-w-md">
      {/* As WidgetHost does: core/table and core/markdown load on first use. */}
      <Suspense fallback={<LoadingState label="Loading widget…" preset="lines" rows={2} />}>
        <Widget value={value} options={options} freshness={null} widget={instance(type, title, options)} />
      </Suspense>
    </Section>
  );
}

function Widgets() {
  return (
    <StatusMapsOverride.Provider value={STATUS_MAPS}>
      <Specimen label="core/stat — a number toned by a rule map; text untoned">
        <Demo component="StatWidget" type="core/stat" title="UPS load" value={UPS.load_pct} options={{ format: "percent", statusMap: "load" }} />
        <Demo component="StatWidget" type="core/stat" title="Model" value={UPS.model} />
      </Specimen>
      <Specimen label="core/stat-grid — chosen fields with formats">
        <Demo
          component="StatGridWidget"
          type="core/stat-grid"
          title="Power"
          value={UPS}
          options={{ items: [{ field: "load_pct", label: "Load", format: "percent", statusMap: "load" }, { field: "runtime_s", label: "Runtime", format: "duration" }, { field: "input_v", label: "Input", unit: "V" }] }}
        />
      </Specimen>
      <Specimen label="core/meter — toned; formatted value text">
        <Demo component="MeterWidget" type="core/meter" title="Battery" value={UPS.battery_pct} options={{ label: "Battery", statusMap: "battery" }} />
        <Demo component="MeterWidget" type="core/meter" title="Load" value={93} options={{ label: "Load", statusMap: "load", format: "percent" }} />
      </Specimen>
      <Specimen label="core/key-value — every key; a status-mapped field as a badge">
        <Demo component="KeyValueWidget" type="core/key-value" title="UPS" value={UPS} />
        <Demo
          component="KeyValueWidget"
          type="core/key-value"
          title="Outlet"
          value={OUTLETS[3]}
          options={{ items: [{ field: "name", label: "Outlet" }, { field: "state", label: "State", statusMap: "outlet" }, { field: "watts", label: "Draw", unit: "W" }] }}
        />
      </Specimen>
      <Specimen label="core/list — title, description, status badge, link">
        <Demo component="ListWidget" type="core/list" title="Services" value={SERVICES} options={{ descriptionField: "host", statusField: "status", statusMap: "state", hrefField: "url", limit: 4 }} />
      </Specimen>
      <Specimen label="core/table — column descriptors (format, align, statusMap)">
        <Demo
          component="TableWidget"
          type="core/table"
          title="Outlets"
          value={OUTLETS}
          options={{ columns: [{ field: "name", header: "Outlet" }, { field: "watts", header: "Draw", format: "number", unit: "W", align: "end" }, { field: "state", header: "State", statusMap: "outlet" }] }}
        />
      </Specimen>
      <Specimen label="core/status-grid — named states as tiles">
        <Demo component="StatusGridWidget" type="core/status-grid" title="Service states" value={SERVICES} options={{ statusMap: "state" }} />
      </Specimen>
      <Specimen label="core/link-tiles — in-app and external links">
        <Demo
          component="LinkTilesWidget"
          type="core/link-tiles"
          title="Shortcuts"
          value={null}
          options={{ links: [{ title: "Hosts", href: "/hosts", icon: "server", description: "Declared and observed hosts" }, { title: "Vendor status", href: "https://status.example", description: "Opens in a new tab" }] }}
        />
      </Specimen>
      <Specimen label="core/markdown — sanitised markdown">
        <Demo component="MarkdownWidget" type="core/markdown" title="Notes" value={null} options={{ content: MARKDOWN }} />
      </Specimen>
      <Specimen label="core/health-pills — the top bar's pills">
        <Demo component="HealthPillsWidget" type="core/health-pills" title="Health" value={null} />
      </Specimen>
      <Specimen label="Unexpected data — a value the type cannot show">
        <Demo component="StatWidget" type="core/stat" title="Wrong select" value={OUTLETS} />
      </Specimen>
    </StatusMapsOverride.Provider>
  );
}

export const widgets: WorkbenchSectionDef = {
  id: "widgets",
  title: "Dashboard widgets",
  catalogue: "H",
  Demo: Widgets,
};

import type { FindingCode } from "../../findings.js";
import type { InvalidFixture, JsonObject } from "../../types.js";

const config = (extra: JsonObject = {}): JsonObject => ({
  schemaVersion: 2,
  estate: { name: "invalid-fixture" },
  ...extra,
});

const snapshot = (extra: JsonObject = {}): JsonObject => ({
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});

/** Central population table; the sibling modules make every catalog entry independently importable. */
export function fixtureFor(expect: FindingCode): InvalidFixture {
  const common = { name: expect.toLowerCase().replaceAll("_", "-"), expect } as const;
  switch (expect) {
    case "VERSION_UNSUPPORTED": return { ...common, layer: "merged", document: { schemaVersion: 3 } };
    case "SCHEMA_INVALID": return { ...common, layer: "merged", document: config({ estate: { name: 7 } }) };
    case "SCHEMA_UNKNOWN_PROPERTY": return { ...common, layer: "merged", document: config({ surprise: true }) };
    case "SCHEMA_REQUIRED_MISSING": return { ...common, layer: "merged", document: { schemaVersion: 2 } };
    case "HOST_DUPLICATE": return { ...common, layer: "merged", document: config({ hosts: [host("echo"), host("echo")] }) };
    case "SERVICE_DUPLICATE": return { ...common, layer: "merged", document: config({ hosts: [host("echo")], services: [service("echo", "pulse"), service("echo", "pulse")] }) };
    case "ID_DUPLICATE": return { ...common, layer: "merged", document: config(portal([group("same"), group("same")])) };
    case "PROVIDER_ID_SHARED": return { ...common, layer: "merged", document: config({ hosts: [{ ...host("echo"), bindings: { "http-health": { id: "probe", url: "https://echo.invalid" } } }, { ...host("delta"), bindings: { "http-health": { id: "probe", url: "https://delta.invalid" } } }] }) };
    case "REF_HOST_UNRESOLVED": return { ...common, layer: "merged", document: config({ services: [service("absent", "pulse")] }) };
    case "REF_SERVICE_UNRESOLVED": return { ...common, layer: "merged", document: config(portal([{ id: "links", title: "Links", items: [{ type: "service", host: "absent", name: "pulse" }] }])) };
    case "LAYER_OVERLAY_KEY_IN_BASE": return { ...common, layer: "base", document: config(portal([group("layout")])) };
    case "LAYER_BASE_KEY_IN_OVERLAY": return { ...common, layer: "overlay", document: { schemaVersion: 2, hosts: [host("echo")] } };
    case "OVERLAY_DANGLING_REF": return { ...common, layer: "overlay", base: config(), document: { schemaVersion: 2, ...portal([{ id: "layout", title: "Layout", items: [{ type: "service", host: "absent", name: "pulse" }] }]) } };
    case "MODULE_UNKNOWN": return { ...common, layer: "merged", document: config({ modules: { "no-such-module": {} } }) };
    case "PROVIDER_BINDING_UNSUPPORTED": return {
      ...common,
      layer: "merged",
      contributions: [{ id: "fixture-feed", providerKinds: [{ kind: "fixture-feed" }] }],
      document: config({ hosts: [{ ...host("echo"), bindings: { "fixture-feed": { channel: "alpha" } } }] }),
    };
    case "PROVIDER_KIND_DISABLED": return {
      ...common,
      layer: "merged",
      disabledSections: "strict",
      contributions: [{ id: "fixture-feed", disabled: "not enabled: switched off", providerKinds: [{ kind: "fixture-feed" }] }],
      document: config({ integrations: [{ id: "feed", kind: "fixture-feed", title: "Feed", baseUrl: "https://feed.invalid" }] }),
    };
    case "PROVIDER_KIND_UNKNOWN": return { ...common, layer: "merged", document: config({ integrations: [{ id: "odd", kind: "mystery-kind", title: "Odd", baseUrl: "https://odd.invalid" }] }) };
    case "UI_WIDGET_TYPE_UNKNOWN": return { ...common, layer: "merged", document: config(dashboard({ type: "nobody/gauge" })) };
    case "UI_WIDGET_TYPE_DISABLED": return {
      ...common,
      layer: "merged",
      disabledSections: "strict",
      contributions: [{ id: "fixture-feed", disabled: "not enabled: switched off", widgetTypes: [{ type: "fixture-feed/gauge" }] }],
      document: config(dashboard({ type: "fixture-feed/gauge" })),
    };
    case "UI_STATUS_MAP_UNKNOWN": return { ...common, layer: "merged", document: config(dashboard({ type: "core/stat", source: "feed", options: { statusMap: "ups-load" } })) };
    case "UI_EMBED_DISALLOWED": return { ...common, layer: "merged", document: config(dashboard({ type: "core/embed", options: { url: "https://grafana.invalid/d/ups" } })) };
    // Checked only when composition is given the select check (the server's is).
    case "UI_WIDGET_SELECT_INVALID": return {
      ...common,
      layer: "merged",
      contributions: [{ id: "fixture-feed", widgetTypes: [{ type: "fixture-feed/gauge" }] }],
      document: config(dashboard({ type: "fixture-feed/gauge", source: "feed", select: "load[" })),
    };
    case "SECRET_VALUE_SUSPECTED": return { ...common, layer: "merged", document: config({ estate: { name: "invalid-fixture", domains: { password: "not a reference value" } } }) };
    case "SNAPSHOT_HOST_DUPLICATE": return { ...common, layer: "snapshot", document: snapshot({ hosts: [observedHost("echo"), observedHost("echo")] }) };
    case "SNAPSHOT_SERVICE_DUPLICATE": return { ...common, layer: "snapshot", document: snapshot({ services: [observedService("echo", "pulse"), observedService("echo", "pulse")] }) };
    case "DRIFT_ID_DUPLICATE": return { ...common, layer: "snapshot", document: snapshot({ drift: [drift("same", "echo"), drift("same", "echo")] }) };
    case "SNAPSHOT_HOST_UNDECLARED": return { ...common, layer: "snapshot", config: config(), document: snapshot({ hosts: [observedHost("absent")] }) };
    case "SNAPSHOT_SERVICE_UNDECLARED": return { ...common, layer: "snapshot", config: config({ hosts: [host("echo")] }), document: snapshot({ hosts: [observedHost("echo")], services: [observedService("echo", "absent")] }) };
    case "DRIFT_LOCATION_UNRESOLVED": return { ...common, layer: "snapshot", config: config(), document: snapshot({ drift: [drift("drift-one", "absent")] }) };
    case "HOST_NOT_COLLECTED": return { ...common, layer: "snapshot", config: config({ hosts: [host("echo")] }), document: snapshot() };
  }
}

function dashboard(widget: JsonObject): JsonObject {
  return { ui: { pages: [{ id: "lab", path: "/lab", title: "Lab", sections: [{ title: "Power", widgets: [widget] }] }] } };
}
function host(name: string): JsonObject { return { name, kind: "vm", purpose: "Invalid fixture host" }; }
function service(hostName: string, name: string): JsonObject { return { host: hostName, name, kind: "systemd", purpose: "Invalid fixture service" }; }
function group(id: string): JsonObject { return { id, title: "Fixture group", items: [] }; }
function portal(groups: JsonObject[]): JsonObject { return { modules: { portal: { groups } } }; }
function observedHost(name: string): JsonObject { return { name, coverage: "collected", collectedAt: "2026-01-01T00:00:00Z" }; }
function observedService(hostName: string, name: string): JsonObject { return { host: hostName, name, state: "running" }; }
function drift(id: string, hostName: string): JsonObject { return { id, severity: "warning", location: { host: hostName }, category: "fixture", message: "Invented drift" }; }

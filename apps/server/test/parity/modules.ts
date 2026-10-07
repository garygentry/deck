/**
 * What the goldens, frozen before any feature was a module, gain from the built-in modules
 * now registered. These additions, and nothing else, are applied to a frozen golden:
 *
 * - `/api/health`: `modules["llm-usage"]`, since health lists every known module's state by
 *   id beside the fields it always had. With a `llmUsage` health field in the golden, the entry
 *   is `{state, data}` with `data` equal to that field (`state` is `degraded` while
 *   `consecutiveErrors > 0`, else `ok`); without one, `{state: "ok", detail: "not configured"}`.
 * - the route table: the module's sub-app at `/api/m/llm-usage` plus its catch-all
 *   request-scope middleware at the module prefix and at the legacy alias:
 *   `ALL /api/llm-usage/*`, `ALL /api/m/llm-usage/*`, `GET /api/m/llm-usage`,
 *   `GET /api/m/llm-usage/refresh`, and `POST /api/m/llm-usage/ingest ×3` exactly when the
 *   golden has `POST /api/llm-usage/ingest ×3`.
 *
 * - `/api/health`: `modules.{alertmanager,docker,gatus,http-health,link,prometheus,snapshot}`: `{state: "ok"}` when the
 *   golden's provider health lists a provider of that kind, else
 *   `{state: "ok", detail: "not configured"}`. The data-source modules have no routes and
 *   report no health of their own.
 *
 * The legacy `/api/llm-usage` routes, their bodies and `/api/health.llmUsage` are compared
 * unchanged.
 *
 * The kernel's UI manifest route, `GET /api/ui`, also joins the route table. Its body has its
 * own golden (`test/ui-golden.test.ts`).
 *
 * The actions module (switched on by `DECK_ACTIONS_ENABLED`, which a golden shows as
 * `actions.body.enabled`) adds:
 * - `/api/health`: `modules.actions`, `{state: "ok"}` when on, else
 *   `{state: "disabled", detail: "not enabled: DECK_ACTIONS_ENABLED is not true"}`;
 * - the route table: its five routes again under `/api/m/actions` (served switched off too,
 *   as the declared fixed answers), plus, when on, the request-scope middleware
 *   `ALL /api/actions/*` and `ALL /api/m/actions/*`;
 * - `deck validate`, for an estate with a `modules.actions` section while the module is off:
 *   one info finding, MODULE_SECTION_DISABLED at `/modules/actions`, so a clean `clean` line
 *   becomes `clean (advisory only)`.
 *
 * The `/api/actions` bodies (capability, refusals, audit) and route lines compare unchanged.
 *
 * The `prometheus`, `alertmanager` and `snapshot` data-source modules declare their kinds not bindable, so
 * `deck validate` reports each host or service binding of either as one info finding,
 * PROVIDER_BINDING_UNSUPPORTED, for the layer that carries it and again for the merged document
 * (bindings are overlay-owned, and the frozen estates carry them in one overlay layer). Those
 * lines come first, and a `clean` line becomes `clean (advisory only)`.
 *
 * The route-less feature modules `drift`, `inventory`, `monitoring` and `portal` (always on,
 * with no health reporter) add:
 * - `/api/health`: `modules.<id>`, `{state: "ok"}`, the host's default entry;
 * - no route-table lines: the host mounts a module's request scope only when it registers a
 *   route, as for the data-source modules.
 *
 * The metrics module (switched on by `DECK_METRICS_ENABLED`, which a golden shows as its
 * `GET /metrics` route line) adds:
 * - `/api/health`: `modules.metrics`, `{state: "ok"}` when on (no reporter), else
 *   `{state: "disabled", detail: "not enabled: DECK_METRICS_ENABLED is not true"}`;
 * - the route table: when on, its root route replaces the kernel's `GET /metrics` with
 *   `ALL /metrics`, since the host mounts a root route for every method. The handler answers
 *   anything but GET and HEAD with the same plain 404 an unserved path gets, so what each
 *   method receives is unchanged (`test/metrics.test.ts` pins it).
 *
 * The source modules add:
 * - `/api/health`: `modules.{markdown-tree,file-tree}` as for the other data-source modules,
 *   and `modules.sources`, `{state: "ok"}` (always on, no reporter);
 * - the route table: the sources module's four routes under `/api/m/sources` plus its
 *   request-scope middleware `ALL /api/sources/*` and `ALL /api/m/sources/*`. The
 *   `/api/sources/:id/*` lines, now its legacy alias, compare unchanged;
 * - `deck validate`, for the primary schema fixture, which binds `markdown-tree` (service
 *   lumen) and `file-tree` (service quill): a source is owned, not bound, so these kinds are
 *   not bindable, and each binding deck used to ignore silently is now reported as
 *   PROVIDER_BINDING_UNSUPPORTED (info). It is reported for the overlay layer (services 2 and
 *   3), after that layer's other unsupported bindings, and for the merged document (services 3
 *   and 7), after the merged document's other findings.
 */

/** Data-source modules: health `{state: "ok"}` (no reporter), and no routes mounted. */
const DATA_SOURCE_MODULES = ["alertmanager", "docker", "file-tree", "gatus", "http-health", "link", "markdown-tree", "prometheus", "snapshot"];

const SOURCES_ROUTES = [
  "ALL /api/m/sources/*",
  "ALL /api/sources/*",
  "GET /api/m/sources/:id/file",
  "GET /api/m/sources/:id/raw",
  "GET /api/m/sources/:id/search",
  "GET /api/m/sources/:id/tree",
];
const bindingUnsupported = (index: number, kind: string) =>
  `info  /services/${index}/bindings/${kind}  PROVIDER_BINDING_UNSUPPORTED  provider kind '${kind}' does not accept host or service bindings`;
/** The primary schema fixture's source-kind bindings, by layer then merged document. */
const PRIMARY_SOURCE_BINDINGS = {
  overlay: [bindingUnsupported(2, "markdown-tree"), bindingUnsupported(3, "file-tree")],
  merged: [bindingUnsupported(3, "markdown-tree"), bindingUnsupported(7, "file-tree")],
};

const LLM_USAGE_ROUTES = [
  "ALL /api/llm-usage/*",
  "ALL /api/m/llm-usage/*",
  "GET /api/m/llm-usage",
  "GET /api/m/llm-usage/refresh",
];
const UI_MANIFEST_ROUTE = "GET /api/ui";
const LEGACY_INGEST = "POST /api/llm-usage/ingest ×3";

const ACTIONS_ROUTES = [
  "GET /api/m/actions",
  "GET /api/m/actions/audit",
  "GET /api/m/actions/audit/:runId",
  "POST /api/m/actions/:id",
  "POST /api/m/actions/runs/:runId/cancel",
];
const ACTIONS_SCOPE_ROUTES = ["ALL /api/actions/*", "ALL /api/m/actions/*"];
const ACTIONS_OFF = "not enabled: DECK_ACTIONS_ENABLED is not true";
const ACTIONS_SECTION_DISABLED = `info  /modules/actions  MODULE_SECTION_DISABLED  modules.actions is set, but module "actions" is not enabled (${ACTIONS_OFF}); the section is ignored.`;
const MODULE_INGEST = "POST /api/m/llm-usage/ingest ×3";
const FEATURE_MODULES = ["drift", "inventory", "monitoring", "portal", "sources"];

const KERNEL_METRICS_ROUTE = "GET /metrics";
const METRICS_ROOT_ROUTE = "ALL /metrics";
const METRICS_OFF = "not enabled: DECK_METRICS_ENABLED is not true";

/** Apply the built-in modules' additions to one (already v1 → v2 remapped) golden projection. */
export function withBuiltinModules(golden: unknown): unknown {
  if (!isObject(golden)) return golden;
  const result: Record<string, unknown> = { ...golden };
  const actionsOn = isObject(result.actions) && isObject(result.actions.body) && result.actions.body.enabled === true;
  const metricsOn = Array.isArray(result.routes) && result.routes.includes(KERNEL_METRICS_ROUTE);
  const on = { actions: actionsOn, metrics: metricsOn };
  if (isObject(result.health)) result.health = withModuleHealth(result.health, on);
  if (isObject(result.transitions) && isObject(result.transitions.afterOutage) && isObject(result.transitions.afterOutage.health)) {
    result.transitions = {
      ...result.transitions,
      afterOutage: { ...result.transitions.afterOutage, health: withModuleHealth(result.transitions.afterOutage.health, on) },
    };
  }
  if (Array.isArray(result.routes)) {
    const routes = result.routes as string[];
    result.routes = [
      ...routes.map((route) => (route === KERNEL_METRICS_ROUTE ? METRICS_ROOT_ROUTE : route)),
      UI_MANIFEST_ROUTE,
      ...LLM_USAGE_ROUTES,
      ...(routes.includes(LEGACY_INGEST) ? [MODULE_INGEST] : []),
      ...ACTIONS_ROUTES,
      ...(actionsOn ? ACTIONS_SCOPE_ROUTES : []),
      ...SOURCES_ROUTES,
    ].sort();
  }
  const config = isObject(result.config) && isObject(result.config.body) ? result.config.body : undefined;
  const hasActionsSection = isObject(config?.modules) && config.modules.actions !== undefined;
  if (hasActionsSection && !actionsOn && isObject(result.validate) && result.validate.stdout === "clean\n") {
    result.validate = { ...result.validate, stdout: `${ACTIONS_SECTION_DISABLED}\nclean (advisory only)\n` };
  }
  // Bindings of kinds that accept none are reported for the overlay layer, then for the merged
  // document (whose other findings sit between). The primary fixture's source-kind bindings
  // sit at other service indices in each, so they come from PRIMARY_SOURCE_BINDINGS.
  const unsupported = config === undefined ? [] : unsupportedBindings(config);
  const sources = bindsSourceKinds(config) ? PRIMARY_SOURCE_BINDINGS : { overlay: [], merged: [] };
  if ((unsupported.length > 0 || sources.overlay.length > 0) && isObject(result.validate) && typeof result.validate.stdout === "string") {
    const lines = result.validate.stdout.split("\n").filter((line) => line !== "");
    const verdict = lines.pop()!.replace(/^clean$/, "clean (advisory only)");
    const stdout = [...unsupported, ...sources.overlay, ...unsupported, ...lines, ...sources.merged, verdict].join("\n");
    result.validate = { ...result.validate, stdout: `${stdout}\n` };
  }
  return result;
}

/** Kinds whose modules declare them not bindable. */
const NON_BINDABLE_KINDS = ["alertmanager", "prometheus", "snapshot"];

/** One PROVIDER_BINDING_UNSUPPORTED line per host, then service, binding of a non-bindable kind. */
function unsupportedBindings(config: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const list of ["hosts", "services"]) {
    const entries = Array.isArray(config[list]) ? (config[list] as unknown[]) : [];
    entries.forEach((entry, index) => {
      const bindings = isObject(entry) && isObject(entry.bindings) ? entry.bindings : {};
      for (const kind of Object.keys(bindings).filter((key) => NON_BINDABLE_KINDS.includes(key))) {
        lines.push(`info  /${list}/${index}/bindings/${kind}  PROVIDER_BINDING_UNSUPPORTED  provider kind '${kind}' does not accept host or service bindings`);
      }
    });
  }
  return lines;
}

/** Whether `config` is the primary schema fixture, with its source-kind service bindings. */
function bindsSourceKinds(config: Record<string, unknown> | undefined): boolean {
  const services = Array.isArray(config?.services) ? config.services.filter(isObject) : [];
  const bound = (name: string, kind: string) =>
    services.some((service) => service.name === name && isObject(service.bindings) && service.bindings[kind] !== undefined);
  return bound("lumen", "markdown-tree") && bound("quill", "file-tree");
}

function withModuleHealth(projection: Record<string, unknown>, on: { actions: boolean; metrics: boolean }): Record<string, unknown> {
  const body = projection.body;
  if (!isObject(body) || !isObject(body.modules)) return projection;
  const legacy = body.llmUsage;
  const entry = isObject(legacy)
    ? { state: (legacy.consecutiveErrors as number) > 0 ? "degraded" : "ok", data: legacy }
    : { state: "ok", detail: "not configured" };
  const providerKinds = new Set(
    Object.values(isObject(body.providers) ? body.providers : {}).map((entry) => (isObject(entry) ? entry.kind : undefined)),
  );
  const dataSources = Object.fromEntries(
    DATA_SOURCE_MODULES.map((id) => [id, providerKinds.has(id) ? { state: "ok" } : { state: "ok", detail: "not configured" }]),
  );
  const actions = on.actions ? { state: "ok" } : { state: "disabled", detail: ACTIONS_OFF };
  const metrics = on.metrics ? { state: "ok" } : { state: "disabled", detail: METRICS_OFF };
  const features = Object.fromEntries(FEATURE_MODULES.map((id) => [id, { state: "ok" }]));
  return { ...projection, body: { ...body, modules: { ...body.modules, actions, ...dataSources, "llm-usage": entry, metrics, ...features } } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

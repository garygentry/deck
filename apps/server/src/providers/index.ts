import type { DeckConfig, ProviderConfig } from "../contract/index.js";
import type { SourceStore } from "../sources/store.js";
import {
  GENERATED_PROVIDERS,
  registerAlertmanager,
  registerDocker,
  registerFileTree,
  registerGatus,
  registerHttpHealth,
  registerLink,
  registerMarkdownTree,
  registerPrometheus,
  registerSnapshot,
} from "./generated.js";
import type { HttpHealthConfig } from "./http-health/index.js";
import type { LinkDescriptor } from "./link/index.js";
import { parseSummaryCard } from "./prometheus/parse-card.js";
import { createSnapshotSource } from "./snapshot/source.js";

/** Immutable boot-only options outside the estate document. */
export interface ProviderRuntimeOptions {
  /** Single file path or HTTP(S) source; undefined means no snapshot provider. */
  readonly snapshotSource?: string;
  /**
   * Per-source read handles keyed by `Source.id`, built by `resolveSourcesRuntime` and
   * threaded from boot exactly as `snapshotSource` is. Consumed by the sources loop below so
   * `registerAllProviders` stays the single `register()` site. Absent ⇒ no source providers
   * registered (capability off / no sources declared).
   */
  readonly sourceStores?: ReadonlyMap<string, SourceStore>;
}

interface Registration {
  id: string;
  kind: string;
  order: number;
  register(): void;
}

type Binding = Record<string, unknown>;

function isObject(value: unknown): value is Binding {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timing(value: unknown): ProviderConfig | undefined {
  if (!isObject(value)) return undefined;
  return {
    ...(typeof value.pollIntervalMs === "number" ? { pollIntervalMs: value.pollIntervalMs } : {}),
    ...(typeof value.ttlMs === "number" ? { ttlMs: value.ttlMs } : {}),
    ...(typeof value.unreachableAfterMs === "number"
      ? { unreachableAfterMs: value.unreachableAfterMs }
      : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
}

function collectBinding(
  registrations: Registration[],
  ownerId: string,
  kind: string,
  raw: unknown,
  defaultOrder: number,
): void {
  if (!isObject(raw)) return;
  const id = typeof raw.id === "string" ? raw.id : `${kind}:${ownerId}`;
  const order = typeof raw.order === "number" ? raw.order : defaultOrder;

  if (kind === "link" && typeof raw.href === "string") {
    const descriptor: LinkDescriptor = {
      label: typeof raw.label === "string" ? raw.label : ownerId,
      href: raw.href,
      ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
    };
    registrations.push({ id, kind, order, register: () => registerLink(id, descriptor) });
  }

  if (kind === "http-health" && typeof raw.url === "string") {
    const resolvedTiming = timing(raw.timing);
    const config: HttpHealthConfig = {
      url: raw.url,
      ...(raw.method === "GET" || raw.method === "HEAD" ? { method: raw.method } : {}),
      ...(resolvedTiming ? { timing: resolvedTiming } : {}),
    };
    registrations.push({ id, kind, order, register: () => registerHttpHealth(id, config) });
  }
}

/**
 * Translate estate declarations into opaque provider configs, then register by (order, id).
 *
 * The optional runtime snapshot source is registered exactly once as id/kind `snapshot`,
 * outside the estate document. An absent `runtime.snapshotSource` leaves the pre-feature
 * registration set unchanged.
 *
 * @throws {SnapshotReadFailure} If a present source cannot be parsed into an allowed immutable
 * source. The raw source value is never logged.
 */
export function registerAllProviders(config: DeckConfig, runtime: ProviderRuntimeOptions = {}): void {
  const registrations: Registration[] = [];
  const available = new Map(GENERATED_PROVIDERS.map((provider) => [provider.kind, provider.order]));

  let dockerDone = false;
  let gatusDone = false;
  let prometheusDone = false;
  let alertmanagerDone = false;
  for (const integ of config.integrations ?? []) {
    if (integ.kind === "docker" && !dockerDone) {
      registerDocker("docker", { baseUrl: integ.baseUrl, credentialEnv: integ.credentialEnv });
      dockerDone = true;
    }
    if (integ.kind === "gatus" && !gatusDone) {
      registerGatus("gatus", { baseUrl: integ.baseUrl, credentialEnv: integ.credentialEnv });
      gatusDone = true;
    }
    if (integ.kind === "prometheus" && !prometheusDone) {
      registerPrometheus("prometheus", {
        baseUrl: integ.baseUrl,
        credentialEnv: integ.credentialEnv,
        summaries: parseSummaryCard(integ.card),
      });
      prometheusDone = true;
    }
    if (integ.kind === "alertmanager" && !alertmanagerDone) {
      registerAlertmanager("alertmanager", {
        baseUrl: integ.baseUrl,
        credentialEnv: integ.credentialEnv,
      });
      alertmanagerDone = true;
    }
  }

  for (const host of config.hosts ?? []) {
    for (const [kind, raw] of Object.entries(host.bindings ?? {})) {
      const defaultOrder = available.get(kind);
      if (defaultOrder !== undefined) collectBinding(registrations, `host:${host.name}`, kind, raw, defaultOrder);
    }
  }
  for (const service of config.services ?? []) {
    for (const [kind, raw] of Object.entries(service.bindings ?? {})) {
      const defaultOrder = available.get(kind);
      if (defaultOrder !== undefined) {
        collectBinding(registrations, `service:${service.host}:${service.name}`, kind, raw, defaultOrder);
      }
    }
  }

  // Runtime snapshot singleton: resolved once, never discovered from bindings and
  // never registered per entity. A present malformed/unsupported source throws here
  // (a safe startup configuration error); a valid but unreadable source registers and
  // fails only on its first scheduled poll.
  if (runtime.snapshotSource !== undefined) {
    const source = createSnapshotSource(runtime.snapshotSource);
    const order = available.get("snapshot") ?? 0;
    registrations.push({
      id: "snapshot",
      kind: "snapshot",
      order,
      register: () => registerSnapshot("snapshot", { source, config }),
    });
  }

  // Source providers: one per declared source of a supported kind (REQ-SRC-01/02). The store
  // is threaded via runtime.sourceStores exactly as snapshotSource is. Dispatch is on the two
  // literal kind strings; an unknown kind matches no branch → silently skipped, never fatal,
  // leaving supported siblings unaffected (REQ-SRC-05 / SC-12). A missing store (unsupported
  // kind / capability off) also skips. Duplicate ids reach register() and throw there (00 §7).
  for (const src of config.sources ?? []) {
    const store = runtime.sourceStores?.get(src.id);
    if (store === undefined) continue;
    const order = available.get(src.kind) ?? 0;

    if (src.kind === "markdown-tree") {
      registrations.push({
        id: src.id,
        kind: src.kind,
        order,
        register: () => registerMarkdownTree(src.id, src, store),
      });
    } else if (src.kind === "file-tree") {
      registrations.push({
        id: src.id,
        kind: src.kind,
        order,
        register: () => registerFileTree(src.id, src, store),
      });
    }
  }

  registrations
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .forEach((registration) => registration.register());
}

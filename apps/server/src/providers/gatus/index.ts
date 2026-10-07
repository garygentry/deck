import type { Provider, ProviderConfig, ProviderHealth } from "../../contract/index.js";
import { register } from "../registry.js";

export interface GatusEndpoint {
  key: string;
  name?: string;
  group?: string;
  up: boolean;
  latencyMs: number | null;
}

export interface GatusResult {
  endpoints: GatusEndpoint[];
}

export interface GatusConfig {
  baseUrl: string;
  credentialEnv?: string;
  timing?: ProviderConfig;
}

interface RawGatusResult {
  success: boolean;
  duration: number;
}

interface RawGatusEndpoint {
  key: string;
  name?: string;
  group?: string;
  results?: RawGatusResult[];
}

export class GatusProvider implements Provider<GatusResult> {
  readonly kind = "gatus";

  /** Cached latest health; updated only by fetch(), never by a health() probe. */
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: GatusConfig,
  ) {}

  /** Return the cached non-I/O health snapshot from the latest fetch. */
  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(): Promise<GatusResult> {
    try {
      const response = await globalThis.fetch(joinUrl(this.cfg.baseUrl, "/api/v1/endpoints/statuses"), {
        method: "GET",
        headers: authHeaders(this.cfg.credentialEnv),
      });
      // A non-2xx upstream (auth failure, endpoint down) is a real failure — report
      // it as unhealthy rather than an empty-but-healthy result that masks the fault.
      if (!response.ok) {
        this.latestHealth = { ok: false, detail: `HTTP ${response.status}` };
        return { endpoints: [] };
      }
      const result: GatusResult = {
        endpoints: ((await response.json()) as RawGatusEndpoint[]).map(mapEndpoint),
      };
      this.latestHealth = { ok: true, detail: `${result.endpoints.length} endpoints` };
      return result;
    } catch (error) {
      this.latestHealth = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
}

export function registerGatus(id: string, cfg: GatusConfig): void {
  register(new GatusProvider(id, cfg), cfg.timing);
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

function authHeaders(credentialEnv?: string): Record<string, string> {
  if (!credentialEnv) return {};
  const value = process.env[credentialEnv];
  if (!value) return {};
  return { Authorization: value };
}

function mapEndpoint(raw: RawGatusEndpoint): GatusEndpoint {
  const last = raw.results?.[raw.results.length - 1];
  return {
    key: raw.key,
    name: raw.name,
    group: raw.group,
    up: last?.success ?? false,
    latencyMs: last ? Math.round(last.duration / 1e6) : null,
  };
}

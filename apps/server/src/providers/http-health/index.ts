import type { Provider, ProviderConfig, ProviderHealth } from "../../contract/index.js";
import { register } from "../registry.js";

export interface HttpHealthConfig {
  url: string;
  method?: "GET" | "HEAD";
  timing?: ProviderConfig;
}

export interface HttpHealthResult {
  up: boolean;
  status: number;
  latencyMs: number;
}

export class HttpHealthProvider implements Provider<HttpHealthResult> {
  readonly kind = "http-health";

  /** Cached latest health; updated only by fetch(), never by a health() probe. */
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly config: HttpHealthConfig,
  ) {}

  /** Return the cached non-I/O health snapshot from the latest fetch. */
  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(): Promise<HttpHealthResult> {
    const startedAt = performance.now();
    try {
      const response = await globalThis.fetch(this.config.url, {
        method: this.config.method ?? "GET",
      });
      const result: HttpHealthResult = {
        up: response.status >= 200 && response.status < 400,
        status: response.status,
        latencyMs: Math.round(performance.now() - startedAt),
      };
      this.latestHealth = { ok: result.up, detail: `status ${result.status}` };
      return result;
    } catch (error) {
      this.latestHealth = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
}

export function registerHttpHealth(id: string, config: HttpHealthConfig): void {
  register(new HttpHealthProvider(id, config), config.timing);
}

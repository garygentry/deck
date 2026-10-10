import type { ProviderFetchContext, ProviderHealth, ProviderSpec, ProviderTiming } from "@deck/module-sdk";

export interface HttpHealthConfig {
  url: string;
  method?: "GET" | "HEAD";
  timing?: ProviderTiming;
}

export interface HttpHealthResult {
  up: boolean;
  status: number;
  latencyMs: number;
}

export class HttpHealthProvider implements ProviderSpec<HttpHealthResult> {
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

  /**
   * Probe the URL once. Redirects are not followed, so a 3xx answer is the service's own and
   * counts as up, like a 2xx. The poll's signal aborts a probe that outlives its timeout, and
   * the body is never read: it is cancelled so the connection is released.
   */
  async fetch(context?: ProviderFetchContext): Promise<HttpHealthResult> {
    const signal = context?.signal;
    const startedAt = performance.now();
    try {
      const response = await globalThis.fetch(this.config.url, {
        method: this.config.method ?? "GET",
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      await response.body?.cancel().catch(() => {});
      // An aborted poll has already been recorded as failed; its late answer changes nothing.
      signal?.throwIfAborted();
      const result: HttpHealthResult = {
        up: response.status >= 200 && response.status < 400,
        status: response.status,
        latencyMs,
      };
      this.latestHealth = { ok: result.up, detail: `status ${result.status}` };
      return result;
    } catch (error) {
      const detail = signal?.aborted ? "probe aborted" : error instanceof Error ? error.message : String(error);
      this.latestHealth = { ok: false, detail };
      throw error;
    }
  }
}

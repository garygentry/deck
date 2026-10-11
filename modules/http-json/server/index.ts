import type { ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";

import { fetchJson, type HttpJsonConfig } from "./fetch.js";

export {
  HTTP_JSON_DEFAULT_MAX_BYTES,
  HTTP_JSON_MAX_DEPTH,
  HTTP_JSON_MAX_REDIRECTS,
  HTTP_JSON_MIN_CREDENTIAL_LENGTH,
  HttpJsonError,
  fetchJson,
  nestsDeeperThan,
  type HttpJsonAuth,
  type HttpJsonConfig,
  type HttpJsonErrorCode,
} from "./fetch.js";

/**
 * The `http-json` provider: one request per poll, whose parsed JSON body is the envelope's
 * `data`. Redirects are followed by hand: an authenticated request follows only same-origin
 * ones, so the credential never leaves the configured origin. A body over `maxBytes`, nested
 * past {@link HTTP_JSON_MAX_DEPTH}, or echoing the credential is refused, never published.
 */
export class HttpJsonProvider implements ProviderSpec<unknown> {
  readonly kind = "http-json";

  /** Cached latest health; updated only by fetch(), never by a health() probe. */
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: HttpJsonConfig,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(context?: ProviderFetchContext): Promise<unknown> {
    try {
      const { status, data } = await fetchJson(this.cfg, context);
      this.latestHealth = { ok: true, detail: `HTTP ${status}` };
      return data;
    } catch (error) {
      this.latestHealth = { ok: false, detail: (error as Error).message };
      throw error;
    }
  }
}


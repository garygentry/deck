import type { ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";
import { isRfc3339DateTime } from "@deck/schema";

import { fetchJson, HttpJsonError, type HttpJsonConfig } from "../http-json/index.js";
import type { InstanceRequest } from "../http-json/request-config.js";

/** The protocol's data path, under the integration's base URL. */
export const REMOTE_DATA_PATH = "/deck/v1/data";

/** The longest `observedAt` accepted: an RFC 3339 time with a millisecond fraction and an offset fits. */
export const REMOTE_OBSERVED_AT_MAX_LENGTH = 40;

export interface RemoteConfig {
  /** The sidecar's base URL; the protocol's paths go under it. */
  url: string;
  /** The instance's request settings: the credential, its scheme, the env reader, timeout and body cap. */
  request: InstanceRequest;
}

/**
 * A `remote` integration's provider. Each poll reads `GET <url>/deck/v1/data`, a
 * `{ data, observedAt? }` envelope, through the same hardened request as `http-json`; the
 * provider's data is its `data`, and the sidecar's `observedAt` is when it was observed, so
 * the envelope's age and staleness follow the sidecar's clock, not the poll's.
 */
export class RemoteProvider implements ProviderSpec<unknown> {
  readonly kind = "remote";

  private latestHealth: ProviderHealth = { ok: false, detail: "awaiting first poll" };
  private latestObservedAt: number | null = null;

  constructor(
    readonly id: string,
    private readonly cfg: RemoteConfig,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  observedAt(): number | null {
    return this.latestObservedAt;
  }

  async fetch(context?: ProviderFetchContext): Promise<unknown> {
    try {
      const { status, data } = await fetchJson(this.request(REMOTE_DATA_PATH), context);
      const envelope = dataEnvelope(data);
      this.latestObservedAt = envelope.observedAt ?? null;
      const observed = envelope.observedAt === undefined ? "" : `, observed ${new Date(envelope.observedAt).toISOString()}`;
      this.latestHealth = { ok: true, detail: `HTTP ${status}${observed}` };
      return envelope.data;
    } catch (error) {
      this.latestHealth = { ok: false, detail: (error as Error).message };
      throw error;
    }
  }

  private request(path: string): HttpJsonConfig {
    return { url: endpoint(this.cfg.url, path), ...this.cfg.request };
  }
}

/** A protocol path under a base URL, whatever its trailing slash. */
export function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * The data response's envelope, with `observedAt` as epoch milliseconds; anything else is a
 * classified failure whose message never repeats the sidecar's text.
 */
function dataEnvelope(body: unknown): { data: unknown; observedAt?: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body) || !("data" in body)) {
    throw new HttpJsonError("not-json", "sidecar data response is not a { data } envelope");
  }
  const { data, observedAt } = body as { data: unknown; observedAt?: unknown };
  if (observedAt === undefined) return { data };
  // Bounded before it is parsed: a long fraction is refused, never scanned.
  const time =
    typeof observedAt === "string" && observedAt.length <= REMOTE_OBSERVED_AT_MAX_LENGTH && isRfc3339DateTime(observedAt)
      ? Date.parse(observedAt)
      : Number.NaN;
  if (Number.isNaN(time)) throw new HttpJsonError("not-json", "sidecar data response's observedAt is not an RFC 3339 time");
  return { data, observedAt: time };
}

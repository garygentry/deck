import type { ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";
import { isRfc3339DateTime } from "@deck/schema";

import { fetchJson, HttpJsonError, type HttpJsonConfig } from "../http-json/index.js";

/** The protocol's data path, under the integration's base URL. */
export const REMOTE_DATA_PATH = "/deck/v1/data";

export interface RemoteConfig {
  /** The sidecar's base URL; the protocol's paths go under it. */
  url: string;
  /** The credential, its scheme and the env reader. */
  request: Pick<HttpJsonConfig, "credentialEnv" | "auth" | "env">;
  timeoutMs?: number;
  /** The largest data response accepted, in bytes. */
  maxBytes?: number;
}

/**
 * A `remote` integration's provider. Each poll reads `GET <url>/deck/v1/data`, a
 * `{ data, observedAt? }` envelope, through the same hardened request as `http-json`; the
 * provider's data is its `data`.
 */
export class RemoteProvider implements ProviderSpec<unknown> {
  readonly kind = "remote";

  private latestHealth: ProviderHealth = { ok: false, detail: "awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: RemoteConfig,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(context?: ProviderFetchContext): Promise<unknown> {
    try {
      const { status, data } = await fetchJson(this.request(REMOTE_DATA_PATH, this.cfg.maxBytes), context);
      const envelope = dataEnvelope(data);
      this.latestHealth = { ok: true, detail: `HTTP ${status}${envelope.observedAt === undefined ? "" : `, observed ${envelope.observedAt}`}` };
      return envelope.data;
    } catch (error) {
      this.latestHealth = { ok: false, detail: (error as Error).message };
      throw error;
    }
  }

  private request(path: string, maxBytes: number | undefined): HttpJsonConfig {
    return {
      url: endpoint(this.cfg.url, path),
      ...this.cfg.request,
      ...(this.cfg.timeoutMs === undefined ? {} : { timeoutMs: this.cfg.timeoutMs }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    };
  }
}

/** A protocol path under a base URL, whatever its trailing slash. */
export function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** The data response's envelope; anything else is a classified failure. */
function dataEnvelope(body: unknown): { data: unknown; observedAt?: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body) || !("data" in body)) {
    throw new HttpJsonError("not-json", "sidecar data response is not a { data } envelope");
  }
  const { data, observedAt } = body as { data: unknown; observedAt?: unknown };
  if (observedAt === undefined) return { data };
  if (typeof observedAt !== "string" || !isRfc3339DateTime(observedAt)) {
    throw new HttpJsonError("not-json", "sidecar data response's observedAt is not an RFC 3339 time");
  }
  return { data, observedAt };
}

import type { ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";
import { isRfc3339DateTime } from "@deck/schema";

import { fetchJson, HttpJsonError, type HttpJsonConfig } from "../http-json/index.js";
import { checkDescribe } from "./describe.js";
import type { RemoteDirectory } from "./directory.js";

/** The protocol's paths, under the integration's base URL. */
export const REMOTE_DESCRIBE_PATH = "/deck/v1/describe";
export const REMOTE_DATA_PATH = "/deck/v1/data";

/** How often a sidecar is asked to describe itself, by default (5 minutes). */
export const REMOTE_DEFAULT_DESCRIBE_INTERVAL_MS = 300_000;
/** The largest describe document accepted, in bytes. */
export const REMOTE_DESCRIBE_MAX_BYTES = 256 * 1024;
/** The longest problem text kept (health detail, findings). */
const MAX_PROBLEM = 300;

export interface RemoteConfig {
  /** The sidecar's base URL; the protocol's paths go under it. */
  url: string;
  /** Shared by both requests: the credential, its scheme and the env reader. */
  request: Pick<HttpJsonConfig, "credentialEnv" | "auth" | "env">;
  /** Each request's own timeout. */
  timeoutMs?: number;
  /** The largest data response accepted, in bytes. */
  maxBytes?: number;
  describeIntervalMs?: number;
  clock?: { now(): number };
}

/**
 * A `remote` integration's provider. Each poll reads `GET <url>/deck/v1/data`, a
 * `{ data, observedAt? }` envelope, through the same hardened request as `http-json`; the
 * provider's data is its `data`. Describe (`GET <url>/deck/v1/describe`) runs beside the
 * polls on its own cadence and its own timeout: it never delays a poll, and its failure never
 * fails one. A good describe goes to the directory; a failed one leaves the last good one there,
 * with the problem. Health is the data poll's, and its detail names both.
 */
export class RemoteProvider implements ProviderSpec<unknown> {
  readonly kind = "remote";

  private data: { ok: boolean; detail: string } = { ok: false, detail: "awaiting first poll" };
  private describeState = "awaiting describe";
  private nextDescribeAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    readonly id: string,
    private readonly cfg: RemoteConfig,
    private readonly directory: RemoteDirectory,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ok: this.data.ok, detail: `data: ${this.data.detail}; describe: ${this.describeState}` };
  }

  async fetch(context?: ProviderFetchContext): Promise<unknown> {
    this.describeIfDue();
    try {
      const { status, data } = await fetchJson(this.request(REMOTE_DATA_PATH, this.cfg.maxBytes), context);
      const envelope = dataEnvelope(data);
      this.data = { ok: true, detail: `HTTP ${status}${envelope.observedAt === undefined ? "" : `, observed ${envelope.observedAt}`}` };
      return envelope.data;
    } catch (error) {
      this.data = { ok: false, detail: bounded((error as Error).message) };
      throw error;
    }
  }

  /**
   * Describe now unless one is running, and resolve when it is done (tests and the first poll
   * use it; polls only start it).
   */
  describe(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const clock = this.cfg.clock ?? Date;
    this.inFlight = this.runDescribe()
      .then((ok) => {
        // A failed describe is asked again at the next poll; a good one after its interval.
        this.nextDescribeAt = ok ? clock.now() + (this.cfg.describeIntervalMs ?? REMOTE_DEFAULT_DESCRIBE_INTERVAL_MS) : 0;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** The describe a poll started, if one is still running (resolves at once otherwise). */
  describing(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private describeIfDue(): void {
    if (this.inFlight !== null || (this.cfg.clock ?? Date).now() < this.nextDescribeAt) return;
    void this.describe();
  }

  private async runDescribe(): Promise<boolean> {
    let body: unknown;
    try {
      ({ data: body } = await fetchJson(this.request(REMOTE_DESCRIBE_PATH, REMOTE_DESCRIBE_MAX_BYTES)));
    } catch (error) {
      const message = bounded(error instanceof HttpJsonError ? error.message : "describe failed");
      this.describeState = `unreachable (${message})`;
      this.directory.refuse(this.id, { code: "REMOTE_DESCRIBE_UNREACHABLE", message });
      return false;
    }
    const checked = checkDescribe(body, this.id);
    if (!checked.ok) {
      const message = bounded(checked.problem);
      this.describeState = `invalid (${message})`;
      this.directory.refuse(this.id, { code: "REMOTE_DESCRIBE_INVALID", message });
      return false;
    }
    this.describeState = `ok (${checked.describe.id} ${checked.describe.version})`;
    this.directory.accept(this.id, checked.describe, checked.notes.map(bounded));
    return true;
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

function bounded(text: string): string {
  return text.length <= MAX_PROBLEM ? text : `${text.slice(0, MAX_PROBLEM - 1)}…`;
}

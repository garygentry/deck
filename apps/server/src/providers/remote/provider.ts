import type { ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";
import { isRfc3339DateTime } from "@deck/schema";

import { fetchJson, HttpJsonError, type HttpJsonConfig } from "../http-json/index.js";
import type { InstanceRequest } from "../http-json/request-config.js";
import { checkDescribe } from "./describe.js";
import type { RemoteDirectory } from "./directory.js";

/** The protocol's paths, under the integration's base URL. */
export const REMOTE_DESCRIBE_PATH = "/deck/v1/describe";
export const REMOTE_DATA_PATH = "/deck/v1/data";

/** The longest `observedAt` accepted: an RFC 3339 time with a millisecond fraction and an offset fits. */
export const REMOTE_OBSERVED_AT_MAX_LENGTH = 40;
/** How often a sidecar is asked to describe itself, by default (5 minutes). */
export const REMOTE_DEFAULT_DESCRIBE_INTERVAL_MS = 300_000;
/** The wait before asking again after a first failed describe; it doubles with each failure, up to the interval. */
export const REMOTE_DESCRIBE_RETRY_MS = 5_000;
/** The largest describe document accepted, in bytes. */
export const REMOTE_DESCRIBE_MAX_BYTES = 256 * 1024;
/** The longest problem text kept (health detail, findings). */
const MAX_PROBLEM = 300;
/** What a describe that failed in deck's own code (not the sidecar's answer) reports. */
const DESCRIBE_INTERNAL_PROBLEM = "deck could not check the describe document";

export interface RemoteConfig {
  /** The sidecar's base URL; the protocol's paths go under it. */
  url: string;
  /** The instance's request settings: the credential, its scheme, the env reader, timeout and body cap. */
  request: InstanceRequest;
  describeIntervalMs?: number;
  clock?: { now(): number };
}

/**
 * A `remote` integration's provider. Each poll reads `GET <url>/deck/v1/data`, a
 * `{ data, observedAt? }` envelope, through the same hardened request as `http-json`; the
 * provider's data is its `data`, and the sidecar's `observedAt` is when it was observed, so the
 * envelope's age and staleness follow the sidecar's clock, not the poll's.
 *
 * Describe (`GET <url>/deck/v1/describe`) runs beside the polls, started by a poll when due and
 * never awaited by it (nor by boot): on its own timeout and cadence, it never delays a poll and
 * its failure never fails one. A good describe goes to the directory and is asked again after
 * `describeIntervalMs`; a failed one leaves the last good one there, with the problem, and is
 * asked again after a backoff that doubles up to the interval. Once stopped, a describe in flight
 * is aborted and nothing reaches the directory. Health is the data poll's; its detail names both.
 */
export class RemoteProvider implements ProviderSpec<unknown> {
  readonly kind = "remote";

  private data: { ok: boolean; detail: string } = { ok: false, detail: "awaiting first poll" };
  private latestObservedAt: number | null = null;
  private describeState = "awaiting describe";
  private nextDescribeAt = 0;
  private failures = 0;
  private inFlight: Promise<void> | null = null;
  private readonly stopping = new AbortController();

  constructor(
    readonly id: string,
    private readonly cfg: RemoteConfig,
    private readonly directory: RemoteDirectory,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ok: this.data.ok, detail: `data: ${this.data.detail}; describe: ${this.describeState}` };
  }

  observedAt(): number | null {
    return this.latestObservedAt;
  }

  stop(): void {
    this.stopping.abort();
  }

  async fetch(context?: ProviderFetchContext): Promise<unknown> {
    this.describeIfDue();
    try {
      const { status, data } = await fetchJson(this.request(REMOTE_DATA_PATH), context);
      const envelope = dataEnvelope(data);
      this.latestObservedAt = envelope.observedAt ?? null;
      const observed = envelope.observedAt === undefined ? "" : `, observed ${new Date(envelope.observedAt).toISOString()}`;
      this.data = { ok: true, detail: `HTTP ${status}${observed}` };
      return envelope.data;
    } catch (error) {
      this.data = { ok: false, detail: bounded((error as Error).message) };
      throw error;
    }
  }

  /**
   * Describe now unless one is running or the provider stopped; resolves when it is done and
   * never rejects. Polls start it in the background; tests await it.
   */
  describe(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    if (this.stopping.signal.aborted) return Promise.resolve();
    const clock = this.cfg.clock ?? Date;
    const interval = this.cfg.describeIntervalMs ?? REMOTE_DEFAULT_DESCRIBE_INTERVAL_MS;
    this.inFlight = this.runDescribe()
      .catch(() => {
        // Any throw of deck's own (a check, the directory) is a refusal with a fixed reason.
        try {
          this.refuse("REMOTE_DESCRIBE_INVALID", DESCRIBE_INTERNAL_PROBLEM, "invalid");
        } catch {
          this.describeState = `invalid (${DESCRIBE_INTERNAL_PROBLEM})`;
        }
        return false;
      })
      .then((ok) => {
        this.failures = ok ? 0 : this.failures + 1;
        const wait = ok ? interval : Math.min(interval, REMOTE_DESCRIBE_RETRY_MS * 2 ** (this.failures - 1));
        this.nextDescribeAt = clock.now() + wait;
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
    this.describe().catch(() => {});
  }

  private async runDescribe(): Promise<boolean> {
    let body: unknown;
    try {
      ({ data: body } = await fetchJson(this.request(REMOTE_DESCRIBE_PATH, REMOTE_DESCRIBE_MAX_BYTES), { signal: this.stopping.signal }));
    } catch (error) {
      if (this.stopping.signal.aborted) return false;
      this.refuse("REMOTE_DESCRIBE_UNREACHABLE", error instanceof HttpJsonError ? error.message : "describe failed", "unreachable");
      return false;
    }
    if (this.stopping.signal.aborted) return false;
    const checked = checkDescribe(body, this.id);
    if (!checked.ok) {
      this.refuse("REMOTE_DESCRIBE_INVALID", checked.problem, "invalid");
      return false;
    }
    this.describeState = `ok (${checked.describe.id} ${checked.describe.version})`;
    this.directory.accept(this.id, checked.describe, checked.notes.map(bounded));
    return true;
  }

  /** Record a failed describe: the state, and the directory's problem, unless stopped. */
  private refuse(code: "REMOTE_DESCRIBE_INVALID" | "REMOTE_DESCRIBE_UNREACHABLE", problem: string, state: string): void {
    if (this.stopping.signal.aborted) return;
    const message = bounded(problem);
    this.describeState = `${state} (${message})`;
    this.directory.refuse(this.id, { code, message });
  }

  /** A request to the sidecar, which may redirect within its own origin only (see `sameOriginRedirects`). */
  private request(path: string, maxBytes?: number): HttpJsonConfig {
    return { url: endpoint(this.cfg.url, path), ...this.cfg.request, ...(maxBytes === undefined ? {} : { maxBytes }), sameOriginRedirects: true };
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

function bounded(text: string): string {
  return text.length <= MAX_PROBLEM ? text : `${text.slice(0, MAX_PROBLEM - 1)}…`;
}

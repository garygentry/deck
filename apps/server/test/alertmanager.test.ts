import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertmanagerProvider } from "../../../modules/alertmanager/server/index.js";
import { providerCount, read, stopScheduler } from "../src/providers/registry.js";
import { processEnv, registerAlertmanager } from "./util/register-kinds.js";

interface RawFixture {
  alerts: unknown[];
  silences: unknown[];
}

const fixture = (name: string): RawFixture => JSON.parse(readFileSync(
  fileURLToPath(new URL(`./fixtures/alertmanager/${name}.json`, import.meta.url)),
  "utf8",
));

/** Stub globalThis.fetch to answer /api/v2/alerts and /api/v2/silences from a fixture. */
function stubFixture(name: string) {
  const raw = fixture(name);
  const fetchStub = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
    const href = String(url);
    const body = href.includes("/api/v2/silences") ? raw.silences : raw.alerts;
    return Promise.resolve(Response.json(body));
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

function provider(credentialEnv?: string): AlertmanagerProvider {
  return new AlertmanagerProvider("alertmanager", { baseUrl: "http://am/", credentialEnv, env: processEnv });
}

describe("AlertmanagerProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:00:00.000Z"));
  });

  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.DECK_AM_TOKEN;
  });

  it("issues exactly two GETs to the alerts and silences endpoints with one signal the poll's aborts", async () => {
    const fetchStub = stubFixture("empty");
    const controller = new AbortController();
    await provider().fetch({ signal: controller.signal });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["http://am/api/v2/alerts?active=true&silenced=true", "GET"],
      ["http://am/api/v2/silences", "GET"],
    ]);
    const [alertsSignal, silencesSignal] = fetchStub.mock.calls.map(([, init]) => init?.signal);
    expect(alertsSignal).toBeInstanceOf(AbortSignal);
    expect(silencesSignal).toBe(alertsSignal);
  });

  it("aborts both requests when the poll's signal aborts", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signals.push(init!.signal!);
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
    })));
    const controller = new AbortController();
    const polled = provider().fetch({ signal: controller.signal });
    controller.abort(new Error("poll timed out"));
    await expect(polled).rejects.toThrowError("poll timed out");
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it.each(["alerts", "silences"])("aborts the other request when the %s request fails", async (failing) => {
    const signals = new Map<string, AbortSignal>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const endpoint = String(url).includes("silences") ? "silences" : "alerts";
      signals.set(endpoint, init!.signal!);
      if (endpoint === failing) return Promise.resolve(new Response(null, { status: 503 }));
      // The sibling hangs until it is aborted.
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    }));
    await expect(provider().fetch()).rejects.toThrowError(`Alertmanager /api/v2/${failing} responded 503`);
    expect(signals.get(failing === "alerts" ? "silences" : "alerts")?.aborted).toBe(true);
  });

  it("drains the body of a non-2xx answer", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => Promise.resolve(String(url).includes("silences")
      ? Response.json([])
      : new Response(new ReadableStream({ pull: () => {}, cancel }), { status: 500 }))));
    await expect(provider().fetch()).rejects.toThrowError("Alertmanager /api/v2/alerts responded 500");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("maps a firing fixture: name fallbacks, severity, sourceUrl, skips missing fingerprint", async () => {
    stubFixture("firing");
    const result = await provider().fetch();

    expect(result.alerts).toEqual([
      {
        fingerprint: "a1b2c3",
        name: "HostDown",
        severity: "critical",
        startsAt: "2026-09-15T09:12:00.000Z",
        suppressed: false,
        sourceUrl: "https://prometheus.lantern.invalid/graph?g0.expr=up",
      },
      {
        fingerprint: "e5f6g7",
        name: "LatencyHigh",
        severity: "warning",
        startsAt: "2026-09-15T09:20:00.000Z",
        suppressed: false,
        sourceUrl: null,
      },
      {
        fingerprint: "g7h8i9",
        name: "nightly backup overdue",
        severity: "",
        startsAt: "2026-09-15T07:00:00.000Z",
        suppressed: false,
        sourceUrl: null,
      },
    ]);
    // The fingerprint-less alert is skipped; the rest still succeed.
    expect(result.alerts).toHaveLength(3);
    expect(result.firingCount).toBe(3);
    expect(result.silences).toEqual([]);
  });

  it("correlates suppression: suppressed alert kept + excluded from firingCount; only active silences", async () => {
    stubFixture("silenced");
    const result = await provider().fetch();

    expect(result.alerts).toEqual([
      expect.objectContaining({ fingerprint: "a1b2c3", suppressed: false }),
      expect.objectContaining({ fingerprint: "d4e5f6", suppressed: true }),
    ]);
    expect(result.firingCount).toBe(1);

    // Only the active silence surfaces; expired dropped. Matcher operators rendered per isRegex/isEqual.
    expect(result.silences).toEqual([
      { id: "sil-777", endsAt: "2026-09-15T12:00:00.000Z", matchers: 'instance="web-02", severity=~"warn.*"' },
    ]);
  });

  it("renders all four matcher operators from isEqual/isRegex", async () => {
    const raw = {
      alerts: [],
      silences: [
        {
          id: "s1",
          status: { state: "active" },
          matchers: [
            { name: "a", value: "1", isRegex: false, isEqual: true },
            { name: "b", value: "2", isRegex: true, isEqual: true },
            { name: "c", value: "3", isRegex: false, isEqual: false },
            { name: "d", value: "4", isRegex: true, isEqual: false },
            { name: "e", value: "5" },
          ],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      Promise.resolve(Response.json(String(url).includes("silences") ? raw.silences : raw.alerts))));
    const result = await provider().fetch();
    expect(result.silences[0]!.matchers).toBe('a="1", b=~"2", c!="3", d!~"4", e="5"');
  });

  it("returns a successful all-clear (firingCount 0) for a reachable empty endpoint", async () => {
    stubFixture("empty");
    const result = await provider().fetch();
    expect(result).toEqual({ alerts: [], silences: [], firingCount: 0 });
    await expect(provider().health()).resolves.toMatchObject({ ok: false });
  });

  it("rejects on a non-2xx from either endpoint rather than returning empty", async () => {
    // Alerts endpoint 503.
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      Promise.resolve(String(url).includes("silences")
        ? Response.json([])
        : new Response(null, { status: 503 }))));
    const p = provider();
    await expect(p.fetch()).rejects.toThrowError(/503/);
    await expect(p.health()).resolves.toMatchObject({ ok: false });

    // Silences endpoint 503.
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      Promise.resolve(String(url).includes("silences")
        ? new Response(null, { status: 503 })
        : Response.json([]))));
    await expect(provider().fetch()).rejects.toThrowError(/503/);
  });

  it("rejects on a transport error and on malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("secret transport detail"))));
    await expect(provider().fetch()).rejects.toThrowError("secret transport detail");

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("not json", { status: 200 }))));
    await expect(provider().fetch()).rejects.toThrow();
  });

  it("records only the error message in latestHealth.detail (no payload, no credential)", async () => {
    process.env.DECK_AM_TOKEN = "Bearer super-secret";
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      Promise.resolve(String(url).includes("silences") ? Response.json([]) : new Response(null, { status: 401 }))));
    const p = provider("DECK_AM_TOKEN");
    await expect(p.fetch()).rejects.toThrow();
    const health = await p.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toBe("Alertmanager /api/v2/alerts responded 401");
    expect(JSON.stringify(health)).not.toContain("super-secret");
  });

  it("sends Authorization only when the env var is set and never stores the secret", async () => {
    const fetchStub = stubFixture("empty");
    process.env.DECK_AM_TOKEN = "Bearer super-secret";
    const p = provider("DECK_AM_TOKEN");
    await p.fetch();
    expect(fetchStub.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { Authorization: "Bearer super-secret" },
      { Authorization: "Bearer super-secret" },
    ]);
    expect(JSON.stringify(p)).not.toContain("super-secret");

    delete process.env.DECK_AM_TOKEN;
    const fetchStub2 = stubFixture("empty");
    await provider("DECK_AM_TOKEN").fetch();
    expect(fetchStub2.mock.calls.map(([, init]) => init?.headers)).toEqual([{}, {}]);
  });

  it("registers through the shared registry", () => {
    registerAlertmanager("alertmanager", { baseUrl: "http://am" });
    expect(providerCount()).toBe(1);
    expect(read("alertmanager")).toMatchObject({ id: "alertmanager", kind: "alertmanager" });
  });
});

/**
 * Against a real HTTP server: when one endpoint fails, the other request is torn down whether
 * it is still waiting for headers or part-way through its body.
 */
describe("AlertmanagerProvider against a live endpoint", () => {
  let server: Server;
  let baseUrl: string;
  /** Per test: where the alerts response stops, and what the server saw of it. */
  let hold: "headers" | "body";
  let alertsHeld: { promise: Promise<void>; resolve: () => void };
  let alertsClosed: Promise<ServerResponse>;
  let onAlertsClosed: (res: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/api/v2/silences")) {
        // Fail only once the alerts request is being held, so its teardown is what is tested.
        void alertsHeld.promise.then(() => res.writeHead(503).end());
        return;
      }
      res.on("close", () => onAlertsClosed(res));
      if (hold === "body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("[");
      }
      alertsHeld.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    { point: "headers" as const, stage: "while it waits for headers" },
    { point: "body" as const, stage: "part-way through its body" },
  ])("closes the alerts request $stage when silences fails", async ({ point }) => {
    hold = point;
    let resolve!: () => void;
    alertsHeld = { promise: new Promise<void>((done) => { resolve = done; }), resolve };
    alertsClosed = new Promise<ServerResponse>((done) => { onAlertsClosed = done; });
    const am = new AlertmanagerProvider("alertmanager", { baseUrl });
    await expect(am.fetch()).rejects.toThrowError("Alertmanager /api/v2/silences responded 503");
    // The server sees the held alerts response closed by the client, never finished.
    const res = await alertsClosed;
    expect(res.writableFinished).toBe(false);
  });
});

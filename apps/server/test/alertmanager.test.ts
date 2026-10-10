import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("issues exactly two GETs to the alerts and silences endpoints with a shared signal", async () => {
    const fetchStub = stubFixture("empty");
    const controller = new AbortController();
    await provider().fetch({ signal: controller.signal });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls.map(([url, init]) => [url, init?.method, init?.signal])).toEqual([
      ["http://am/api/v2/alerts?active=true&silenced=true", "GET", controller.signal],
      ["http://am/api/v2/silences", "GET", controller.signal],
    ]);
    for (const [, init] of fetchStub.mock.calls) {
      expect(init?.method).toBe("GET");
    }
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

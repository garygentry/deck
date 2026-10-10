// @vitest-environment jsdom
import { POLL_DEFAULTS } from "@deck/contract";
import { BUILTIN_STATUS_KINDS } from "@deck/contract/modules/data-sources";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isProviderPollable,
  resetQueryClient,
  useConfig,
  useProvider,
  useUiManifest,
  UI_MANIFEST_REFRESH_MS,
} from "../src/data/index.js";
import { usePortalData } from "../../../modules/portal/web/usePortalData.js";

const CONFIG = {
  schemaVersion: 2,
  estate: { name: "Lab" },
  hosts: [],
  services: [],
};

function manifest(providers: { id: string; kind: string }[]) {
  return { uiApi: 1, modules: [], slots: [], pages: [], disabledPages: [], nav: [], extensions: [], providers, findings: [] };
}

function envelope(id: string) {
  return { id, kind: id, data: { id }, error: null, freshness: { state: "fresh", observedAt: null, ageMs: 0, ttlMs: 30_000 } };
}

/** Stub fetch with a URL → response table; unlisted URLs 404. Returns a per-URL counter. */
function stubFetch(table: Record<string, () => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const respond = table[url];
    return respond ? respond() : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return (url: string) => fetchMock.mock.calls.filter(([called]) => String(called) === url).length;
}

const json = (body: unknown) => () => Response.json(body);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryClient();
});

describe("useConfig", () => {
  it("serves every reader from one /api/config request", async () => {
    const calls = stubFetch({ "/api/config": json(CONFIG) });
    function Reader({ label }: { label: string }) {
      const state = useConfig();
      return <p>{state.status === "ready" ? `${label} ${state.config.estate.name}` : state.status}</p>;
    }
    render(
      <>
        <Reader label="a" />
        <Reader label="b" />
      </>,
    );
    await screen.findByText("a Lab");
    expect(screen.getByText("b Lab")).toBeTruthy();
    // A reader mounted later reads the cache.
    render(<Reader label="c" />);
    await screen.findByText("c Lab");
    expect(calls("/api/config")).toBe(1);
  });

  it("reports a failed read, and asks again when a reader remounts (Retry)", async () => {
    let status = 500;
    const calls = stubFetch({ "/api/config": () => (status === 200 ? Response.json(CONFIG) : new Response(null, { status })) });
    function Reader() {
      const state = useConfig();
      return <p>{state.status === "error" ? state.message : state.status === "ready" ? state.config.estate.name : "loading"}</p>;
    }
    const first = render(<Reader />);
    await screen.findByText("GET /api/config → 500");
    first.unmount();

    status = 200;
    render(<Reader />);
    await screen.findByText("Lab");
    expect(calls("/api/config")).toBe(2);
  });
});

describe("useUiManifest", () => {
  it("reads /api/ui once for every reader", async () => {
    const calls = stubFetch({ "/api/ui": json(manifest([{ id: "docker", kind: "docker" }])) });
    function Reader() {
      const state = useUiManifest();
      return <p>{state.status === "ready" ? state.manifest.providers.map((p) => p.id).join(",") : state.status}</p>;
    }
    render(
      <>
        <Reader />
        <Reader />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("docker")).toHaveLength(2));
    expect(calls("/api/ui")).toBe(1);
  });
});

describe("useProvider", () => {
  function Reader({ provider }: { provider: string | { kind: string } }) {
    const { envelope, loading } = useProvider<{ id: string }>(provider);
    return <p>{loading ? "loading" : envelope === null ? "not configured" : `data ${envelope.data?.id}`}</p>;
  }

  it("shares one request per poll tick between readers, and stops when none remain", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const calls = stubFetch({
      "/api/ui": json(manifest([{ id: "docker", kind: "docker" }])),
      "/api/providers/docker": json(envelope("docker")),
    });
    const view = render(
      <>
        <Reader provider="docker" />
        <Reader provider="docker" />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByText("data docker")).toHaveLength(2);
    expect(calls("/api/providers/docker")).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_DEFAULTS.pollIntervalMs);
    });
    expect(calls("/api/providers/docker")).toBe(2);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_DEFAULTS.pollIntervalMs * 3);
    });
    expect(calls("/api/providers/docker")).toBe(2);
    expect(calls("/api/ui")).toBe(1);
  });

  it("never requests a provider the manifest does not list", async () => {
    const calls = stubFetch({ "/api/ui": json(manifest([{ id: "gatus", kind: "gatus" }])) });
    render(<Reader provider="docker" />);
    await screen.findByText("not configured");
    expect(calls("/api/providers/docker")).toBe(0);
  });

  it("polls anyway, with a breadcrumb, when the manifest cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls = stubFetch({
      "/api/ui": () => new Response(null, { status: 503 }),
      "/api/providers/docker": json(envelope("docker")),
    });
    render(<Reader provider="docker" />);
    await screen.findByText("data docker");
    expect(calls("/api/providers/docker")).toBe(1);
    // The React path leaves the breadcrumb itself (review L4), once for the failed read.
    expect(warn.mock.calls.filter(([m]) => String(m).includes("UI manifest unavailable"))).toHaveLength(1);
  });

  it("resolves a kind to the first provider of that kind by id", async () => {
    const calls = stubFetch({
      "/api/ui": json(manifest([{ id: "nas-docker", kind: "docker" }, { id: "edge-docker", kind: "docker" }])),
      "/api/providers/edge-docker": json(envelope("edge-docker")),
    });
    render(<Reader provider={{ kind: "docker" }} />);
    await screen.findByText("data edge-docker");
    expect(calls("/api/providers/nas-docker")).toBe(0);
  });

  it("isProviderPollable answers from the manifest", async () => {
    stubFetch({ "/api/ui": json(manifest([{ id: "snapshot", kind: "snapshot" }])) });
    expect(await isProviderPollable("snapshot")).toBe(true);
    expect(await isProviderPollable("docker")).toBe(false);
  });
});

describe("portal data (W9)", () => {
  const PORTAL_CONFIG = {
    ...CONFIG,
    hosts: [{ name: "atlas", kind: "bare-metal", purpose: "Host" }],
    services: [
      { name: "app", host: "atlas", kind: "container", purpose: "App", bindings: { docker: { container: "app" } } },
      { name: "status", host: "atlas", kind: "container", purpose: "Probe", bindings: { gatus: { endpoint: "status" } } },
      { name: "site", host: "atlas", kind: "container", purpose: "Site", bindings: { "http-health": { url: "https://site.test" } } },
      { name: "idle", host: "atlas", kind: "container", purpose: "Unplaced", bindings: { "http-health": { url: "https://idle.test" } } },
    ],
    modules: { portal: { groups: [{ id: "all", title: "All", items: [
      { type: "service", host: "atlas", name: "app" },
      { type: "group", id: "nested", title: "Nested", items: [{ type: "service", host: "atlas", name: "status" }] },
      { type: "service", host: "atlas", name: "site" },
    ] }] } },
  };
  const SITE = "http-health:service:atlas:site";

  it("polls each provider a placed card reads, once per tick, shared with the endpoint pill", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const calls = stubFetch({
      "/api/ui": json({
        ...manifest([{ id: "docker", kind: "docker" }, { id: "gatus", kind: "gatus" }, { id: SITE, kind: "http-health" }, { id: "http-health:service:atlas:idle", kind: "http-health" }]),
        statusKinds: BUILTIN_STATUS_KINDS,
      }),
      "/api/config": json(PORTAL_CONFIG),
      "/api/providers/docker": json(envelope("docker")),
      "/api/providers/gatus": json(envelope("gatus")),
      [`/api/providers/${encodeURIComponent(SITE)}`]: json(envelope(SITE)),
    });
    function Reader() {
      const data = usePortalData();
      return <p>{data.loading ? "loading" : `page ${data.config?.estate.name} ${[...data.envelopes.values()].map((e) => e?.id).join(" ")}`}</p>;
    }
    function Pill() {
      const { envelope: gatus } = useProvider<unknown>("gatus");
      return <p>{`pill ${gatus?.id ?? "none"}`}</p>;
    }
    render(
      <>
        <Reader />
        <Pill />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(`page Lab docker gatus ${SITE}`)).toBeTruthy();
    expect(screen.getByText("pill gatus")).toBeTruthy();
    const counts = () => [calls("/api/config"), calls("/api/providers/docker"), calls("/api/providers/gatus"), calls(`/api/providers/${encodeURIComponent(SITE)}`)];
    expect(counts()).toEqual([1, 1, 1, 1]);
    // A binding no card shows is not polled.
    expect(calls("/api/providers/http-health%3Aservice%3Aatlas%3Aidle")).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_DEFAULTS.pollIntervalMs);
    });
    expect(counts()).toEqual([1, 2, 2, 2]);
  });

  it("polls only the shown groups' visible services; a slow provider blocks only its own cards", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const config = {
      ...PORTAL_CONFIG,
      hosts: [...PORTAL_CONFIG.hosts, { name: "attic", kind: "bare-metal", purpose: "Hidden host", hidden: true }],
      services: [
        ...PORTAL_CONFIG.services,
        { name: "secret", host: "atlas", kind: "container", purpose: "Hidden", hidden: true, bindings: { "http-health": { url: "https://s.test" } } },
        { name: "up-there", host: "attic", kind: "container", purpose: "On a hidden host", bindings: { "http-health": { url: "https://u.test" } } },
      ],
      modules: { portal: { groups: [
        ...PORTAL_CONFIG.modules.portal.groups,
        { id: "other", title: "Other", items: [
          { type: "service", host: "atlas", name: "idle" },
          { type: "service", host: "atlas", name: "secret" },
          { type: "service", host: "attic", name: "up-there" },
        ] },
      ] } },
    };
    const ids = ["docker", "gatus", SITE, "http-health:service:atlas:idle", "http-health:service:atlas:secret", "http-health:service:attic:up-there"];
    const calls = stubFetch({
      "/api/ui": json({ ...manifest(ids.map((id) => ({ id, kind: id.startsWith("http") ? "http-health" : id }))), statusKinds: BUILTIN_STATUS_KINDS }),
      "/api/config": json(config),
      "/api/providers/docker": json(envelope("docker")),
      // gatus never answers: only its card waits.
      "/api/providers/gatus": () => new Promise<Response>(() => {}),
      [`/api/providers/${encodeURIComponent(SITE)}`]: json(envelope(SITE)),
      "/api/providers/http-health%3Aservice%3Aatlas%3Aidle": json(envelope("idle")),
    });
    const seen: string[] = [];
    function Reader({ groups }: { groups?: readonly string[] }) {
      const data = usePortalData(groups);
      const text = data.loading ? "loading" : `ready pending=${[...data.pending].join(",")} read=${[...data.envelopes.keys()].join(",")}`;
      seen.push(text);
      return <p>{text}</p>;
    }
    const all = ["all"];
    const { rerender } = render(<Reader groups={all} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(`ready pending=gatus read=docker,gatus,${SITE}`)).toBeTruthy();
    // The other group's providers, and hidden services' anywhere, are never asked for.
    expect(calls("/api/providers/http-health%3Aservice%3Aatlas%3Aidle")).toBe(0);
    expect(calls("/api/providers/http-health%3Aservice%3Aatlas%3Asecret")).toBe(0);
    expect(calls("/api/providers/http-health%3Aservice%3Aattic%3Aup-there")).toBe(0);

    // Showing another group after load asks for its providers without a skeleton.
    const loadingBefore = seen.filter((text) => text === "loading").length;
    rerender(<Reader groups={["all", "other"]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(seen.filter((text) => text === "loading").length).toBe(loadingBefore);
    expect(screen.getByText(`ready pending=gatus read=docker,gatus,http-health:service:atlas:idle,${SITE}`)).toBeTruthy();
    expect(calls("/api/providers/http-health%3Aservice%3Aatlas%3Aidle")).toBe(1);
    expect(calls("/api/providers/http-health%3Aservice%3Aatlas%3Asecret")).toBe(0);
  });

  it("falls back to the built-in status kinds when the UI manifest cannot be read", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const calls = stubFetch({
      "/api/config": json(PORTAL_CONFIG),
      "/api/providers/docker": json(envelope("docker")),
      "/api/providers/gatus": json(envelope("gatus")),
      [`/api/providers/${encodeURIComponent(SITE)}`]: json(envelope(SITE)),
    });
    function Reader() {
      const data = usePortalData();
      return <p>{data.loading ? "loading" : `kinds ${data.statusKinds.map((kind) => kind.kind).join(" ")}`}</p>;
    }
    render(<Reader />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("kinds docker gatus http-health")).toBeTruthy();
    expect([calls("/api/providers/docker"), calls("/api/providers/gatus")]).toEqual([1, 1]);
  });
});

describe("one /api/config per page load", () => {
  it("the whole shell on / requests the config once", async () => {
    vi.resetModules();
    const calls = stubFetch({
      "/api/ui": json(manifest([{ id: "docker", kind: "docker" }, { id: "gatus", kind: "gatus" }, { id: "snapshot", kind: "snapshot" }])),
      "/api/config": json(CONFIG),
    });
    vi.stubGlobal("location", new URL("http://localhost/"));
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    await import("../src/shell/health-header/slot.js");
    await import("../src/registry/discover.js");
    const { App } = await import("../src/shell/App.js");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Portal" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(calls("/api/config")).toBe(1);
    expect(calls("/api/ui")).toBe(1);
  });
});

describe("review round 1 regressions", () => {
  const TICK = POLL_DEFAULTS.pollIntervalMs;
  const fake = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  const flush = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("L1: a failed /api/config is asked again each poll while it fails, without flashing to loading", async () => {
    fake();
    let status = 503;
    const calls = stubFetch({ "/api/config": () => (status === 200 ? Response.json(CONFIG) : new Response(null, { status })) });
    const seen: string[] = [];
    function Reader() {
      const state = useConfig();
      seen.push(state.status);
      return <p>{state.status === "ready" ? state.config.estate.name : state.status}</p>;
    }
    render(<Reader />);
    await flush();
    expect(screen.getByText("error")).toBeTruthy();
    await flush(TICK);
    expect(calls("/api/config")).toBe(2);
    // Still failing: the re-ask never shows loading once an error was seen.
    expect(seen.slice(seen.indexOf("error"))).not.toContain("loading");
    status = 200;
    await flush(TICK);
    expect(screen.getByText("Lab")).toBeTruthy();
    expect(calls("/api/config")).toBe(3);
    // Healthy: no more config requests.
    await flush(TICK * 3);
    expect(calls("/api/config")).toBe(3);
  });

  it("L2: with /api/ui down, a re-ask never blanks provider readers or double-requests them", async () => {
    fake();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls = stubFetch({
      "/api/ui": () => new Response(null, { status: 503 }),
      "/api/providers/docker": json(envelope("docker")),
    });
    const seen: string[] = [];
    function Reader() {
      const { envelope: e, loading } = useProvider<{ id: string }>("docker");
      const label = loading ? "loading" : e === null ? "none" : "data";
      seen.push(label);
      return <p>{label}</p>;
    }
    render(<Reader />);
    await flush();
    expect(screen.getByText("data")).toBeTruthy();
    // The reviewer's probe: a store asks for the manifest again (as every inventory poll does).
    await act(async () => {
      expect(await isProviderPollable("docker")).toBe(true);
      expect(await isProviderPollable("docker")).toBe(true);
    });
    expect(seen.slice(seen.indexOf("data"))).not.toContain("loading");
    expect(calls("/api/providers/docker")).toBe(1);
    expect(calls("/api/ui")).toBe(1);
    // After one interval the failed manifest is asked again, still without a blank.
    await flush(TICK);
    await act(async () => {
      await isProviderPollable("docker");
    });
    expect(calls("/api/ui")).toBe(2);
    expect(seen.slice(seen.indexOf("data"))).not.toContain("loading");
  });

  it("C2/L5: a reader joining within an interval reuses the shared envelope; after an interval unread it reloads", async () => {
    fake();
    const calls = stubFetch({
      "/api/ui": json(manifest([{ id: "docker", kind: "docker" }])),
      "/api/providers/docker": json(envelope("docker")),
    });
    function Reader({ label }: { label: string }) {
      const { envelope: e, loading } = useProvider<{ id: string }>("docker");
      return <p>{`${label} ${loading ? "loading" : e === null ? "none" : "data"}`}</p>;
    }
    const first = render(<Reader label="header" />);
    await flush();
    expect(calls("/api/providers/docker")).toBe(1);

    // The reviewer's probe: a page mounts a second reader a second later.
    await flush(1_000);
    const late = render(<Reader label="page" />);
    await flush();
    expect(screen.getByText("page data")).toBeTruthy();
    expect(calls("/api/providers/docker")).toBe(1);

    // Everyone leaves; after more than one interval unread, the envelope is dropped.
    late.unmount();
    first.unmount();
    await flush(TICK + 1_000);
    render(<Reader label="back" />);
    expect(screen.getByText("back loading")).toBeTruthy();
    await flush();
    expect(screen.getByText("back data")).toBeTruthy();
    expect(calls("/api/providers/docker")).toBe(2);
  });

  it("L7: the last reader leaving mid-request logs no failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ui") return Promise.resolve(Response.json(manifest([{ id: "docker", kind: "docker" }])));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    function Reader() {
      const { loading } = useProvider("docker");
      return <p>{loading ? "loading" : "done"}</p>;
    }
    const view = render(<Reader />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/providers/docker")).toBe(true));
    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(warn.mock.calls.filter(([m]) => String(m).includes("request failed"))).toEqual([]);
  });
});

describe("review round 2 regressions", () => {
  it("N1: with readers only, a recovered /api/ui is picked up within one tick and unlisted providers stop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let manifestUp = false;
    const calls = stubFetch({
      "/api/ui": () => (manifestUp ? Response.json(manifest([{ id: "docker", kind: "docker" }])) : new Response(null, { status: 503 })),
      "/api/providers/docker": json(envelope("docker")),
      "/api/providers/gatus": json(envelope("gatus")),
    });
    function Reader({ provider }: { provider: string }) {
      const { envelope: e, loading } = useProvider<{ id: string }>(provider);
      return <p>{`${provider} ${loading ? "loading" : e === null ? "none" : "data"}`}</p>;
    }
    const tick = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    // The reviewer's probe: portal-style readers only (no store calls isProviderPollable).
    render(
      <>
        <Reader provider="docker" />
        <Reader provider="gatus" />
      </>,
    );
    await tick(0);
    // Unavailable: every provider is polled, the unlisted gatus included.
    expect(screen.getByText("gatus data")).toBeTruthy();
    expect(calls("/api/providers/gatus")).toBe(1);

    manifestUp = true;
    await tick(POLL_DEFAULTS.pollIntervalMs);
    expect(calls("/api/ui")).toBe(2);
    expect(screen.getByText("gatus none")).toBeTruthy();
    const gatusAfterHeal = calls("/api/providers/gatus");
    // Healed, the manifest is no longer asked every poll interval, only every refresh interval.
    await tick(UI_MANIFEST_REFRESH_MS - 1);
    expect(calls("/api/ui")).toBe(2);
    await tick(1);
    expect(calls("/api/ui")).toBe(3);
    await tick(POLL_DEFAULTS.pollIntervalMs);
    expect(calls("/api/providers/gatus")).toBe(gatusAfterHeal);
    expect(calls("/api/ui")).toBe(3);
    expect(screen.getByText("docker data")).toBeTruthy();
  });
});

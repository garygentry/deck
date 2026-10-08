// @vitest-environment jsdom
import type { LlmUsageResponse, UsageBar } from "@deck/server/llm-usage";
import { focusManager, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TONES, type StatusMap } from "@/ui";

import { LlmUsagePage } from "../src/features/llm-usage/LlmUsagePage.js";
import { LlmUsagePortalCardContent } from "../src/features/llm-usage/LlmUsagePortalCard.js";
import { LlmUsageSummaryContent } from "../src/features/llm-usage/LlmUsageSummary.js";
import {
  POLL_MODE_UI,
  SEVERITY_UI,
  SOURCE_STATE_UI,
  formatResetIn,
  worstBar,
} from "../src/features/llm-usage/status.js";
import { createUsageStore, llmUsageKey, type UsageStore, type UsageView } from "../src/features/llm-usage/store.js";
import { createDeckQueryClient } from "../src/data/query-client.js";
import { AA_TEXT_TOKENS } from "./support/tokens.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const MIN = 60_000;

const bar = (overrides: Partial<UsageBar>): UsageBar => ({
  key: "session",
  label: "Current session",
  group: "session",
  percent: 40,
  resetsAt: NOW + 134 * MIN,
  reached: false,
  severity: "normal",
  src: "oauth",
  observedAt: NOW - 3 * MIN,
  ...overrides,
});

const response = (overrides: Partial<LlmUsageResponse> = {}): LlmUsageResponse => ({
  enabled: true,
  now: NOW,
  poll: { mode: "idle", nextPollAt: NOW + 4 * MIN, consecutiveErrors: 0 },
  thresholds: { warn: 75, danger: 90 },
  claude: {
    plan: "max",
    bars: [
      bar({}),
      bar({ key: "model:Opus", label: "Opus", group: "weekly", percent: 82, severity: "warn", src: "statusLine" }),
    ],
    sources: [
      { id: "claude.statusLine", state: "available", observedAt: NOW - MIN, detail: null },
      { id: "claude.oauth", state: "stale", observedAt: NOW - 10 * MIN, detail: "HTTP 429" },
      { id: "claude.transcripts", state: "not-configured", observedAt: null, detail: "no transcriptsDir configured" },
    ],
    transcripts: null,
  },
  codex: {
    plan: "plus",
    resetCredits: 2,
    bars: [bar({ key: "codex:primary", label: "Codex · 5h limit", percent: 12, src: "app-server" })],
    sources: [
      { id: "codex.appServer", state: "available", observedAt: NOW, detail: null },
      { id: "codex.rollout", state: "no-data-yet", observedAt: null, detail: "no rollout files yet" },
      { id: "codex.history", state: "available", observedAt: NOW, detail: null },
    ],
    history: {
      lifetimeTokens: 1_250_000,
      peakDailyTokens: 90_000,
      currentStreakDays: 3,
      longestStreakDays: 9,
      longestRunningTurnSec: null,
      days: [{ date: "2026-09-22", tokens: 1200 }, { date: "2026-09-23", tokens: 3400 }],
    },
  },
  ...overrides,
});

/** A static store over a fixed view; `refresh` is observable. */
function staticStore(view: UsageView) {
  return { subscribe: () => () => {}, getSnapshot: () => view, refresh: vi.fn(async () => {}), reload: vi.fn(async () => {}) } satisfies UsageStore;
}

const ready = (data: LlmUsageResponse, error: string | null = null): UsageView => ({ status: "ready", data, error, clockOffsetMs: 0 });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LlmUsagePage", () => {
  it("renders a meter per bar with value, tone text, reset and source", () => {
    render(<LlmUsagePage store={staticStore(ready(response()))} now={NOW} />);
    expect(screen.getByRole("heading", { level: 1, name: "LLM usage" })).toBeInTheDocument();

    const opus = screen.getByRole("meter", { name: "Opus" });
    expect(opus).toHaveAttribute("aria-valuenow", "82");
    expect(opus).toHaveAttribute("aria-valuetext", "82% used, nearing limit");
    const session = screen.getByRole("meter", { name: "Current session" });
    const meta = session.closest("[data-slot=meter]")!;
    expect(meta).toHaveTextContent("Resets in 2h 14m");
    expect(meta).toHaveTextContent("via OAuth, 3m ago");
    expect(meta).toHaveAttribute("data-tone", "ok");

    const claude = screen.getByRole("region", { name: "Claude Code" });
    expect(within(claude).getByText("Plan: max")).toBeInTheDocument();
    const codex = screen.getByRole("region", { name: "Codex" });
    expect(within(codex).getByText("Reset credits: 2")).toBeInTheDocument();
    expect(within(codex).getByRole("meter", { name: "Codex · 5h limit" })).toBeInTheDocument();
  });

  it("shows Codex history newest first", () => {
    render(<LlmUsagePage store={staticStore(ready(response()))} now={NOW} />);
    const history = screen.getByRole("region", { name: "Usage history" });
    expect(within(history).getByText("1.3M")).toBeInTheDocument();
    const rows = within(history).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(["2026-09-233,400", "2026-09-221,200"]);
  });

  it("lists every source with its state in a collapsed diagnostics disclosure", () => {
    render(<LlmUsagePage store={staticStore(ready(response()))} now={NOW} />);
    const toggle = screen.getByRole("button", { name: /Sources and polling/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1"); // one stale source needs attention
    fireEvent.click(toggle);
    const claudeSources = screen.getByRole("region", { name: "Claude Code sources" });
    const oauth = within(claudeSources).getByText("OAuth usage endpoint").closest("li")!;
    expect(oauth).toHaveTextContent("Stale");
    expect(oauth).toHaveTextContent("HTTP 429");
    expect(screen.queryByText("Backing off")).toBeNull();
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("counts down on the server clock and retries with a plain re-read", async () => {
    const view: UsageView = { status: "ready", data: response(), error: null, clockOffsetMs: 10 * MIN };
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    render(<LlmUsagePage store={staticStore(view)} />);
    // Browser clock is NOW but the server is 10 minutes ahead: 2h14m - 10m.
    expect(screen.getByRole("meter", { name: "Current session" }).closest("[data-slot=meter]")).toHaveTextContent("Resets in 2h 4m");
    cleanup();

    const store = staticStore({ status: "error", message: "HTTP 500" });
    render(<LlmUsagePage store={store} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(store.reload).toHaveBeenCalledTimes(1);
    expect(store.refresh).not.toHaveBeenCalled();
  });

  it("refreshes through the store", async () => {
    const store = staticStore(ready(response()));
    render(<LlmUsagePage store={store} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(store.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  });

  it("explains a not-configured feature, loading and errors", () => {
    const { rerender } = render(<LlmUsagePage store={staticStore(ready(response({ enabled: false, claude: null, codex: null })))} now={NOW} />);
    expect(screen.getByText("LLM usage is not configured")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();

    rerender(<LlmUsagePage store={staticStore({ status: "loading" })} now={NOW} />);
    expect(screen.getByText("Loading LLM usage")).toBeInTheDocument();

    rerender(<LlmUsagePage store={staticStore({ status: "error", message: "HTTP 500" })} now={NOW} />);
    expect(screen.getByText("LLM usage is unavailable")).toBeInTheDocument();

    rerender(<LlmUsagePage store={staticStore(ready(response(), "HTTP 502"))} now={NOW} />);
    expect(screen.getByRole("status")).toHaveTextContent("The latest refresh failed (HTTP 502)");
  });

  it("distinguishes 'no data yet' from 'plan limits do not apply'", () => {
    const base = response();
    const claude = {
      ...base.claude!,
      bars: [],
      sources: [{ id: "claude.statusLine" as const, state: "not-applicable" as const, observedAt: NOW, detail: null }],
    };
    const { rerender } = render(<LlmUsagePage store={staticStore(ready({ ...base, claude, codex: null }))} now={NOW} />);
    expect(screen.getByText("Plan limits do not apply")).toBeInTheDocument();
    rerender(<LlmUsagePage store={staticStore(ready({ ...base, claude: { ...claude, sources: [] }, codex: null }))} now={NOW} />);
    expect(screen.getByText("No usage reported yet")).toBeInTheDocument();
    const signIn = [{ id: "claude.oauth" as const, state: "not-configured" as const, observedAt: null, detail: "sign-in needed" }];
    rerender(<LlmUsagePage store={staticStore(ready({ ...base, claude: { ...claude, sources: signIn }, codex: null }))} now={NOW} />);
    expect(screen.getByText(/OAuth usage endpoint: sign-in needed/)).toBeInTheDocument();
  });
});

describe("LlmUsageSummary pill", () => {
  it("links to the page with the tightest limit", () => {
    render(<LlmUsageSummaryContent store={staticStore(ready(response()))} />);
    const pill = screen.getByRole("link", { name: /LLM usage/ });
    expect(pill).toHaveAttribute("href", "/usage");
    expect(pill).toHaveAttribute("data-tone", "warn");
    expect(pill).toHaveAccessibleName("LLM usage 82% used on Opus");
    expect(pill.querySelector("[data-slot=health-pill-count]")).toHaveTextContent("82%");
  });

  it("renders nothing when disabled, loading or empty", () => {
    const empty = response();
    empty.claude!.bars = [];
    empty.codex!.bars = [];
    for (const view of [
      ready(response({ enabled: false, claude: null, codex: null })),
      { status: "loading" } as const,
      ready(empty),
    ]) {
      const { container, unmount } = render(<LlmUsageSummaryContent store={staticStore(view)} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

describe("LlmUsagePortalCard", () => {
  it("shows the tightest limit per provider as linked tiles", () => {
    render(<LlmUsagePortalCardContent store={staticStore(ready(response()))} now={NOW} />);
    const grid = screen.getByLabelText("LLM usage");
    const links = within(grid).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/usage", "/usage"]);
    expect(links[0]).toHaveTextContent("Claude Code · Opus82%Nearing limit · resets in 2h 14m");
    expect(links[1]).toHaveTextContent("Codex · Codex · 5h limit12%");
  });

  it("renders nothing when off or without bars", () => {
    const empty = response();
    empty.claude!.bars = [];
    empty.codex!.bars = [];
    for (const view of [ready(response({ enabled: false, claude: null, codex: null })), ready(empty)]) {
      const { container, unmount } = render(<LlmUsagePortalCardContent store={staticStore(view)} now={NOW} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

describe("usage store", () => {
  const ok = (data: LlmUsageResponse) => new Response(JSON.stringify(data), { status: 200 });
  const urls = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map(([url]) => url);
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    client = createDeckQueryClient();
    focusManager.setFocused(true);
  });
  afterEach(() => {
    client.clear();
    focusManager.setFocused(undefined);
  });

  it("polls on the shared query client only while subscribed and visible", async () => {
    const fetchMock = vi.fn(async (_url: string) => ok(response()));
    const store = createUsageStore({ client, fetch: fetchMock as never, intervalMs: 15_000 });
    expect(fetchMock).not.toHaveBeenCalled();

    const off = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(urls(fetchMock)).toEqual(["/api/llm-usage"]);
    expect(store.getSnapshot().status).toBe("ready");
    expect(client.getQueryData(llmUsageKey)).toMatchObject({ data: { now: NOW } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Back to visible: one poll at once, and the interval restarts from it.
    await vi.advanceTimersByTimeAsync(5_000);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    off();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not read while hidden, even on the first subscription", async () => {
    const fetchMock = vi.fn(async () => ok(response()));
    const store = createUsageStore({ client, fetch: fetchMock as never, intervalMs: 15_000 });
    focusManager.setFocused(false);
    store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({ status: "loading" });
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves every reader from one request per tick", async () => {
    const fetchMock = vi.fn(async () => ok(response()));
    // Two readers on the shared client (the store the page and pill share, and any other).
    createUsageStore({ client, fetch: fetchMock as never, intervalMs: 15_000 }).subscribe(() => {});
    createUsageStore({ client, fetch: fetchMock as never, intervalMs: 15_000 }).subscribe(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops for good once the feature is reported off", async () => {
    const fetchMock = vi.fn(async () => ok(response({ enabled: false, claude: null, codex: null })));
    const store = createUsageStore({ client, fetch: fetchMock as never, intervalMs: 15_000 });
    const off = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    off();
    // A later reader (another store on the same client, as after a remount) does not ask again.
    createUsageStore({ client, fetch: fetchMock as never, intervalMs: 15_000 }).subscribe(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", data: { enabled: false } });
  });

  it("keeps the last good data on a failed poll, and refresh hits the refresh route", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/refresh") ? new Response("", { status: 502 }) : ok(response())));
    const store = createUsageStore({ client, fetch: fetchMock as never, intervalMs: 15_000 });
    store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await act(() => store.refresh());
    expect(urls(fetchMock).at(-1)).toBe("/api/llm-usage/refresh");
    expect(store.getSnapshot()).toMatchObject({ status: "ready", data: { now: NOW }, error: "HTTP 502" });
    // The refresh route was a one-shot: the query's own function still reads the state route.
    await act(() => client.refetchQueries({ queryKey: llmUsageKey }));
    expect(urls(fetchMock).at(-1)).toBe("/api/llm-usage");
    // The next good poll clears the error.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: null });

    const failing = createUsageStore({ client: createDeckQueryClient(), fetch: vi.fn(async () => { throw new TypeError("offline"); }) as never });
    failing.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.getSnapshot()).toEqual({ status: "error", message: "offline" });
  });

  it("never steps back: a slow poll resolving after a newer refresh is ignored", async () => {
    let releasePoll: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/refresh")) return ok(response({ now: NOW + 1_000 }));
      if (fetchMock.mock.calls.length === 1) return ok(response());
      return new Promise<Response>((resolve) => (releasePoll = resolve));
    });
    const store = createUsageStore({ client, fetch: fetchMock as never, intervalMs: 15_000 });
    store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(() => store.refresh());
    expect(store.getSnapshot()).toMatchObject({ data: { now: NOW + 1_000 } });
    const seen = store.getSnapshot();
    releasePoll(ok(response({ now: NOW - 60_000 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toBe(seen);

    // A plain re-read that answers older than the cache keeps the cache, too.
    fetchMock.mockImplementationOnce(async () => ok(response({ now: NOW - 60_000 })));
    await act(() => store.reload());
    expect(store.getSnapshot()).toMatchObject({ data: { now: NOW + 1_000 } });
  });
});

describe("llm-usage status helpers", () => {
  const maps: ReadonlyArray<[string, StatusMap<string>]> = [
    ["SEVERITY_UI", SEVERITY_UI],
    ["SOURCE_STATE_UI", SOURCE_STATE_UI],
    ["POLL_MODE_UI", POLL_MODE_UI],
  ];
  for (const [name, map] of maps) {
    it(`${name} uses only AA-guaranteed tones`, () => {
      for (const presentation of Object.values(map)) {
        expect(TONES).toContain(presentation.tone);
        expect(AA_TEXT_TOKENS).toContain(`--status-${presentation.tone}-fg`);
      }
    });
  }

  it("keeps unconfigured and not-applicable sources quiet", () => {
    expect(SOURCE_STATE_UI["not-configured"].tone).toBe("neutral");
    expect(SOURCE_STATE_UI["not-applicable"].tone).toBe("neutral");
    expect(SOURCE_STATE_UI.error.tone).toBe("danger");
  });

  it("formats reset countdowns", () => {
    expect(formatResetIn(NOW - 1, NOW)).toBe("reset due");
    expect(formatResetIn(NOW + 30_000, NOW)).toBe("in <1m");
    expect(formatResetIn(NOW + 42 * MIN, NOW)).toBe("in 42m");
    expect(formatResetIn(NOW + 134 * MIN, NOW)).toBe("in 2h 14m");
    expect(formatResetIn(NOW + 52 * 60 * MIN, NOW)).toBe("in 2d 4h");
  });

  it("picks the worst bar by severity, then percent", () => {
    const data = response();
    expect(worstBar(data)?.key).toBe("model:Opus");
    data.codex!.bars.push(bar({ key: "codex:secondary", percent: 60, severity: "danger", reached: true }));
    expect(worstBar(data)?.key).toBe("codex:secondary");
    expect(worstBar(response({ claude: null, codex: null }))).toBeNull();
  });
});

// @vitest-environment jsdom
import { POLL_DEFAULTS } from "@deck/server";
import type { FreshnessStamp, ProviderEnvelope } from "@deck/server";
import { createElement as h } from "react";
import { mount as render } from "./support/render.js";
import { act } from "./support/render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  httpStatusResponse,
  installEnv,
  jsonResponse,
  resetInventoryTestEnv,
  type Env,
} from "./inventory-harness.js";
import {
  usePrometheusData,
  type PrometheusData,
  type PrometheusResult,
} from "../src/features/alerts-and-health/usePrometheusData.js";
import {
  useAlertmanagerData,
  type AlertmanagerData,
  type AlertmanagerResult,
} from "../src/features/alerts-and-health/useAlertmanagerData.js";

const fresh: FreshnessStamp = {
  state: "fresh",
  observedAt: "2026-09-15T00:00:00.000Z",
  ageMs: 1_000,
  ttlMs: 30_000,
};

/** The flattened shape both hooks return — structurally identical across providers. */
type FlatData = PrometheusData | AlertmanagerData;

interface HookCase {
  readonly name: string;
  readonly url: string;
  readonly hook: (intervalMs?: number) => FlatData;
  readonly result: PrometheusResult | AlertmanagerResult;
}

const CASES: readonly HookCase[] = [
  {
    name: "usePrometheusData",
    url: "/api/providers/prometheus",
    hook: usePrometheusData,
    result: { summaries: [{ id: "cpu", label: "CPU", value: 42, status: "ok" }] },
  },
  {
    name: "useAlertmanagerData",
    url: "/api/providers/alertmanager",
    hook: useAlertmanagerData,
    result: { alerts: [], silences: [], firingCount: 0 },
  },
];

/** Mount a probe that records every value the hook yields; returns the recorded states + a teardown. */
function mountHook(
  env: Env,
  hook: (intervalMs?: number) => FlatData,
  intervalMs?: number,
): { states: FlatData[]; unmount(): void } {
  const states: FlatData[] = [];
  const Probe = () => {
    states.push(hook(intervalMs));
    return null;
  };
  act(() => {
    render(h(Probe, {}), env.root as never);
  });
  return {
    states,
    unmount() {
      act(() => {
        render(null, env.root as never);
      });
    },
  };
}

/** Advance fake timers and flush the async poll's microtasks inside an act() batch. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("alerts-and-health data hooks", () => {
  afterEach(() => {
    resetInventoryTestEnv();
  });

  describe.each(CASES)("$name", ({ url, hook, result }) => {
    it("polls its endpoint on POLL_DEFAULTS.pollIntervalMs by default and clears on unmount", async () => {
      vi.useFakeTimers();
      const env = installEnv();
      const envelope: ProviderEnvelope<typeof result> = {
        id: "x",
        kind: "x",
        data: result,
        error: null,
        freshness: fresh,
      };
      // The hook first consults the provider index; list both alerts providers
      // so it polls through to the endpoint exactly as before gating.
      const index = {
        providers: [
          { id: "prometheus", kind: "prometheus" },
          { id: "alertmanager", kind: "alertmanager" },
        ],
      };
      const fetchMock = vi.fn((reqUrl: string) =>
        Promise.resolve(reqUrl === "/api/providers" ? jsonResponse(index) : jsonResponse(envelope)),
      );
      vi.stubGlobal("fetch", fetchMock);
      const providerCalls = (): number =>
        fetchMock.mock.calls.filter((call) => call[0] === url).length;

      const probe = mountHook(env, hook);
      await advance(0); // flush the immediate poll()

      // The index is fetched once (memoized); the endpoint is polled per tick.
      expect(fetchMock.mock.calls.some((call) => call[0] === "/api/providers")).toBe(true);
      expect(providerCalls()).toBe(1);

      await advance(POLL_DEFAULTS.pollIntervalMs);
      expect(providerCalls()).toBe(2);

      await advance(POLL_DEFAULTS.pollIntervalMs);
      expect(providerCalls()).toBe(3);

      // Interval cleanup: after unmount no further poll fires.
      probe.unmount();
      await advance(POLL_DEFAULTS.pollIntervalMs * 3);
      expect(providerCalls()).toBe(3);
    });

    it("never polls the endpoint when the provider is absent from the index (not configured)", async () => {
      vi.useFakeTimers();
      const env = installEnv();
      // The index lists a different provider, so this one is unregistered.
      const fetchMock = vi.fn((reqUrl: string) =>
        Promise.resolve(
          jsonResponse(
            reqUrl === "/api/providers"
              ? { providers: [{ id: "something-else", kind: "other" }] }
              : {},
          ),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const probe = mountHook(env, hook);
      await advance(0);
      await advance(POLL_DEFAULTS.pollIntervalMs * 3);

      // The endpoint is never requested — that is what removes the console 404 —
      // and the hook still resolves to the not-configured render.
      expect(fetchMock.mock.calls.some((call) => call[0] === url)).toBe(false);
      expect(probe.states.at(-1)).toEqual({
        data: null,
        freshness: null,
        error: null,
        loading: false,
      });
      probe.unmount();
    });

    it("maps a present envelope's data/freshness/error through with loading:false", async () => {
      vi.useFakeTimers();
      const env = installEnv();
      const envelope: ProviderEnvelope<typeof result> = {
        id: "x",
        kind: "x",
        data: result,
        error: null,
        freshness: fresh,
      };
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(envelope))));

      const probe = mountHook(env, hook);
      await advance(0);

      const last = probe.states.at(-1)!;
      expect(last).toEqual({
        data: result,
        freshness: fresh,
        error: null,
        loading: false,
      });
    });

    it("maps a present unreachable envelope's error through without fabricating a healthy 0", async () => {
      vi.useFakeTimers();
      const env = installEnv();
      const envelope: ProviderEnvelope<typeof result> = {
        id: "x",
        kind: "x",
        data: null,
        error: { message: "endpoint unreachable" },
        freshness: { ...fresh, state: "unreachable" },
      };
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(envelope))));

      const probe = mountHook(env, hook);
      await advance(0);

      const last = probe.states.at(-1)!;
      expect(last.data).toBeNull();
      expect(last.error).toEqual({ message: "endpoint unreachable" });
      expect(last.freshness?.state).toBe("unreachable");
      expect(last.loading).toBe(false);
    });

    it("resolves a 404 to the all-null not-configured shape", async () => {
      vi.useFakeTimers();
      const env = installEnv();
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(httpStatusResponse(404))));

      const probe = mountHook(env, hook);
      await advance(0);

      const last = probe.states.at(-1)!;
      expect(last).toEqual({
        data: null,
        freshness: null,
        error: null,
        loading: false,
      });
    });

    it("drops a late response after unmount via the live guard", async () => {
      vi.useFakeTimers();
      const env = installEnv();
      const gate = deferred<Response>();
      vi.stubGlobal("fetch", vi.fn(() => gate.promise));

      const probe = mountHook(env, hook);
      const settledBeforeUnmount = probe.states.length;

      // Unmount while the first poll is still in flight, then let it resolve.
      probe.unmount();
      const envelope: ProviderEnvelope<typeof result> = {
        id: "x",
        kind: "x",
        data: result,
        error: null,
        freshness: fresh,
      };
      await act(async () => {
        gate.resolve(jsonResponse(envelope));
        await gate.promise;
        await Promise.resolve();
      });

      // The live guard prevents any post-unmount setState — no new recorded render.
      expect(probe.states.length).toBe(settledBeforeUnmount);
      // Whatever it last showed, it never advanced past the initial loading render.
      expect(probe.states.at(-1)?.loading).toBe(true);
    });
  });
});

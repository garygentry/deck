import { Hono } from "hono";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLogger,
  requestLogger,
  type ConfigLoadEvent,
  type ProviderPollEvent,
  type RequestLogEvent,
  type ServerStartEvent,
} from "../src/log/logger.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createLogger", () => {
  it("resolves level from options, then DECK_LOG_LEVEL, then info", () => {
    vi.stubEnv("DECK_LOG_LEVEL", "debug");
    expect(createLogger({ level: "error" }).level).toBe("error");
    expect(createLogger().level).toBe("debug");

    vi.unstubAllEnvs();
    expect(createLogger().level).toBe("info");
  });

  it("returns a pino logger and merges base fields into each line", () => {
    const log = createLogger({ level: "silent", base: { service: "deck-server" } });
    expect(log).toHaveProperty("info");
    expect(log).toHaveProperty("levels", pino.levels);
  });
});

it("gives every typed lifecycle event a stable event discriminator", () => {
  const events: [ServerStartEvent, ConfigLoadEvent, ProviderPollEvent, RequestLogEvent] = [
    { event: "server.start", port: 8080, providerCount: 2, webDist: "present" },
    {
      event: "config.load",
      result: "clean",
      counts: { error: 0, warning: 0, info: 0 },
      configDir: "/config",
    },
    {
      event: "provider.poll",
      id: "health",
      kind: "http-health",
      ok: true,
      latencyMs: 4,
      from: "pending",
      to: "fresh",
    },
    { event: "request", method: "GET", path: "/api/health", status: 200, durationMs: 1 },
  ];

  expect(events.map(({ event }) => event)).toEqual([
    "server.start",
    "config.load",
    "provider.poll",
    "request",
  ]);
});

describe("requestLogger", () => {
  it.each([
    [200, "info"],
    [404, "info"],
    [500, "warn"],
  ] as const)("logs status %i once at %s without bodies or a stack", async (status, level) => {
    const info = vi.fn();
    const warn = vi.fn();
    const log = { info, warn } as unknown as Logger;
    const app = new Hono();
    app.use("*", requestLogger(log));
    app.post("/resource", (context) => context.json({ responseSecret: "do-not-log" }, status));

    await app.request("http://deck.test/resource?token=query", {
      method: "POST",
      body: "requestSecret=do-not-log",
    });

    const called = level === "warn" ? warn : info;
    const notCalled = level === "warn" ? info : warn;
    expect(called).toHaveBeenCalledOnce();
    expect(notCalled).not.toHaveBeenCalled();
    const [event] = called.mock.calls[0] as [RequestLogEvent, string];
    expect(event).toMatchObject({ event: "request", method: "POST", path: "/resource", status });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(event)).not.toMatch(/requestSecret|responseSecret|do-not-log|stack|token/);
  });
});

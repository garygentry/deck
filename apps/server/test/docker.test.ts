import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../src/contract/index.js";
import { logger } from "../src/log/logger.js";
import { DockerProvider } from "../../../modules/docker/server/index.js";
import { read, register, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { processEnv, registerDocker } from "./util/register-kinds.js";

describe("DockerProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.DECK_DOCKER_TOKEN;
  });

  it("maps names, run states, health suffixes, and raw statuses", async () => {
    const raw = [
      { Names: ["/healthy"], State: "running", Status: "Up 2 hours (healthy)" },
      { Names: ["paused"], State: "paused", Status: "Up 1 minute (unhealthy)" },
      { Names: ["/starting"], State: "restarting", Status: "Up 2 seconds (health: starting)" },
      { Names: ["/stopped"], State: "exited", Status: "Exited (0) 1 hour ago" },
      { Names: ["/created"], State: "created", Status: "Created" },
      { Names: ["/dead"], State: "dead" },
      {},
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(raw)));

    await expect(new DockerProvider("docker", { baseUrl: "http://proxy" }).fetch()).resolves.toEqual({
      containers: [
        { name: "healthy", state: "running", health: "healthy", status: "Up 2 hours (healthy)" },
        { name: "paused", state: "paused", health: "unhealthy", status: "Up 1 minute (unhealthy)" },
        { name: "starting", state: "restarting", health: "starting", status: "Up 2 seconds (health: starting)" },
        { name: "stopped", state: "exited", health: "none", status: "Exited (0) 1 hour ago" },
        { name: "created", state: "exited", health: "none", status: "Created" },
        { name: "dead", state: "exited", health: "none", status: "" },
        { name: "", state: "exited", health: "none", status: "" },
      ],
    });
  });

  it("issues exactly one read-only GET and removes one trailing base-url slash", async () => {
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetchStub);

    await new DockerProvider("docker", { baseUrl: "http://proxy/" }).fetch();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith("http://proxy/containers/json?all=true", {
      method: "GET",
      headers: {},
    });
    expect(fetchStub.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("resolves credentials from the environment at fetch time and omits absent credentials", async () => {
    const config = { baseUrl: "http://proxy", credentialEnv: "DECK_DOCKER_TOKEN", env: processEnv };
    const provider = new DockerProvider("docker", config);
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetchStub);

    process.env.DECK_DOCKER_TOKEN = "Bearer first";
    await provider.fetch();
    process.env.DECK_DOCKER_TOKEN = "Bearer rotated";
    await provider.fetch();
    delete process.env.DECK_DOCKER_TOKEN;
    await provider.fetch();

    expect(fetchStub.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { Authorization: "Bearer first" },
      { Authorization: "Bearer rotated" },
      {},
    ]);
    expect(config).toEqual({ baseUrl: "http://proxy", credentialEnv: "DECK_DOCKER_TOKEN", env: processEnv });
    expect(JSON.stringify(provider)).not.toContain("Bearer");
  });

  it("treats a non-2xx response as a successful empty fresh poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const provider = new DockerProvider("direct", { baseUrl: "http://proxy" });
    await expect(provider.fetch()).resolves.toEqual({ containers: [] });

    registerDocker("docker", { baseUrl: "http://proxy", timing: { pollIntervalMs: 10_000 } });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(read("docker")).toMatchObject({
      freshness: { state: "fresh" },
      data: { containers: [] },
      error: null,
    });
  });

  // The parse error's wording is the runtime's own (V8: "Unexpected token …", Bun: "Failed to
  // parse JSON"), and the envelope passes it through verbatim, so expect what this runtime says.
  const jsonParseMessage = () => new Response("not-json").json().then(
    () => "",
    (error: Error) => error.message,
  );

  it.each([
    ["transport rejection", () => Promise.reject(new Error("connection refused")), async () => "connection refused"],
    ["malformed JSON", () => Promise.resolve(new Response("not-json", { status: 200 })), jsonParseMessage],
  ])("throws on %s and publishes unreachable while retaining prior data", async (_label, failure, expectedMessage) => {
    const message = await expectedMessage();
    expect(message).not.toBe("");
    // Persistent failure so the second poll fails deterministically; health() is now non-I/O.
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(Response.json([{ Names: ["/cached"], State: "running", Status: "Up (healthy)" }]))
      .mockImplementation(failure);
    vi.stubGlobal("fetch", fetchStub);
    registerDocker("docker", { baseUrl: "http://proxy", timing: { pollIntervalMs: 1_000 } });
    register(makeProvider("sibling", async () => ({ ok: true })), { pollIntervalMs: 1_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    const prior = read("docker")?.data;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(read("docker")).toMatchObject({
      freshness: { state: "unreachable" },
      data: prior,
      error: { message: expect.stringContaining(message) },
    });
    expect(read("sibling")).toMatchObject({ freshness: { state: "fresh" }, data: { ok: true }, error: null });
  });

  it("returns cached non-I/O health that never calls fetch itself", async () => {
    const fetchStub = vi.fn(async () => Response.json([{ Names: ["/a"], State: "running", Status: "Up" }]));
    vi.stubGlobal("fetch", fetchStub);
    const provider = new DockerProvider("docker", { baseUrl: "http://proxy" });

    // Before any poll: awaiting, and health() alone issues no request.
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "Awaiting first poll" });
    expect(fetchStub).not.toHaveBeenCalled();

    // A successful fetch caches the container-count health; health() reads it without a new request.
    await provider.fetch();
    await expect(provider.health()).resolves.toEqual({ ok: true, detail: "1 containers" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("caches unhealthy detail via catch-before-rethrow while fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const provider = new DockerProvider("docker", { baseUrl: "http://proxy" });

    await expect(provider.fetch()).rejects.toThrow("network down");
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "network down" });
  });

  it("emits one docker provider.poll log for one tick", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const log = vi.spyOn(logger, "info");
    registerDocker("docker", { baseUrl: "http://proxy", timing: { pollIntervalMs: 10_000 } });

    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    const dockerPolls = log.mock.calls.filter(([event]) => {
      const fields = event as Record<string, unknown>;
      return fields.event === "provider.poll" && fields.id === "docker";
    });
    expect(dockerPolls).toHaveLength(1);
  });
});

function makeProvider<T>(id: string, fetch: () => Promise<T>): Provider<T> {
  return { id, kind: "test", health: async () => ({ ok: true }), fetch };
}

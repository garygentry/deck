import type { LinkItem, Service, ServiceItem } from "@deck/schema";
import type { FreshnessState, ProviderEnvelope } from "@deck/server";
import { describe, expect, test } from "vitest";
import {
  deriveCardStatus,
  dockerContainerStatus,
  gatusEndpointStatus,
  isDockerBinding,
  isGatusBinding,
  resolveServiceBinding,
  statusBucket,
  type CardEnvelopes,
  type CardStatus,
  type DockerHealth,
  type DockerResult,
  type DockerRunState,
  type GatusResult,
} from "../src/features/portal/card-status.js";

const serviceItem: ServiceItem = { type: "service", host: "host", name: "service" };
const linkItem: LinkItem = { type: "link", title: "Docs", href: "https://example.test" };

function service(bindings?: Service["bindings"]): Service {
  return {
    name: "service",
    host: "host",
    kind: "container",
    purpose: "test service",
    bindings,
  };
}

function envelope<T>(data: T | null, options: {
  error?: { message: string } | null;
  state?: FreshnessState;
} = {}): ProviderEnvelope<T> {
  return {
    id: "provider",
    kind: "provider",
    freshness: {
      state: options.state ?? "fresh",
      observedAt: "2026-09-03T00:00:00.000Z",
      ageMs: 0,
      ttlMs: 30_000,
    },
    data,
    error: options.error ?? null,
  };
}

function docker(data: DockerResult | null, options?: Parameters<typeof envelope<never>>[1]) {
  return envelope(data, options);
}

function gatus(data: GatusResult | null, options?: Parameters<typeof envelope<never>>[1]) {
  return envelope(data, options);
}

const emptyEnvelopes: CardEnvelopes = { docker: null, gatus: null };

describe("binding guards and selection", () => {
  test.each([
    [{ container: "app" }, true],
    [{ container: 1 }, false],
    [null, false],
    ["app", false],
  ])("isDockerBinding(%j) is %s", (value, expected) => {
    expect(isDockerBinding(value)).toBe(expected);
  });

  test.each([
    [{ endpoint: "health" }, true],
    [{ endpoint: false }, false],
    [undefined, false],
    ["health", false],
  ])("isGatusBinding(%j) is %s", (value, expected) => {
    expect(isGatusBinding(value)).toBe(expected);
  });

  test("docker wins when both usable bindings are present", () => {
    expect(resolveServiceBinding(service({
      docker: { container: "app" },
      gatus: { endpoint: "health" },
    }))).toEqual({ kind: "docker", binding: { container: "app" } });
  });
});

describe("status buckets", () => {
  test.each<[CardStatus, string | null]>([
    ["bound-up", "up"],
    ["bound-down", "down"],
    ["unreachable", "unreachable"],
    ["static", null],
    ["not-found", null],
    ["broken-reference", null],
  ])("maps %s", (status, bucket) => expect(statusBucket(status)).toBe(bucket));
});

describe("deriveCardStatus precedence", () => {
  test("a link is static even when no service or provider exists", () => {
    expect(deriveCardStatus(linkItem, undefined, emptyEnvelopes)).toBe("static");
  });

  test("an unresolved service is a broken reference", () => {
    expect(deriveCardStatus(serviceItem, undefined, emptyEnvelopes)).toBe("broken-reference");
  });

  test.each([
    undefined,
    {},
    { docker: { container: 7 } },
    { gatus: { endpoint: null } },
  ])("a resolved service with bindings %j is static", (bindings) => {
    expect(deriveCardStatus(serviceItem, service(bindings), emptyEnvelopes)).toBe("static");
  });

  test.each([
    ["null envelope", null],
    ["provider error", docker({ containers: [] }, { error: { message: "offline" } })],
    ["unreachable freshness", docker({ containers: [] }, { state: "unreachable" })],
    ["null data", docker(null)],
  ])("a bound service is unreachable for %s", (_label, dockerEnvelope) => {
    expect(deriveCardStatus(serviceItem, service({ docker: { container: "app" } }), {
      docker: dockerEnvelope,
      gatus: null,
    })).toBe("unreachable");
  });

  test("reachable data with a missing explicit key is not-found, not unreachable", () => {
    expect(deriveCardStatus(serviceItem, service({ docker: { container: "missing" } }), {
      docker: docker({ containers: [] }),
      gatus: null,
    })).toBe("not-found");
  });

  test("matches a container by binding.container rather than the service name", () => {
    expect(deriveCardStatus(serviceItem, service({ docker: { container: "actual-container" } }), {
      docker: docker({ containers: [{
        name: "actual-container", state: "running", health: "healthy", status: "Up",
      }] }),
      gatus: null,
    })).toBe("bound-up");
  });

  test("matches a gatus endpoint by binding.endpoint", () => {
    expect(deriveCardStatus(serviceItem, service({ gatus: { endpoint: "explicit-key" } }), {
      docker: null,
      gatus: gatus({ endpoints: [{ key: "explicit-key", up: false, latencyMs: 25 }] }),
    })).toBe("bound-down");
  });

  test("both bindings consult docker only", () => {
    expect(deriveCardStatus(serviceItem, service({
      docker: { container: "missing" },
      gatus: { endpoint: "up" },
    }), {
      docker: docker({ containers: [] }),
      gatus: gatus({ endpoints: [{ key: "up", up: true, latencyMs: 1 }] }),
    })).toBe("not-found");
  });
});

describe("domain mappings", () => {
  const states: readonly DockerRunState[] = ["running", "exited", "paused", "restarting"];
  const healths: readonly DockerHealth[] = ["healthy", "unhealthy", "starting", "none"];

  for (const state of states) {
    for (const health of healths) {
      test(`docker ${state} + ${health}`, () => {
        const expected = state === "running" && (health === "healthy" || health === "none")
          ? "bound-up"
          : "bound-down";
        expect(dockerContainerStatus({ name: "app", state, health, status: "" })).toBe(expected);
      });
    }
  }

  test.each([[true, "bound-up"], [false, "bound-down"]] as const)(
    "gatus up=%s maps to %s",
    (up, expected) => {
      expect(gatusEndpointStatus({ key: "endpoint", up, latencyMs: null })).toBe(expected);
    },
  );
});

// G1 — Purity guard. The portal's pure logic modules must stay free of the
// React runtime and of network access, so status derivation, filtering, and
// keyboard handling remain plain data transforms callable without a component
// tree or a live fetch. Pinned to exactly this file set. Import specifiers are
// static string literals because Vite's ?raw loader cannot resolve a templated
// dynamic import.
describe("purity guard (G1)", () => {
  const pureSources: ReadonlyArray<readonly [string, Promise<{ default: string }>]> = [
    ["card-status.ts", import("../src/features/portal/card-status.js?raw")],
    ["search-filter.ts", import("../src/features/portal/search-filter.js?raw")],
  ];

  test.each(pureSources)("%s imports no React and calls no fetch", async (_name, loaded) => {
    const source = (await loaded).default;
    expect(source).not.toMatch(/from ["']react(-dom)?(\/[\w-]+)?["']/);
    // The @/ui barrel carries React components: types only.
    expect(source).not.toMatch(/^import (?!type )[^;]*from ["']@\/ui["']/m);
    expect(source).not.toContain("fetch(");
  });
});

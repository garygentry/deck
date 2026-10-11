import type { Service } from "@deck/schema";
import type { LinkItem, ServiceItem } from "../../server/types.js";
import type { FreshnessState, ProviderEnvelope } from "@deck/contract";
import { BUILTIN_STATUS_KINDS } from "@deck/contract/modules/data-sources";
import type { UiStatusKind } from "@deck/module-sdk";
import { describe, expect, test } from "vitest";
import {
  boundItem,
  deriveCardStatus,
  isUp,
  readPath,
  resolveServiceBinding,
  statusBucket,
  type CardStatus,
  type CardStatusContext,
  type GatusResult,
} from "../../web/card-status.js";

const serviceItem: ServiceItem = { type: "service", host: "host", name: "service" };
const linkItem: LinkItem = { type: "link", title: "Docs", href: "https://example.test" };
const KINDS = BUILTIN_STATUS_KINDS;
const kindOf = (kind: string): UiStatusKind => KINDS.find((entry) => entry.kind === kind)!;

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

interface DockerContainer {
  name: string;
  state: "running" | "exited" | "paused" | "restarting";
  health: "healthy" | "unhealthy" | "starting" | "none";
  status: string;
}

function docker(data: { containers: DockerContainer[] } | null, options?: Parameters<typeof envelope<never>>[1]) {
  return envelope(data, options);
}

function gatus(data: GatusResult | null, options?: Parameters<typeof envelope<never>>[1]) {
  return envelope(data, options);
}

const envelopes = (entries: Record<string, ProviderEnvelope | null>): ReadonlyMap<string, ProviderEnvelope | null> =>
  new Map(Object.entries(entries));
const none = envelopes({});

/** A card's status from these kinds and envelopes, with nothing pending and every provider registered. */
function cardStatus(
  item: Parameters<typeof deriveCardStatus>[0],
  service: Service | undefined,
  kinds: readonly UiStatusKind[],
  envelopeMap: ReadonlyMap<string, ProviderEnvelope | null>,
  extra: Partial<CardStatusContext> = {},
) {
  return deriveCardStatus(item, service, { statusKinds: kinds, envelopes: envelopeMap, registered: null, pending: new Set(), ...extra });
}

describe("binding selection", () => {
  test.each([
    [{ container: "app" }, "docker"],
    [{ container: 1 }, "docker"],
    [{ container: true }, null],
    [{}, null],
  ])("a docker binding %j is usable: %s", (value, expected) => {
    expect(resolveServiceBinding(service({ docker: value }), KINDS)?.kind.kind ?? null).toBe(expected);
  });

  test.each([
    [{ endpoint: "health" }, "gatus"],
    [{ endpoint: false }, null],
    [{ url: "https://x.test" }, null],
  ])("a gatus binding %j is usable: %s", (value, expected) => {
    expect(resolveServiceBinding(service({ gatus: value }), KINDS)?.kind.kind ?? null).toBe(expected);
  });

  test("the first usable binding by kind name wins (docker before gatus before http-health)", () => {
    const both = service({ "http-health": { url: "https://x.test" }, gatus: { endpoint: "health" }, docker: { container: "app" } });
    expect(resolveServiceBinding(both, KINDS)).toMatchObject({ kind: { kind: "docker" }, providerId: "docker", value: { container: "app" } });
    // An unusable docker binding falls through to the next kind.
    expect(resolveServiceBinding(service({ docker: { container: null }, gatus: { endpoint: "health" } }), KINDS)?.providerId).toBe("gatus");
  });

  test("a binding provider reads the binding's own provider: its id, else <kind>:service:<host>:<name>", () => {
    expect(resolveServiceBinding(service({ "http-health": { url: "https://x.test" } }), KINDS)?.providerId).toBe("http-health:service:host:service");
    expect(resolveServiceBinding(service({ "http-health": { id: "probe", url: "https://x.test" } }), KINDS)?.providerId).toBe("probe");
  });

  test("a kind the manifest does not list gives no status, and a fixed kind without its fixedId is skipped", () => {
    expect(resolveServiceBinding(service({ docker: { container: "app" } }), [kindOf("gatus")])).toBeNull();
    const { fixedId: _dropped, ...noFixed } = kindOf("docker");
    expect(resolveServiceBinding(service({ docker: { container: "app" } }), [noFixed])).toBeNull();
  });
});

describe("binding precedence (built-ins first) and registration", () => {
  const early: UiStatusKind = { kind: "aaa", module: "aaa", status: { provider: "binding", up: [{ field: "up", in: [true] }] } };

  test("built-in kinds come first in their fixed order, then others by name, whatever the names", () => {
    const bound = service({ aaa: {}, "http-health": { url: "https://x.test" }, docker: { container: "app" } });
    expect(resolveServiceBinding(bound, [early, ...KINDS])?.kind.kind).toBe("docker");
    expect(resolveServiceBinding(service({ aaa: {}, "http-health": { url: "https://x.test" } }), [early, ...KINDS])?.kind.kind).toBe("http-health");
    expect(resolveServiceBinding(service({ aaa: {}, zzz: {} }), [{ ...early, kind: "zzz", module: "zzz" }, early])?.kind.kind).toBe("aaa");
  });

  test("a binding whose provider is not registered gives way to the next one", () => {
    const bound = service({ docker: { container: "app" }, "http-health": { url: "https://x.test" } });
    const registered = new Set(["http-health:service:host:service"]);
    expect(resolveServiceBinding(bound, KINDS, registered)?.providerId).toBe("http-health:service:host:service");
    expect(cardStatus(serviceItem, bound, KINDS, envelopes({ "http-health:service:host:service": envelope({ up: true }) }), { registered })).toBe("bound-up");
    // Unknown registration (no manifest): the first by precedence, as before.
    expect(resolveServiceBinding(bound, KINDS, null)?.providerId).toBe("docker");
  });

  test("a binding whose provider has not answered yet is pending, not unreachable", () => {
    expect(cardStatus(serviceItem, service({ docker: { container: "app" } }), KINDS, none, { pending: new Set(["docker"]) })).toBe("pending");
    expect(statusBucket("pending")).toBeNull();
  });
});

describe("status declarations", () => {
  test("readPath reads own keys of plain objects only", () => {
    expect(readPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(readPath({ a: [1] }, "a.0")).toBeUndefined();
    expect(readPath({}, "constructor")).toBeUndefined();
    expect(readPath(Object.create({ inherited: true }), "inherited")).toBeUndefined();
  });

  test("boundItem matches the binding's key in the list, or reads the data itself", () => {
    const binding = resolveServiceBinding(service({ gatus: { endpoint: "b" } }), KINDS)!;
    expect(boundItem({ endpoints: [{ key: "a" }, { key: "b", up: true }] }, binding)).toEqual({ key: "b", up: true });
    expect(boundItem({ endpoints: "not a list" }, binding)).toBeUndefined();
    const own = resolveServiceBinding(service({ "http-health": { url: "https://x.test" } }), KINDS)!;
    expect(boundItem({ up: true }, own)).toEqual({ up: true });
  });

  test("isUp needs every condition; values compare exactly", () => {
    const up = kindOf("docker").status.up;
    expect(isUp({ state: "running", health: "none" }, up)).toBe(true);
    expect(isUp({ state: "running", health: "unhealthy" }, up)).toBe(false);
    expect(isUp({ up: "true" }, kindOf("gatus").status.up)).toBe(false);
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
    expect(cardStatus(linkItem, undefined, KINDS, none)).toBe("static");
  });

  test("an unresolved service is a broken reference", () => {
    expect(cardStatus(serviceItem, undefined, KINDS, none)).toBe("broken-reference");
  });

  test.each([
    undefined,
    {},
    { docker: { container: true } },
    { gatus: { endpoint: null } },
  ])("a resolved service with bindings %j is static", (bindings) => {
    expect(cardStatus(serviceItem, service(bindings), KINDS, none)).toBe("static");
  });

  test.each([
    ["null envelope", null],
    ["provider error", docker({ containers: [] }, { error: { message: "offline" } })],
    ["unreachable freshness", docker({ containers: [] }, { state: "unreachable" })],
    ["null data", docker(null)],
  ])("a bound service is unreachable for %s", (_label, dockerEnvelope) => {
    expect(cardStatus(serviceItem, service({ docker: { container: "app" } }), KINDS, envelopes({ docker: dockerEnvelope })))
      .toBe("unreachable");
  });

  test("a binding whose provider is not polled (absent from the envelopes) is unreachable", () => {
    expect(cardStatus(serviceItem, service({ docker: { container: "app" } }), KINDS, none)).toBe("unreachable");
  });

  test("reachable data with a missing explicit key is not-found, not unreachable", () => {
    expect(cardStatus(serviceItem, service({ docker: { container: "missing" } }), KINDS, envelopes({
      docker: docker({ containers: [] }),
    }))).toBe("not-found");
  });

  test("matches a container by binding.container rather than the service name", () => {
    expect(cardStatus(serviceItem, service({ docker: { container: "actual-container" } }), KINDS, envelopes({
      docker: docker({ containers: [{
        name: "actual-container", state: "running", health: "healthy", status: "Up",
      }] }),
    }))).toBe("bound-up");
  });

  test("matches a gatus endpoint by binding.endpoint", () => {
    expect(cardStatus(serviceItem, service({ gatus: { endpoint: "explicit-key" } }), KINDS, envelopes({
      gatus: gatus({ endpoints: [{ key: "explicit-key", up: false, latencyMs: 25 }] }),
    }))).toBe("bound-down");
  });

  test("both bindings consult docker only", () => {
    expect(cardStatus(serviceItem, service({
      docker: { container: "missing" },
      gatus: { endpoint: "up" },
    }), KINDS, envelopes({
      docker: docker({ containers: [] }),
      gatus: gatus({ endpoints: [{ key: "up", up: true, latencyMs: 1 }] }),
    }))).toBe("not-found");
  });

  test.each([
    [{ up: true, status: 200, latencyMs: 3 }, "bound-up"],
    [{ up: false, status: 503, latencyMs: 3 }, "bound-down"],
  ] as const)("an http-health binding (any statusCapable kind, W6) reads its own provider: %j is %s", (data, expected) => {
    const bound = service({ "http-health": { url: "https://x.test/health" } });
    expect(cardStatus(serviceItem, bound, KINDS, envelopes({ "http-health:service:host:service": envelope(data) }))).toBe(expected);
  });

  test("a kind declared only in the manifest drives card status with no web code", () => {
    const ups: UiStatusKind = {
      kind: "ups",
      module: "ups",
      fixedId: "ups",
      status: { provider: "fixed", match: { list: "outlets", key: "id", binding: "outlet" }, up: [{ field: "power.on", in: [true, "on"] }] },
    };
    const bound = service({ ups: { outlet: 3 } });
    const data = { outlets: [{ id: 3, power: { on: "on" } }, { id: 4, power: { on: false } }] };
    expect(cardStatus(serviceItem, bound, [ups], envelopes({ ups: envelope(data) }))).toBe("bound-up");
    expect(cardStatus(serviceItem, service({ ups: { outlet: 4 } }), [ups], envelopes({ ups: envelope(data) }))).toBe("bound-down");
    expect(cardStatus(serviceItem, service({ ups: { outlet: 5 } }), [ups], envelopes({ ups: envelope(data) }))).toBe("not-found");
  });
});

describe("domain mappings", () => {
  const states: ReadonlyArray<DockerContainer["state"]> = ["running", "exited", "paused", "restarting"];
  const healths: ReadonlyArray<DockerContainer["health"]> = ["healthy", "unhealthy", "starting", "none"];
  const containerStatus = (container: DockerContainer) =>
    cardStatus(serviceItem, service({ docker: { container: container.name } }), KINDS, envelopes({ docker: docker({ containers: [container] }) }));

  for (const state of states) {
    for (const health of healths) {
      test(`docker ${state} + ${health}`, () => {
        const expected = state === "running" && (health === "healthy" || health === "none")
          ? "bound-up"
          : "bound-down";
        expect(containerStatus({ name: "app", state, health, status: "" })).toBe(expected);
      });
    }
  }

  test.each([[true, "bound-up"], [false, "bound-down"]] as const)(
    "gatus up=%s maps to %s",
    (up, expected) => {
      const bound = service({ gatus: { endpoint: "endpoint" } });
      expect(cardStatus(serviceItem, bound, KINDS, envelopes({ gatus: gatus({ endpoints: [{ key: "endpoint", up, latencyMs: null }] }) }))).toBe(expected);
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
    ["card-status.ts", import("../../web/card-status.js?raw")],
    ["search-filter.ts", import("../../web/search-filter.js?raw")],
  ];

  test.each(pureSources)("%s imports no React and calls no fetch", async (_name, loaded) => {
    const source = (await loaded).default;
    expect(source).not.toMatch(/from ["']react(-dom)?(\/[\w-]+)?["']/);
    // The @/ui barrel carries React components: types only.
    expect(source).not.toMatch(/^import (?!type )[^;]*from ["']@\/ui["']/m);
    expect(source).not.toContain("fetch(");
  });
});

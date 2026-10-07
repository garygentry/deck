import { composeDefault } from "../src/index.js";
import { primary } from "../src/fixtures/index.js";
import { expect, test } from "vitest";

const config = primary.merged as any;
const snapshot = primary.snapshots.combined as any;

test("primary config covers the enumerated schema concepts", () => {
  expect(new Set(config.hosts.map((host: any) => host.kind))).toEqual(new Set(["bare-metal", "vm", "lxc", "appliance", "endpoint", "unknown"]));
  expect(new Set(config.services.map((service: any) => service.kind))).toEqual(new Set(["docker-compose", "systemd", "appliance", "container", "external"]));

  const providerKinds = new Set<string>();
  for (const entity of [...config.hosts, ...config.services]) for (const kind of Object.keys(entity.bindings ?? {})) providerKinds.add(kind);
  for (const integration of config.integrations ?? []) providerKinds.add(integration.kind);
  for (const kind of composeDefault().knownKinds) expect(providerKinds.has(kind), `provider kind ${kind}`).toBe(true);

  const guests = config.hosts.filter((host: any) => host.hypervisor && host.vmid === 100);
  expect(new Set(guests.map((host: any) => host.hypervisor)).size).toBeGreaterThanOrEqual(2);
  const servicePairs = new Map<string, Set<string>>();
  for (const service of config.services) (servicePairs.get(service.name) ?? servicePairs.set(service.name, new Set()).get(service.name))!.add(service.host);
  expect([...servicePairs.values()].some((hosts) => hosts.size >= 2)).toBe(true);

  const topItems = (config.modules.portal.groups ?? []).flatMap((group: any) => group.items);
  expect(new Set(topItems.map((item: any) => item.type))).toEqual(new Set(["service", "link", "group"]));
  expect(topItems.some((item: any) => item.type === "group" && item.items.some((child: any) => child.type === "service") && item.items.some((child: any) => child.type === "link"))).toBe(true);
  expect(config.sources.length).toBeGreaterThan(0);
  expect(config.integrations.length).toBeGreaterThan(0);
  expect(config.modules.actions.actions.length).toBeGreaterThan(0);
  expect(config.agents).toBeUndefined();
  expect(config.hosts.some((host: any) => host.secrets?.length)).toBe(true);
  expect(config.services.some((service: any) => service.secrets?.length)).toBe(true);
  expect(config.hosts.some((host: any) => host.managedConfigs?.length)).toBe(true);
  expect([...config.hosts, ...config.services].some((entity: any) => entity.backup)).toBe(true);
  expect(config.hosts.some((host: any) => new Set((host.addresses ?? []).map((address: any) => address.network)).size >= 2 && host.addresses.some((address: any) => !["lan", "tailnet"].includes(address.network)))).toBe(true);
  expect(config.hosts.some((host: any) => host.hidden === true)).toBe(true);
  expect(config.services.some((service: any) => service.hidden === true)).toBe(true);
});

test("combined snapshot covers collection and drift concepts", () => {
  expect(new Set(snapshot.hosts.map((host: any) => host.coverage))).toEqual(new Set(["collected", "partial", "unreachable"]));
  const collected = snapshot.hosts.filter((host: any) => host.coverage === "collected");
  expect(collected.some((host: any) => Date.parse(host.collectedAt) >= Date.parse("2025-01-01"))).toBe(true);
  expect(collected.some((host: any) => Date.parse(host.collectedAt) < Date.parse("2021-01-01"))).toBe(true);
  expect(snapshot.hosts.some((host: any) => host.coverage === "partial" && host.collectors.succeeded.length && host.collectors.failed.length)).toBe(true);
  expect(snapshot.hosts.some((host: any) => host.coverage === "unreachable" && !("collectedAt" in host))).toBe(true);
  expect(new Set(snapshot.drift.map((finding: any) => finding.severity))).toEqual(new Set(["error", "warning", "info"]));
  expect(snapshot.drift.some((finding: any) => finding.waiver?.reason && finding.waiver?.who)).toBe(true);
  expect(snapshot.hosts.some((host: any) => host.containers?.length)).toBe(true);
  expect(snapshot.hosts.some((host: any) => host.guests?.length)).toBe(true);
  expect(snapshot.hosts.some((host: any) => host.managedConfigs?.length)).toBe(true);
  const observed = new Set(snapshot.hosts.map((host: any) => host.name));
  expect(config.hosts.some((host: any) => !observed.has(host.name))).toBe(true);
});

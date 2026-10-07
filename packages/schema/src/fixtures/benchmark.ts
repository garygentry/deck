import type { DeckConfigDocument, JsonObject, SnapshotDocument } from "../types.js";

export interface BenchmarkOptions { hosts?: number; servicesPerHost?: number; factsPerEntity?: number }

const HOST_KINDS = ["bare-metal", "vm", "lxc", "appliance", "endpoint", "unknown"] as const;
const SERVICE_KINDS = ["docker-compose", "systemd", "appliance", "container", "external"] as const;

export function benchmarkEstate(options: BenchmarkOptions = {}): { config: DeckConfigDocument; snapshot: SnapshotDocument } {
  const hostCount = options.hosts ?? 40;
  const servicesPerHost = options.servicesPerHost ?? 2;
  const factsPerEntity = options.factsPerEntity ?? 20;
  const hosts: DeckConfigDocument["hosts"] = [];
  const services: DeckConfigDocument["services"] = [];
  const observedHosts: NonNullable<SnapshotDocument["hosts"]> = [];
  const observedServices: NonNullable<SnapshotDocument["services"]> = [];

  for (let index = 0; index < hostCount; index += 1) {
    const name = `benchmark-host-${index}`;
    hosts.push({ name, kind: HOST_KINDS[index % HOST_KINDS.length], purpose: `Generated benchmark host ${index}` });
    observedHosts.push({
      name, coverage: "collected", collectedAt: "2026-01-01T00:00:00Z",
      containers: [{ name: `${name}-container`, image: "registry.invalid/fixture:stable", state: "running" }],
      guests: [{ vmid: 1000 + index, name: `${name}-guest`, state: "running" }],
      facts: makeFacts(name, factsPerEntity),
    });
    for (let serviceIndex = 0; serviceIndex < servicesPerHost; serviceIndex += 1) {
      const serviceName = `${name}-service-${serviceIndex}`;
      services.push({ name: serviceName, host: name, kind: SERVICE_KINDS[serviceIndex % SERVICE_KINDS.length], purpose: `Generated benchmark service ${serviceIndex}` });
      observedServices.push({ host: name, name: serviceName, state: "running", facts: makeFacts(serviceName, factsPerEntity) });
    }
  }
  return {
    config: { schemaVersion: 1, estate: { name: "benchmark-estate" }, hosts, services },
    snapshot: { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", hosts: observedHosts, services: observedServices },
  };
}

function makeFacts(seed: string, count: number): JsonObject {
  const facts: JsonObject = {
    description: `observed entity ${seed} generated for the reference scale benchmark input`,
    notes: `this deliberately long fixture fact exercises complete recursive string inspection for ${seed}`,
  };
  for (let index = 0; index < Math.max(0, count - 2); index += 1) {
    facts[`metric_${index}`] = index % 3 === 0 ? index * 7 : `value-${index}-for-${seed}`;
  }
  return facts;
}

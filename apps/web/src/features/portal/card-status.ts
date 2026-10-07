import type { Service } from "@deck/schema";
import type { GroupItem, LinkItem, ServiceItem } from "@deck/server/portal";
import type { FreshnessStamp, ProviderEnvelope } from "@deck/contract";
import type { DeckConfig } from "@deck/server";

export type DockerRunState = "running" | "exited" | "paused" | "restarting";
export type DockerHealth = "healthy" | "unhealthy" | "starting" | "none";

export interface DockerContainer {
  name: string;
  state: DockerRunState;
  health: DockerHealth;
  status: string;
}

export interface DockerResult {
  containers: DockerContainer[];
}

export interface GatusEndpoint {
  key: string;
  name?: string;
  group?: string;
  up: boolean;
  latencyMs: number | null;
}

export interface GatusResult {
  endpoints: GatusEndpoint[];
}

export type CardStatus =
  | "static"
  | "broken-reference"
  | "unreachable"
  | "not-found"
  | "bound-up"
  | "bound-down";

export type LiveStatusBucket = "up" | "down" | "unreachable";

export function statusBucket(status: CardStatus): LiveStatusBucket | null {
  switch (status) {
    case "bound-up":
      return "up";
    case "bound-down":
      return "down";
    case "unreachable":
      return "unreachable";
    default:
      return null;
  }
}

export interface DockerBinding {
  container: string;
}

export interface GatusBinding {
  endpoint: string;
}

export function isDockerBinding(value: unknown): value is DockerBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).container === "string"
  );
}

export function isGatusBinding(value: unknown): value is GatusBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).endpoint === "string"
  );
}

export interface CardViewModel {
  item: GroupItem;
  resolvedService?: Service;
  status: CardStatus;
  target?: string;
  freshness: FreshnessStamp;
}

export interface PortalData {
  config: DeckConfig | null;
  docker: ProviderEnvelope<DockerResult> | null;
  gatus: ProviderEnvelope<GatusResult> | null;
  loading: boolean;
}

export type CardItem = ServiceItem | LinkItem;

export interface CardEnvelopes {
  docker: ProviderEnvelope<DockerResult> | null;
  gatus: ProviderEnvelope<GatusResult> | null;
}

export type ResolvedBinding =
  | { kind: "docker"; binding: DockerBinding }
  | { kind: "gatus"; binding: GatusBinding };

export function resolveServiceBinding(service: Service): ResolvedBinding | null {
  const bindings = service.bindings;
  if (isDockerBinding(bindings?.docker)) {
    return { kind: "docker", binding: bindings.docker };
  }
  if (isGatusBinding(bindings?.gatus)) {
    return { kind: "gatus", binding: bindings.gatus };
  }
  return null;
}

export function dockerContainerStatus(container: DockerContainer): CardStatus {
  return container.state === "running" &&
    (container.health === "healthy" || container.health === "none")
    ? "bound-up"
    : "bound-down";
}

export function gatusEndpointStatus(endpoint: GatusEndpoint): CardStatus {
  return endpoint.up ? "bound-up" : "bound-down";
}

export function deriveCardStatus(
  item: CardItem,
  resolvedService: Service | undefined,
  envelopes: CardEnvelopes,
): CardStatus {
  if (item.type === "link") {
    return "static";
  }
  if (resolvedService === undefined) {
    return "broken-reference";
  }

  const resolvedBinding = resolveServiceBinding(resolvedService);
  if (resolvedBinding === null) {
    return "static";
  }

  if (resolvedBinding.kind === "docker") {
    const envelope = envelopes.docker;
    if (
      envelope === null ||
      envelope.error !== null ||
      envelope.freshness.state === "unreachable" ||
      envelope.data === null
    ) {
      return "unreachable";
    }
    const container = envelope.data.containers.find(
      ({ name }) => name === resolvedBinding.binding.container,
    );
    return container === undefined ? "not-found" : dockerContainerStatus(container);
  }

  const envelope = envelopes.gatus;
  if (
    envelope === null ||
    envelope.error !== null ||
    envelope.freshness.state === "unreachable" ||
    envelope.data === null
  ) {
    return "unreachable";
  }
  const endpoint = envelope.data.endpoints.find(
    ({ key }) => key === resolvedBinding.binding.endpoint,
  );
  return endpoint === undefined ? "not-found" : gatusEndpointStatus(endpoint);
}

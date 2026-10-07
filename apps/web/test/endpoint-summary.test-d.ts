import type { ComponentType } from "react";
import { expectTypeOf } from "vitest";
import type { HealthSummary } from "../src/shell/health-header/health-summary.js";
import { EndpointStatusSummary } from "../src/features/portal/EndpointStatusSummary.js";
import type {
  DockerContainer,
  DockerHealth,
  DockerResult,
  DockerRunState,
  GatusEndpoint,
  GatusResult,
} from "../src/features/portal/card-status.js";

type ServerDockerRunState = "running" | "exited" | "paused" | "restarting";
type ServerDockerHealth = "healthy" | "unhealthy" | "starting" | "none";

interface ServerDockerContainer {
  name: string;
  state: ServerDockerRunState;
  health: ServerDockerHealth;
  status: string;
}

interface ServerDockerResult {
  containers: ServerDockerContainer[];
}

interface ServerGatusEndpoint {
  key: string;
  name?: string;
  group?: string;
  up: boolean;
  latencyMs: number | null;
}

interface ServerGatusResult {
  endpoints: ServerGatusEndpoint[];
}

expectTypeOf<DockerRunState>().toMatchTypeOf<ServerDockerRunState>();
expectTypeOf<ServerDockerRunState>().toMatchTypeOf<DockerRunState>();
expectTypeOf<DockerHealth>().toMatchTypeOf<ServerDockerHealth>();
expectTypeOf<ServerDockerHealth>().toMatchTypeOf<DockerHealth>();
expectTypeOf<DockerContainer>().toMatchTypeOf<ServerDockerContainer>();
expectTypeOf<ServerDockerContainer>().toMatchTypeOf<DockerContainer>();
expectTypeOf<DockerResult>().toMatchTypeOf<ServerDockerResult>();
expectTypeOf<ServerDockerResult>().toMatchTypeOf<DockerResult>();
expectTypeOf<GatusEndpoint>().toMatchTypeOf<ServerGatusEndpoint>();
expectTypeOf<ServerGatusEndpoint>().toMatchTypeOf<GatusEndpoint>();
expectTypeOf<GatusResult>().toMatchTypeOf<ServerGatusResult>();
expectTypeOf<ServerGatusResult>().toMatchTypeOf<GatusResult>();

// EndpointStatusSummary is now a self-sufficient, propless fragment (05 §8.2): it
// sources its own data and emits HealthSummary rather than receiving it. A propless
// component still satisfies the ComponentType<HealthSummary> slot signature (the
// shell renders it with no props), so this assertion is now vacuously true.
expectTypeOf(EndpointStatusSummary).toMatchTypeOf<ComponentType>();
expectTypeOf(EndpointStatusSummary).toMatchTypeOf<ComponentType<HealthSummary>>();

import type { ComponentType } from "react";
import { expectTypeOf } from "vitest";
import type { HealthSummary } from "@/shell/health-header/health-summary.js";
import { EndpointStatusSummary } from "../../web/EndpointStatusSummary.js";
import type { GatusEndpoint, GatusResult } from "../../web/card-status.js";

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

expectTypeOf<GatusEndpoint>().toMatchTypeOf<ServerGatusEndpoint>();
expectTypeOf<ServerGatusEndpoint>().toMatchTypeOf<GatusEndpoint>();
expectTypeOf<GatusResult>().toMatchTypeOf<ServerGatusResult>();
expectTypeOf<ServerGatusResult>().toMatchTypeOf<GatusResult>();

// EndpointStatusSummary is now a self-sufficient, propless fragment: it
// sources its own data and emits HealthSummary rather than receiving it. A propless
// component still satisfies the ComponentType<HealthSummary> slot signature (the
// shell renders it with no props), so this assertion is now vacuously true.
expectTypeOf(EndpointStatusSummary).toMatchTypeOf<ComponentType>();
expectTypeOf(EndpointStatusSummary).toMatchTypeOf<ComponentType<HealthSummary>>();

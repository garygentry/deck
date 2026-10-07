import { POLL_DEFAULTS } from "@deck/contract";
import { createContext, useContext, useMemo } from "react";
import { useConfig, useProvider } from "../../data/index.js";
import type { DockerResult, GatusResult, PortalData } from "./card-status.js";

const INITIAL_PORTAL_DATA: PortalData = {
  config: null,
  docker: null,
  gatus: null,
  loading: true,
};

export const PortalDataContext = createContext<PortalData>(INITIAL_PORTAL_DATA);

/**
 * The config plus the docker and gatus envelopes the portal derives card status from. Each
 * is shared: the portal page and the endpoint-status pill read the same requests, and the
 * config is read once per page load. A provider the estate never registered is not polled;
 * its `null` renders the same "not configured" card.
 */
export function usePortalData(
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): PortalData {
  const config = useConfig();
  const docker = useProvider<DockerResult>("docker", { intervalMs });
  const gatus = useProvider<GatusResult>("gatus", { intervalMs });
  const loading = config.status === "loading" || docker.loading || gatus.loading;
  const loadedConfig = config.status === "ready" ? config.config : null;
  // One object per change, so context readers re-render only when the data does.
  return useMemo(
    () =>
      loading
        ? INITIAL_PORTAL_DATA
        : { config: loadedConfig, docker: docker.envelope, gatus: gatus.envelope, loading: false },
    [loading, loadedConfig, docker.envelope, gatus.envelope],
  );
}

export function usePortalDataContext(): PortalData {
  return useContext(PortalDataContext);
}

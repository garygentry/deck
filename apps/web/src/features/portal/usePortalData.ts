import { POLL_DEFAULTS } from "@deck/server";
import type { DeckConfig, ProviderEnvelope } from "@deck/server";
import { createContext } from "react";
import { useContext, useEffect, useState } from "react";
import { isProviderPollable } from "../../shell/providers-index.js";
import type { DockerResult, GatusResult, PortalData } from "./card-status.js";

const INITIAL_PORTAL_DATA: PortalData = {
  config: null,
  docker: null,
  gatus: null,
  loading: true,
};

export const PortalDataContext = createContext<PortalData>(INITIAL_PORTAL_DATA);

export function usePortalData(
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): PortalData {
  const [data, setData] = useState<PortalData>(INITIAL_PORTAL_DATA);

  useEffect(() => {
    let live = true;

    async function poll(): Promise<void> {
      // Skip a provider the estate never registered so the browser logs no 404
      // for it; a null result renders the same "not configured" card as before.
      const [pollDocker, pollGatus] = await Promise.all([
        isProviderPollable("docker"),
        isProviderPollable("gatus"),
      ]);
      const [config, docker, gatus] = await Promise.all([
        getJson<DeckConfig>("/api/config"),
        pollDocker
          ? getJson<ProviderEnvelope<DockerResult>>("/api/providers/docker")
          : Promise.resolve(null),
        pollGatus
          ? getJson<ProviderEnvelope<GatusResult>>("/api/providers/gatus")
          : Promise.resolve(null),
      ]);

      if (live) {
        setData({ config, docker, gatus, loading: false });
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return data;
}

export function usePortalDataContext(): PortalData {
  return useContext(PortalDataContext);
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    // Degrade to a not-configured/empty state, but leave a console breadcrumb so a
    // transient failure is diagnosable in the field.
    console.warn(`[deck] request failed: ${url}`, error);
    return null;
  }
}

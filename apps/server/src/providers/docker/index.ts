import type { Provider, ProviderConfig, ProviderHealth } from "../../contract/index.js";
import { register } from "../registry.js";

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

export interface DockerConfig {
  baseUrl: string;
  credentialEnv?: string;
  timing?: ProviderConfig;
}

interface RawDockerContainer {
  Names?: string[];
  State?: string;
  Status?: string;
}

export class DockerProvider implements Provider<DockerResult> {
  readonly kind = "docker";

  /** Cached latest health; updated only by fetch(), never by a health() probe. */
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: DockerConfig,
  ) {}

  /** Return the cached non-I/O health snapshot from the latest fetch. */
  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(): Promise<DockerResult> {
    try {
      const response = await globalThis.fetch(joinUrl(this.cfg.baseUrl, "/containers/json?all=true"), {
        method: "GET",
        headers: authHeaders(this.cfg.credentialEnv),
      });
      // A non-2xx upstream (auth failure, endpoint down) is a real failure — report
      // it as unhealthy rather than an empty-but-healthy result that masks the fault.
      if (!response.ok) {
        this.latestHealth = { ok: false, detail: `HTTP ${response.status}` };
        return { containers: [] };
      }
      const result: DockerResult = {
        containers: ((await response.json()) as RawDockerContainer[]).map(mapContainer),
      };
      this.latestHealth = { ok: true, detail: `${result.containers.length} containers` };
      return result;
    } catch (error) {
      this.latestHealth = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
}

export function registerDocker(id: string, cfg: DockerConfig): void {
  register(new DockerProvider(id, cfg), cfg.timing);
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

function authHeaders(credentialEnv?: string): Record<string, string> {
  if (!credentialEnv) return {};
  const value = process.env[credentialEnv];
  if (!value) return {};
  return { Authorization: value };
}

function parseName(names?: string[]): string {
  const name = names?.[0] ?? "";
  return name.startsWith("/") ? name.slice(1) : name;
}

function parseRunState(state?: string): DockerRunState {
  switch (state) {
    case "running":
    case "exited":
    case "paused":
    case "restarting":
      return state;
    default:
      return "exited";
  }
}

function parseHealth(status?: string): DockerHealth {
  if (status?.includes("(healthy)")) return "healthy";
  if (status?.includes("(unhealthy)")) return "unhealthy";
  if (status?.includes("(health: starting)")) return "starting";
  return "none";
}

function mapContainer(raw: RawDockerContainer): DockerContainer {
  return {
    name: parseName(raw.Names),
    state: parseRunState(raw.State),
    health: parseHealth(raw.Status),
    status: raw.Status ?? "",
  };
}

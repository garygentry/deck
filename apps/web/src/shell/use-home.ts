import type { PageRegistration } from "../registry/registry-types.js";
import { getPages } from "../registry/registry.js";
import { useRegistryVersion } from "../registry/use-registry.js";
import { useUiManifest } from "../data/index.js";
import { bootHome } from "./boot.js";
import { resolveRoutes } from "./routes.js";

/** The page `/` renders, as the router resolves it; none when no page can be home. */
export function useHomePage(): PageRegistration | undefined {
  useRegistryVersion();
  return resolveRoutes(useUiManifest(), getPages(), bootHome()).home;
}

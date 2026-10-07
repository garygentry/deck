/* GENERATED from provider index.ts files by src/scripts/gen-providers.ts — do not edit; run `pnpm gen:providers`. */
import { registerAlertmanager } from "./alertmanager/index.js";
import { registerDocker } from "./docker/index.js";
import { registerFileTree } from "./file-tree/index.js";
import { registerGatus } from "./gatus/index.js";
import { registerHttpHealth } from "./http-health/index.js";
import { registerLink } from "./link/index.js";
import { registerMarkdownTree } from "./markdown-tree/index.js";
import { registerPrometheus } from "./prometheus/index.js";
import { registerSnapshot } from "./snapshot/index.js";

/** One discovered provider folder's registration surface. */
export interface GeneratedProviderEntry {
  kind: string;
  order: number;
}

/** Provider kinds discovered at codegen time, sorted by (order, kind). */
export const GENERATED_PROVIDERS: readonly GeneratedProviderEntry[] = [
  { kind: "alertmanager", order: 0 },
  { kind: "docker", order: 0 },
  { kind: "file-tree", order: 0 },
  { kind: "gatus", order: 0 },
  { kind: "http-health", order: 0 },
  { kind: "link", order: 0 },
  { kind: "markdown-tree", order: 0 },
  { kind: "prometheus", order: 0 },
  { kind: "snapshot", order: 0 },
];

/** Typed registration helpers exposed by the discovered provider folders. */
export { registerAlertmanager, registerDocker, registerFileTree, registerGatus, registerHttpHealth, registerLink, registerMarkdownTree, registerPrometheus, registerSnapshot };

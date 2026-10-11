import type { ModuleManifest, WebModuleManifest } from "@deck/module-sdk";

/** Every manifest field the web half never reads. A built-in's shared `*_UI` copy carries none. */
export const SERVER_ONLY_FIELDS = [
  "dependsOn",
  "enabledBy",
  "env",
  "sharedEnv",
  "envFromConfig",
  "config",
  "providerKinds",
  "services",
  "health",
  "dataDir",
] as const satisfies readonly Exclude<keyof ModuleManifest, keyof WebModuleManifest>[];

// A server-only field added to the manifest fails this until it is listed above.
type Unlisted = Exclude<Exclude<keyof ModuleManifest, keyof WebModuleManifest>, (typeof SERVER_ONLY_FIELDS)[number]>;
const complete: [Unlisted] extends [never] ? true : Unlisted = true;
void complete;

/**
 * The server-only fields a shared UI copy carries, `contributes.routes` included: empty for a
 * well-formed copy. It names what is present rather than pinning the copy's whole key set, so
 * a web-safe field added later does not break the assertion.
 */
export function serverOnlyFields(ui: WebModuleManifest): string[] {
  const present: string[] = SERVER_ONLY_FIELDS.filter((field) => Object.hasOwn(ui, field));
  if (ui.contributes !== undefined && Object.hasOwn(ui.contributes, "routes")) present.push("contributes.routes");
  return present;
}

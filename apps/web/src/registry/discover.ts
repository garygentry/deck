import { getDuplicateEntitySectionTitles, getOrphanAttachments } from "./registry.js";

// Each web half registers itself on import: the kernel's own features, and the built-in modules
// co-located as modules/<id>/web.
const modules = import.meta.glob(["../features/*/index.ts", "../../../../modules/*/web/index.ts"], { eager: true });

export const discoveredFeatureCount = Object.keys(modules).length;

/** What each discovered web half exports, by its path, so a test can check the set is the built-ins'. */
export const discoveredWebHalves: Readonly<Record<string, Readonly<Record<string, unknown>>>> = modules as Record<string, Record<string, unknown>>;

// Every built-in has registered: an extension still attached to an undeclared slot never
// renders (a typo in a slot id, a slot whose host was removed). Say so while developing.
if (import.meta.env.DEV) {
  for (const { id, slot } of getOrphanAttachments()) {
    console.warn(`[deck] extension "${id}" attaches to undeclared slot "${slot}"; it never renders`);
  }
  // Two sections on one entity page with the same heading are two identically named landmarks.
  for (const { entity, title, sections } of getDuplicateEntitySectionTitles()) {
    console.warn(`[deck] ${entity} page sections ${sections.map((name) => `"${name}"`).join(", ")} share the title "${title}"; give each its own`);
  }
}

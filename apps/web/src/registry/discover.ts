import { getDuplicateEntitySectionTitles, getOrphanAttachments } from "./registry.js";

const modules = import.meta.glob("../features/*/index.ts", { eager: true });

export const discoveredFeatureCount = Object.keys(modules).length;

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

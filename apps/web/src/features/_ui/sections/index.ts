import type { WorkbenchSectionDef } from "../kit.js";
import { collections } from "./collections.js";
import { content } from "./content.js";
import { filtering } from "./filtering.js";
import { foundations } from "./foundations.js";
import { hooks } from "./hooks.js";
import { primitives } from "./primitives.js";
import { scaffolding } from "./scaffolding.js";
import { status } from "./status.js";

/**
 * Workbench sections in page order. Each catalogue group owns one file, so
 * items that add components to different groups never edit the same file.
 */
export const SECTIONS: readonly WorkbenchSectionDef[] = [
  primitives,
  foundations,
  status,
  scaffolding,
  content,
  collections,
  filtering,
  hooks,
];

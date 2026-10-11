import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { composeFixtures } from "../src/fixtures/modules.js";
import { merge } from "../src/merge.js";
import type { JsonObject, ValidationResult } from "../src/types.js";
import { validateSnapshot } from "../src/validate/validate-snapshot.js";
import { validate } from "../src/validate/validate.js";

export const SNAPSHOT_KEYS = ["combined", "fresh", "stale", "partial", "unreachable"] as const;
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];

export interface FixtureSources {
  base: JsonObject;
  overlay: JsonObject;
  snapshots: Record<SnapshotKey, JsonObject>;
}

export interface GeneratedFixtures extends FixtureSources {
  merged: JsonObject;
  modules: Record<"primary.base.ts" | "primary.overlay.ts" | "primary.merged.ts" | "primary.snapshots.ts", string>;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const primarySourcePaths = {
  base: here("../src/fixtures/primary/00-base.yaml"),
  overlay: here("../src/fixtures/primary/10-overlay.yaml"),
  snapshots: Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, here(`../src/fixtures/primary/snapshot.${key}.json`)])) as Record<SnapshotKey, string>,
};

export function parseFixtureSources(): FixtureSources {
  const yaml = (path: string) => parseYaml(readFileSync(path, "utf8")) as JsonObject;
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  return {
    base: yaml(primarySourcePaths.base),
    overlay: yaml(primarySourcePaths.overlay),
    snapshots: Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, json(primarySourcePaths.snapshots[key])])) as Record<SnapshotKey, JsonObject>,
  };
}

function gate(label: string, result: ValidationResult): void {
  if (result.classification !== 0) {
    throw new Error(`build-fixtures: ${label} did not round-trip (classification ${result.classification}): ${JSON.stringify(result)}`);
  }
}

const banner = (source: string) => `/* GENERATED from primary/${source} by scripts/build-fixtures.ts — do not edit; run pnpm fixtures:build */\n\n`;
// A merged document also holds module sections this package does not type (see fixtures/modules.ts).
const valueModule = (source: string, name: string, value: JsonObject, type: "JsonObject" | "DeckConfigDocument") =>
  `${banner(source)}import type { ${type} } from "../../types.js";\n\nexport const ${name} = ${JSON.stringify(value, null, 2)} satisfies ${type === "DeckConfigDocument" ? "DeckConfigDocument & { modules?: Record<string, unknown> }" : type};\n`;

/** Pure generation/gating path shared by the Bun writer and the Node drift test. */
export function generateFixtures(sources: FixtureSources): GeneratedFixtures {
  const composed = composeFixtures();
  gate("base", validate(sources.base, { layer: "base", composed }));
  gate("overlay", validate(sources.overlay, { layer: "overlay", base: sources.base, composed }));
  const merged = merge(sources.base, sources.overlay);
  gate("merged", validate(merged, { composed }));
  gate("snapshot.combined", validateSnapshot(sources.snapshots.combined, merged));
  for (const key of SNAPSHOT_KEYS.slice(1)) gate(`snapshot.${key}`, validateSnapshot(sources.snapshots[key]));

  const snapshotsBody = SNAPSHOT_KEYS.map((key) => `export const ${key} = ${JSON.stringify(sources.snapshots[key], null, 2)} satisfies SnapshotDocument;`).join("\n\n");
  return {
    ...sources,
    merged,
    modules: {
      "primary.base.ts": valueModule("00-base.yaml", "base", sources.base, "JsonObject"),
      "primary.overlay.ts": valueModule("10-overlay.yaml", "overlay", sources.overlay, "JsonObject"),
      "primary.merged.ts": valueModule("00-base.yaml + 10-overlay.yaml", "merged", merged, "DeckConfigDocument"),
      "primary.snapshots.ts": `${banner("snapshot.*.json")}import type { SnapshotDocument } from "../../types.js";\n\n${snapshotsBody}\n`,
    },
  };
}

export function buildFixtures(): GeneratedFixtures {
  const generated = generateFixtures(parseFixtureSources());
  const outputDirectory = here("../src/fixtures/generated/");
  mkdirSync(outputDirectory, { recursive: true });
  for (const [name, contents] of Object.entries(generated.modules)) writeFileSync(new URL(`../src/fixtures/generated/${name}`, import.meta.url), contents);
  return generated;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) buildFixtures();

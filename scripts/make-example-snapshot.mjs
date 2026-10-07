#!/usr/bin/env node
// Materialize the bundled example snapshot with now-relative timestamps.
//
// deck derives host freshness (fresh vs stale) from the wall clock, so a static
// committed snapshot would age into "stale" over time. This script reads the
// committed template (examples/estate/snapshot.template.json), converts its
// `_*AgoMinutes` / `_untilInDays` hints into RFC 3339 timestamps relative to
// now, strips every `_`-prefixed helper key, and writes a valid SnapshotDocument
// to examples/estate/.runtime/snapshot.json (gitignored).
//
// `pnpm dev` and `pnpm start` run this before booting the server, which reads the
// output via DECK_SNAPSHOT_SOURCE. No network or build step is required.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Paths default to the bundled example estate, but `--template <path>` and
// `--out <path>` override them so a deployment (e.g. the container entrypoint)
// can materialize a snapshot from a mounted estate into a writable runtime dir.
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const estateDir = resolve(here, "../examples/estate");
const templatePath = resolve(argValue("--template") ?? resolve(estateDir, "snapshot.template.json"));
const outPath = resolve(argValue("--out") ?? resolve(estateDir, ".runtime/snapshot.json"));

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const now = Date.now();

const iso = (ms) => new Date(ms).toISOString();

const template = JSON.parse(readFileSync(templatePath, "utf8"));

// Recursively drop every `_`-prefixed helper key so the output validates against
// the snapshot schema (additionalProperties are allowed on hosts, but the helper
// hints are ours, not part of the contract).
function stripHelpers(value) {
  if (Array.isArray(value)) return value.map(stripHelpers);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith("_")) continue;
      out[key] = stripHelpers(v);
    }
    return out;
  }
  return value;
}

const genAgo = template._generatedAtAgoMinutes ?? 0;
template.generatedAt = iso(now - genAgo * MINUTE_MS);

for (const host of template.hosts ?? []) {
  if (typeof host._collectedAtAgoMinutes === "number") {
    host.collectedAt = iso(now - host._collectedAtAgoMinutes * MINUTE_MS);
  }
}

for (const finding of template.drift ?? []) {
  const waiver = finding.waiver;
  if (waiver && typeof waiver._untilInDays === "number") {
    waiver.until = iso(now + waiver._untilInDays * DAY_MS);
  }
}

const snapshot = stripHelpers(template);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`[make-example-snapshot] wrote ${outPath} (generatedAt ${snapshot.generatedAt})`);

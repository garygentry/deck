import type { DeckConfigDocument, SnapshotDocument } from "../../types.js";

/** Independently invented river/tree estate, disjoint from the primary fixture's identifiers. */
export const config = {
  schemaVersion: 1,
  estate: { name: "watershed-estate", domains: { field: "watershed.invalid" } },
  hosts: [{ name: "rill", kind: "bare-metal", purpose: "Minimal fixture host" }],
  services: [{ name: "spruce", host: "rill", kind: "systemd", purpose: "Minimal fixture service" }],
} satisfies DeckConfigDocument;

export const snapshot = {
  schemaVersion: 1,
  generatedAt: "2026-02-02T00:00:00Z",
  hosts: [{ name: "rill", coverage: "collected", collectedAt: "2026-02-02T00:00:00Z" }],
  services: [{ host: "rill", name: "spruce", state: "running" }],
} satisfies SnapshotDocument;

import { validateSnapshot, type DeckConfigDocument, type SnapshotDocument } from "@deck/schema";
import { benchmarkEstate } from "@deck/schema/fixtures";
import { describe, expect, it } from "vitest";

/** Exact 5 MiB lower bound for the generated performance document. */
const FIVE_MIB = 5 * 1024 * 1024;
/** One source-reader chunk; the valid document must stay inside this upper band. */
const CHUNK_BYTES = 64 * 1024;

/**
 * Build one valid, correctly-sized 5 MiB snapshot and its matching config.
 *
 * The base document comes from the source-verified `benchmarkEstate` factory and
 * is padded only through an open observed `facts` string so `validateSnapshot`
 * still returns classification 0 or 1 and the timed operation measures real
 * parsing and validation rather than an early malformed-document exit. The final
 * serialized UTF-8 length lands in `[FIVE_MIB, FIVE_MIB + 64 KiB)`.
 */
function buildFiveMiBDocument(): {
  text: string;
  config: DeckConfigDocument;
  bytes: number;
} {
  const { config, snapshot } = benchmarkEstate({
    hosts: 8,
    servicesPerHost: 2,
    factsPerEntity: 8,
  });

  const host = (snapshot.hosts ?? [])[0];
  if (host === undefined) throw new Error("benchmarkEstate produced no observed host to pad");
  const facts = (host.facts ?? {}) as Record<string, unknown>;
  host.facts = facts;

  // Aim for the middle of the permitted band. With the pad key already present as
  // an empty ASCII string, growing it by N characters grows the serialized
  // document by exactly N bytes (no JSON escaping for plain ASCII).
  const target = FIVE_MIB + 32 * 1024;
  facts.__pad = "";
  const beforeBytes = Buffer.byteLength(serialize(snapshot), "utf8");
  const padLength = target - beforeBytes;
  if (padLength <= 0) throw new Error("benchmark base document already exceeds the target band");
  facts.__pad = "x".repeat(padLength);

  const text = serialize(snapshot);
  return { text, config, bytes: Buffer.byteLength(text, "utf8") };
}

function serialize(snapshot: SnapshotDocument): string {
  return JSON.stringify(snapshot);
}

describe("snapshot parse + validate performance (REQ-PERF-02)", () => {
  it("parses and validates a valid 5 MiB document under 500 ms (fastest of three)", () => {
    const { text, config, bytes } = buildFiveMiBDocument();

    // The generated valid document sits in the required 5 MiB band.
    expect(bytes).toBeGreaterThanOrEqual(FIVE_MIB);
    expect(bytes).toBeLessThan(FIVE_MIB + CHUNK_BYTES);

    // One unrecorded warm-up of exactly the timed operation.
    {
      const parsed: unknown = JSON.parse(text);
      const warmup = validateSnapshot(parsed, config);
      expect(warmup.classification).not.toBe(2);
    }

    // Three independent samples parsing from the same immutable string.
    const samples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const startedAt = performance.now();
      const parsed: unknown = JSON.parse(text);
      const result = validateSnapshot(parsed, config);
      const elapsed = performance.now() - startedAt;

      expect(result.classification).not.toBe(2);
      expect(Number.isFinite(elapsed)).toBe(true);
      samples.push(elapsed);
    }

    samples.sort((left, right) => left - right);
    // The fastest of three samples must clear the gate on ordinary CI.
    expect(samples[0]).toBeLessThan(500);
  });
});

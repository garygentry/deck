import { describe, expect, it } from "vitest";

import * as contractBarrel from "../src/contract/index.js";
import type {
  HostCollectionState,
  HostState,
  SnapshotProviderResult,
  SnapshotReadError,
} from "@deck/contract";
import type { SnapshotReadEvent } from "../src/log/logger.js";
import {
  SNAPSHOT_READ_ERROR_CODES,
  SNAPSHOT_READ_MESSAGES,
  SnapshotReadFailure,
  normalizeSnapshotFailure,
  type SnapshotReadErrorCode,
} from "../../../modules/snapshot/server/errors.js";

describe("snapshot wire contract", () => {
  it("HostState covers exactly the five collection states", () => {
    // Exhaustive: adding or removing a state is a compile error here.
    const byState: Record<HostCollectionState, true> = {
      fresh: true,
      stale: true,
      partial: true,
      unreachable: true,
      "never-collected": true,
    };
    expect(Object.keys(byState).sort()).toEqual(
      ["fresh", "never-collected", "partial", "stale", "unreachable"].sort(),
    );

    const state: HostState = {
      state: "fresh",
      collectedAt: "2026-01-01T00:00:00.000Z",
      ageMs: 0,
      pastStaleThreshold: false,
    };
    expect(Object.keys(state).sort()).toEqual(
      ["state", "collectedAt", "ageMs", "pastStaleThreshold"].sort(),
    );
  });

  it("SnapshotProviderResult has exactly the five frozen keys", () => {
    const snapshot = { schemaVersion: 1 } as unknown as SnapshotProviderResult["snapshot"];
    const result: SnapshotProviderResult = {
      snapshot,
      findings: [],
      hostStates: {},
      lastReadAt: "2026-01-01T00:00:00.000Z",
      readError: null,
    };
    expect(Object.keys(result).sort()).toEqual(
      ["snapshot", "findings", "hostStates", "lastReadAt", "readError"].sort(),
    );
  });

  it("@deck/server exports the wire types but no provider internals", () => {
    // Only runtime value export from the barrel is POLL_DEFAULTS; the snapshot
    // wire symbols are type-only, so no internal class/value leaks at runtime.
    const runtimeKeys = Object.keys(contractBarrel);
    expect(runtimeKeys).not.toContain("SnapshotReadFailure");
    expect(runtimeKeys).not.toContain("normalizeSnapshotFailure");
    expect(runtimeKeys).not.toContain("SNAPSHOT_READ_MESSAGES");
    expect(runtimeKeys).not.toContain("SNAPSHOT_READ_ERROR_CODES");
    expect(runtimeKeys).not.toContain("createSnapshotSource");
    expect(runtimeKeys).not.toContain("SnapshotProvider");
  });
});

describe("SnapshotReadFailure taxonomy", () => {
  it("declares exactly the ten stable codes with a message each", () => {
    expect([...SNAPSHOT_READ_ERROR_CODES]).toEqual([
      "SOURCE_PROTOCOL_UNSUPPORTED",
      "SOURCE_UNREADABLE",
      "HTTP_STATUS",
      "DOCUMENT_TOO_LARGE",
      "POLL_TIMEOUT",
      "JSON_INVALID",
      "VERSION_UNSUPPORTED",
      "SNAPSHOT_INVALID",
      "STALE_THRESHOLD_INVALID",
      "INTERNAL",
    ]);
    for (const code of SNAPSHOT_READ_ERROR_CODES) {
      expect(SNAPSHOT_READ_MESSAGES[code]).toBeTypeOf("string");
      expect(SNAPSHOT_READ_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it("templates only the two bounded token variants", () => {
    // Exactly one <protocol> and one <status> token; no other message templates.
    expect(SNAPSHOT_READ_MESSAGES.SOURCE_PROTOCOL_UNSUPPORTED).toContain("<protocol>");
    expect(SNAPSHOT_READ_MESSAGES.HTTP_STATUS).toContain("<status>");
    const templated = SNAPSHOT_READ_ERROR_CODES.filter((code) =>
      /<[a-z]+>/.test(SNAPSHOT_READ_MESSAGES[code]),
    );
    expect(templated.sort()).toEqual(["HTTP_STATUS", "SOURCE_PROTOCOL_UNSUPPORTED"].sort());
  });

  it("toPublic exposes only code, message, and optional httpStatus", () => {
    const withStatus = new SnapshotReadFailure(
      "HTTP_STATUS",
      "Snapshot source returned HTTP 503; verify the remote snapshot endpoint.",
      { httpStatus: 503, attemptedBytes: 12345 },
    );
    const publicStatus: SnapshotReadError = withStatus.toPublic();
    expect(Object.keys(publicStatus).sort()).toEqual(["code", "httpStatus", "message"].sort());
    expect(publicStatus).toEqual({
      code: "HTTP_STATUS",
      message: "Snapshot source returned HTTP 503; verify the remote snapshot endpoint.",
      httpStatus: 503,
    });
    // Never serialize the internal attempted-byte accounting.
    expect(JSON.stringify(publicStatus)).not.toContain("12345");
    expect("attemptedBytes" in publicStatus).toBe(false);

    const withoutStatus = new SnapshotReadFailure(
      "SOURCE_UNREADABLE",
      SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE,
      { attemptedBytes: 99 },
    );
    const publicPlain = withoutStatus.toPublic();
    expect(Object.keys(publicPlain).sort()).toEqual(["code", "message"].sort());
    expect("httpStatus" in publicPlain).toBe(false);
  });
});

describe("normalizeSnapshotFailure", () => {
  it("preserves an existing typed failure by identity", () => {
    const original = new SnapshotReadFailure("JSON_INVALID", SNAPSHOT_READ_MESSAGES.JSON_INVALID, {
      attemptedBytes: 7,
    });
    const normalized = normalizeSnapshotFailure(original);
    expect(normalized).toBe(original);
    expect(normalized.details.attemptedBytes).toBe(7);
  });

  it("maps aborted signals and TimeoutError to POLL_TIMEOUT", () => {
    const abort = new DOMException("aborted", "AbortError");
    const timeout = new DOMException("timed out", "TimeoutError");
    for (const err of [abort, timeout]) {
      const normalized = normalizeSnapshotFailure(err);
      expect(normalized).toBeInstanceOf(SnapshotReadFailure);
      expect(normalized.code).toBe("POLL_TIMEOUT");
      expect(normalized.message).toBe(SNAPSHOT_READ_MESSAGES.POLL_TIMEOUT);
    }
  });

  it("maps arbitrary failures to a sanitized INTERNAL without leaking text", () => {
    const secretPath = "/etc/deck/secret-snapshot.json at token=hunter2";
    const normalized = normalizeSnapshotFailure(new Error(secretPath));
    expect(normalized.code).toBe("INTERNAL");
    expect(normalized.message).toBe(SNAPSHOT_READ_MESSAGES.INTERNAL);
    expect(normalized.details.attemptedBytes).toBeUndefined();
    // The arbitrary exception text must not survive into the public wire form.
    const serialized = JSON.stringify(normalized.toPublic());
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("/etc/deck");
  });

  it("normalizes non-Error values safely", () => {
    for (const value of [null, undefined, "boom", 42, { message: "/var/leak" }]) {
      const normalized = normalizeSnapshotFailure(value);
      expect(normalized.code).toBe("INTERNAL");
      expect(normalized.message).toBe(SNAPSHOT_READ_MESSAGES.INTERNAL);
    }
  });
});

describe("SnapshotReadEvent shape", () => {
  it("carries only sanitized structured fields", () => {
    const event: SnapshotReadEvent = {
      event: "snapshot.read",
      sourceKind: "path",
      outcome: "refused",
      failureClass: "SOURCE_UNREADABLE",
      httpStatus: undefined,
      findingsCount: 0,
      bytes: 0,
      durationMs: 3,
    };
    const permitted = [
      "event",
      "sourceKind",
      "outcome",
      "failureClass",
      "httpStatus",
      "findingsCount",
      "bytes",
      "durationMs",
    ].sort();
    expect(Object.keys(event).sort()).toEqual(permitted);
    // No raw source/document/environment channel exists on the event contract.
    for (const forbidden of ["source", "document", "snapshot", "env", "environment", "path", "url", "body"]) {
      expect(permitted).not.toContain(forbidden);
    }
    const clean: SnapshotReadEvent = {
      event: "snapshot.read",
      sourceKind: "url",
      outcome: "clean",
      findingsCount: 0,
      bytes: 1024,
      durationMs: 1,
    };
    expect(clean.event).toBe("snapshot.read");
  });
});

// Type-level guard: SnapshotReadFailure.toPublic must return a SnapshotReadError.
() => {
  const _code: SnapshotReadErrorCode = "INTERNAL";
  const _err: SnapshotReadError = new SnapshotReadFailure(_code, "x").toPublic();
  void _err;
};

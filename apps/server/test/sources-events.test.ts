/**
 * `sources-events.test.ts` — the credential-non-leak guarantee: a source failure's logs carry
 * no credential, and auth reaches git through its env only.
 *
 * With a fixture private-repo source whose `credentialEnv` names an env var set to a sentinel
 * secret, drive a clone failure and assert the sentinel token — and any tokenized remote URL a
 * misbehaving git might echo — appear in NO log argument, NO `SourceFailure.message`, and NO
 * `toPublic()` body; that the failure log carries only `{ sourceId, failureKind }` (+ code);
 * and that `toPublic()` strips `attemptedPath` and any upstream stderr text. The positive half of
 * the guarantee: the token rides an ephemeral `http.extraheader` injected via `GIT_CONFIG_*` env
 * for the clone spawn only — never in the clone URL, the argv, or on disk (see also
 * `sources-acquire.test.ts` for the on-disk non-persistence guard).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Source } from "@deck/schema";

import { acquireSource, type AcquireContext } from "../../../modules/sources/server/acquire.js";
import { SourceFailure } from "../../../modules/sources/server/errors.js";
import { logger } from "../src/log/logger.js";
import { createFakeGitSpawner, type FakeGitSpawner } from "../../../modules/sources/test/server/util/fake-git-spawner.js";
import { makeCacheDir } from "../../../modules/sources/test/server/util/make-cache-dir.js";

// --- Fixtures & helpers ---------------------------------------------------------------

/** The credential-non-leak sentinel — must never appear in any log, error, or public body. */
const SENTINEL = "s3cr3t-token-DO-NOT-LOG";
const CRED_ENV = "DECK_TEST_SOURCE_TOKEN";
const PRIVATE_REPO = "https://example.test/private.git";
/** A userinfo-tokenized URL a misbehaving git could echo on stderr — must never leak to a surface. */
const TOKENIZED_URL = `https://x-access-token:${SENTINEL}@example.test/private.git`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  delete process.env[CRED_ENV];
  vi.restoreAllMocks();
});

function cache(): string {
  const { dir, cleanup } = makeCacheDir();
  cleanups.push(cleanup);
  return dir;
}

function privateGitSource(): Source {
  return {
    id: "secrets",
    kind: "markdown-tree",
    title: "secrets",
    location: { repo: PRIVATE_REPO },
    credentialEnv: CRED_ENV,
  };
}

function ctx(cacheDir: string, git: FakeGitSpawner): AcquireContext {
  return { deps: { cacheDir, git }, signal: new AbortController().signal };
}

/** Serialize every argument of every logger.warn call so a substring scan covers all shapes. */
function loggedText(warn: { mock: { calls: unknown[][] } }): string {
  return warn.mock.calls.map((args) => JSON.stringify(args)).join("\n");
}

// --- Credential non-leak on a failed private-repo clone -----------------------

describe("acquireSource — credential non-leak (private-repo auth)", () => {
  it("never leaks the token or tokenized URL to logs, message, or toPublic(); log is id+kind+code", async () => {
    process.env[CRED_ENV] = SENTINEL;
    const root = cache();
    // The fake git fails AND echoes the tokenized URL on stderr — the drain-and-discard path
    // must keep even that upstream text out of every observable surface.
    const git = createFakeGitSpawner({
      exitCode: 128,
      stderr: [`fatal: unable to access '${TOKENIZED_URL}': authentication failed\n`],
    });
    const warn = vi.spyOn(logger, "warn");

    const err = await acquireSource(privateGitSource(), ctx(root, git)).catch((e) => e);

    // The failure is a classified SourceFailure (clone failed → availability problem).
    expect(err).toBeInstanceOf(SourceFailure);
    const failure = err as SourceFailure;
    expect(failure.code).toBe("SOURCE_UNAVAILABLE");

    // --- The sentinel token leaks nowhere ---
    const logs = loggedText(warn);
    expect(logs).not.toContain(SENTINEL);
    expect(failure.message).not.toContain(SENTINEL);
    expect(JSON.stringify(failure.toPublic())).not.toContain(SENTINEL);

    // --- The tokenized remote URL leaks nowhere either ---
    expect(logs).not.toContain(TOKENIZED_URL);
    expect(logs).not.toContain("x-access-token");
    expect(failure.message).not.toContain(TOKENIZED_URL);
    expect(JSON.stringify(failure.toPublic())).not.toContain("x-access-token");

    // --- The failure log carries only { sourceId, failureKind } (+ code) ---
    expect(warn).toHaveBeenCalledTimes(1);
    const [event] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(event).toEqual({ sourceId: "secrets", failureKind: "clone", code: "SOURCE_UNAVAILABLE" });
    expect(Object.keys(event).sort()).toEqual(["code", "failureKind", "sourceId"]);

    // --- toPublic() strips attemptedPath and any upstream stderr text ---
    const pub = failure.toPublic();
    expect(Object.keys(pub).sort()).toEqual(["code", "error"]);
    expect(pub).not.toHaveProperty("attemptedPath");
    expect(pub.error).toBe("The source could not be acquired; serving the last known content if available.");
    expect(JSON.stringify(pub)).not.toContain("authentication failed");
  });

  it("passes the token via ephemeral http.extraheader env — never in the clone URL or argv", async () => {
    process.env[CRED_ENV] = SENTINEL;
    const root = cache();
    const git = createFakeGitSpawner({ writeFiles: { "readme.md": "# ok\n" } });

    await acquireSource(privateGitSource(), ctx(root, git));

    const clone = git.calls.find((c) => c.isClone);
    expect(clone).toBeDefined();
    // The clone URL git would persist to .git/config is the repo VERBATIM — no userinfo.
    expect(clone!.argv[clone!.argv.length - 2]).toBe(PRIVATE_REPO);
    // The token appears in NO argv element (the arg list is visible via ps/proc).
    expect(clone!.argv.some((a) => a.includes(SENTINEL))).toBe(false);
    expect(clone!.argv.some((a) => a.includes("x-access-token"))).toBe(false);
    // The positive half: auth rides GIT_CONFIG_* env for this spawn only.
    const basic = Buffer.from(`x-access-token:${SENTINEL}`).toString("base64");
    expect(clone!.env?.GIT_CONFIG_COUNT).toBe("1");
    expect(clone!.env?.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(clone!.env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
  });

  it("reads no credential for a public repo (credentialEnv absent) — remote is verbatim", async () => {
    // No credentialEnv on the source: the repo URL must pass through unmodified.
    const root = cache();
    const git = createFakeGitSpawner({ writeFiles: { "readme.md": "# ok\n" } });
    const src: Source = {
      id: "public",
      kind: "markdown-tree",
      title: "public",
      location: { repo: PRIVATE_REPO },
    };

    await acquireSource(src, ctx(root, git));

    const clone = git.calls.find((c) => c.isClone)!;
    expect(clone.argv[clone.argv.length - 2]).toBe(PRIVATE_REPO);
    expect(clone.argv).not.toContain("x-access-token");
  });

  it("attempts unauthenticated when credentialEnv is named but the env var is unset", async () => {
    // credentialEnv points at an UNSET var ⇒ no token ⇒ verbatim URL, clean SOURCE_UNAVAILABLE.
    delete process.env[CRED_ENV];
    const root = cache();
    const git = createFakeGitSpawner({ exitCode: 128 });

    const err = await acquireSource(privateGitSource(), ctx(root, git)).catch((e) => e);

    expect(err).toBeInstanceOf(SourceFailure);
    expect((err as SourceFailure).code).toBe("SOURCE_UNAVAILABLE");
    const clone = git.calls.find((c) => c.isClone)!;
    expect(clone.argv[clone.argv.length - 2]).toBe(PRIVATE_REPO); // no injection
  });
});

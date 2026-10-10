import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Source } from "@deck/schema";

import {
  acquireSource,
  pruneOrphanSources,
  type AcquireContext,
} from "../../server/acquire.js";
import { SourceFailure } from "../../server/errors.js";
import { buildManifest, type BuildManifestOptions, type SourceTreeNode } from "../../server/tree.js";
import { createFakeGitSpawner, gitAbsentError, type FakeGitSpawner } from "./util/fake-git-spawner.js";
import { makeCacheDir } from "./util/make-cache-dir.js";

// --- Fixtures & helpers ---------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function cache(): string {
  const { dir, cleanup } = makeCacheDir();
  cleanups.push(cleanup);
  return dir;
}

function localSource(id: string, path: string): Source {
  return { id, kind: "markdown-tree", title: id, location: { path } };
}

function gitSource(id: string, repo: string, ref?: string): Source {
  return { id, kind: "markdown-tree", title: id, location: ref !== undefined ? { repo, ref } : { repo } };
}

function ctx(cacheDir: string, git: FakeGitSpawner, signal?: AbortSignal): AcquireContext {
  return { deps: { cacheDir, git }, signal: signal ?? new AbortController().signal };
}

const OPTS: BuildManifestOptions = { sourceId: "s", kind: "markdown-tree", title: "s" };

/** Sorted, comma-joined file node names of a manifest built off `root`. */
async function readNames(root: string): Promise<string> {
  const manifest = await buildManifest(root, OPTS);
  const names: string[] = [];
  const visit = (n: SourceTreeNode): void => {
    if (n.type === "file") names.push(n.name);
    for (const c of n.children ?? []) visit(c);
  };
  visit(manifest.tree);
  return names.sort().join(",");
}

/** Like readNames but returns null on a torn read (a gen dir removed mid-walk). */
async function readNamesSafe(root: string): Promise<string | null> {
  try {
    return await readNames(root);
  } catch {
    return null;
  }
}

// --- Local-path acquisition (REQ-ACQ-01, REQ-ACQ-04) ----------------------------------

describe("acquireSource — local path", () => {
  it("acquires in place with zero GitSpawner calls; root is the realpath of path", async () => {
    const root = cache();
    mkdirSync(join(root, "tree"));
    const treeDir = join(root, "tree");
    writeFileSync(join(treeDir, "a.md"), "alpha");

    const git = createFakeGitSpawner({});
    const acquired = await acquireSource(localSource("docs", treeDir), ctx(root, git));

    expect(git.calls).toHaveLength(0); // no clone, no spawn at all
    expect(acquired.root).toBe(await realpath(treeDir));
    expect(acquired.ref).toBeUndefined();
  });

  it("re-walks each poll so a file added between polls surfaces", async () => {
    const root = cache();
    const treeDir = join(root, "tree");
    mkdirSync(treeDir);
    writeFileSync(join(treeDir, "a.md"), "alpha");

    const git = createFakeGitSpawner({});
    const first = await acquireSource(localSource("docs", treeDir), ctx(root, git));
    expect(await readNames(first.root)).toBe("a.md");

    // A file appears in the mounted tree between polls.
    writeFileSync(join(treeDir, "b.md"), "bravo");
    const second = await acquireSource(localSource("docs", treeDir), ctx(root, git));
    expect(await readNames(second.root)).toBe("a.md,b.md");
  });

  it("a non-directory / missing path throws SOURCE_UNAVAILABLE", async () => {
    const root = cache();
    const git = createFakeGitSpawner({});
    await expect(acquireSource(localSource("docs", join(root, "nope")), ctx(root, git))).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
});

// --- Git shallow-clone happy path (REQ-ACQ-01/02) -------------------------------------

describe("acquireSource — git clone argv", () => {
  it("spawns ['git','clone','--depth','1',…] with --branch present iff ref is set", async () => {
    const root = cache();
    const git = createFakeGitSpawner({ writeFiles: { "a.md": "A", "b.md": "B" } });
    const acquired = await acquireSource(gitSource("repo", "https://example.test/r.git", "main"), ctx(root, git));

    const clone = git.calls.find((c) => c.isClone);
    expect(clone).toBeDefined();
    expect(Array.isArray(clone!.argv)).toBe(true);
    expect(clone!.argv.slice(0, 7)).toEqual([
      "git",
      "-c",
      "credential.helper=",
      "clone",
      "--depth",
      "1",
      "--single-branch",
    ]);
    expect(clone!.argv).toContain("--branch");
    expect(clone!.argv[clone!.argv.indexOf("--branch") + 1]).toBe("main");
    // `--` terminates options; the two trailing positionals are the repo and the incoming dir.
    expect(clone!.argv[clone!.argv.length - 2]).toBe("https://example.test/r.git");
    expect(clone!.argv[clone!.argv.length - 1]).toContain("gen-");
    expect(clone!.cwd).toBe(join(root, "repo"));

    // The published root is the confined gen dir; ref echoes the resolved commit.
    expect(acquired.root).toBe(await realpath(join(root, "repo", "current")));
    expect(acquired.ref).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(await readNames(acquired.root)).toBe("a.md,b.md");
  });

  it("omits --branch when no ref is declared", async () => {
    const root = cache();
    const git = createFakeGitSpawner({ writeFiles: { "a.md": "A" } });
    await acquireSource(gitSource("repo", "https://example.test/r.git"), ctx(root, git));

    const clone = git.calls.find((c) => c.isClone)!;
    expect(clone.argv).not.toContain("--branch");
    expect(clone.argv[clone.argv.length - 2]).toBe("https://example.test/r.git");
  });
});

// --- Private-repo credential — no on-disk / arg-list token leak (REQ-ACQ-03, REQ-SEC-03) --

const SENTINEL = "ghp_SENTINELtoken00000000000000000000000";

/** Every regular file's contents under `dir` (recursive), joined — to assert a secret never landed. */
function allFileText(dir: string): string {
  const parts: string[] = [];
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    try {
      if (statSync(abs).isFile()) parts.push(readFileSync(abs, "utf8"));
    } catch {
      // dangling/loop symlink (e.g. the `current` publish link) or non-utf8 — skip
    }
  }
  return parts.join("\n");
}

function privateGitSource(id: string, repo: string, credentialEnv: string): Source {
  return { id, kind: "markdown-tree", title: id, location: { repo }, credentialEnv };
}

describe("acquireSource — private-repo credential (REQ-ACQ-03, REQ-SEC-03)", () => {
  it("carries the token as an ephemeral http.extraheader env — never in the URL, argv, or on disk", async () => {
    const root = cache();
    process.env.DECK_TEST_PAT = SENTINEL;
    cleanups.push(() => {
      delete process.env.DECK_TEST_PAT;
    });

    const git = createFakeGitSpawner({ writeFiles: { "a.md": "A" } });
    const acquired = await acquireSource(
      privateGitSource("priv", "https://example.test/r.git", "DECK_TEST_PAT"),
      ctx(root, git),
    );

    const clone = git.calls.find((c) => c.isClone)!;
    // 1. The clone URL git would write into .git/config is the repo VERBATIM — no userinfo.
    expect(clone.argv[clone.argv.length - 2]).toBe("https://example.test/r.git");
    // 2. The token is in NO argv element (the arg list is visible via ps/proc).
    expect(clone.argv.some((a) => a.includes(SENTINEL))).toBe(false);
    expect(clone.argv.some((a) => a.includes("x-access-token"))).toBe(false);
    // 3. Auth rides GIT_CONFIG_* env for this spawn only, as an Authorization: Basic header.
    const basic = Buffer.from(`x-access-token:${SENTINEL}`).toString("base64");
    expect(clone.env?.GIT_CONFIG_COUNT).toBe("1");
    expect(clone.env?.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(clone.env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
    // 4. The raw token never lands anywhere under the cache dir on disk.
    expect(allFileText(root)).not.toContain(SENTINEL);
    // …and it is still a working acquisition.
    expect(await readNames(acquired.root)).toBe("a.md");
  });

  it("injects no auth header when the named env var is unset (attempt unauthenticated)", async () => {
    const root = cache();
    delete process.env.DECK_TEST_PAT_UNSET;
    const git = createFakeGitSpawner({ writeFiles: { "a.md": "A" } });
    await acquireSource(
      privateGitSource("priv2", "https://example.test/r.git", "DECK_TEST_PAT_UNSET"),
      ctx(root, git),
    );
    const clone = git.calls.find((c) => c.isClone)!;
    expect(clone.env?.GIT_CONFIG_COUNT).toBeUndefined();
    expect(clone.argv[clone.argv.length - 2]).toBe("https://example.test/r.git");
  });

  it("injects no auth header for a non-HTTPS remote even when the token is present", async () => {
    const root = cache();
    process.env.DECK_TEST_PAT = SENTINEL;
    cleanups.push(() => {
      delete process.env.DECK_TEST_PAT;
    });
    const git = createFakeGitSpawner({ writeFiles: { "a.md": "A" } });
    await acquireSource(
      privateGitSource("priv3", "git@github.com:o/r.git", "DECK_TEST_PAT"),
      ctx(root, git),
    );
    const clone = git.calls.find((c) => c.isClone)!;
    expect(clone.env?.GIT_CONFIG_COUNT).toBeUndefined();
    expect(clone.argv.some((a) => a.includes(SENTINEL))).toBe(false);
  });
});

// --- Atomic swap — no half-updated tree (REQ-FRESH-04, SC-06) -------------------------

describe("acquireSource — atomic swap interleave", () => {
  it("every read across the swap observes a whole tree (A or B), never a mix", async () => {
    const root = cache();
    const src = gitSource("repo", "https://example.test/r.git", "main");
    const currentPath = join(root, "repo", "current");

    // Poll #1 publishes tree A = {a.md, b.md}.
    const git = createFakeGitSpawner([
      { writeFiles: { "a.md": "A", "b.md": "B" } },
      { writeFiles: { "a.md": "A", "c.md": "C" }, hang: true }, // Poll #2 stages a DIFFERENT tree B = {a.md, c.md}
    ]);
    await acquireSource(src, ctx(root, git));
    expect(await readNames(currentPath)).toBe("a.md,b.md");

    // Poll #2: begin acquisition but gate the clone's `exited` so the swap is pending.
    const poll2 = acquireSource(src, ctx(root, git));
    await waitFor(() => git.calls.filter((c) => c.isClone).length === 2);
    const clone2 = git.calls.filter((c) => c.isClone)[1];

    // Reads BEFORE the swap: still wholly A (current → genA, present).
    const before = await Promise.all(Array.from({ length: 10 }, () => readNames(currentPath)));
    for (const names of before) expect(names).toBe("a.md,b.md");

    // Interleave a batch of reads with the swap: schedule, then release concurrently.
    const interleaved: Array<Promise<string | null>> = Array.from({ length: 30 }, () =>
      readNamesSafe(currentPath),
    );
    clone2.releaseHang();
    const duringResults = (await Promise.all(interleaved)).filter((x): x is string => x !== null);
    await poll2;

    // Reads AFTER the swap: wholly B (current → genB).
    const after = await Promise.all(Array.from({ length: 10 }, () => readNames(currentPath)));
    for (const names of after) expect(names).toBe("a.md,c.md");

    // The core property: EVERY observed manifest is wholly-A or wholly-B, never mixed
    // (`a.md` alone, or `a.md,b.md,c.md`).
    for (const names of [...before, ...duringResults, ...after]) {
      expect(["a.md,b.md", "a.md,c.md"]).toContain(names);
    }
  });
});

// --- Bounded cache & prune (REQ-FRESH-05) ---------------------------------------------

describe("acquireSource — bounded cache", () => {
  it("at rest the source dir holds only current + one generation (old gen pruned)", async () => {
    const root = cache();
    const src = gitSource("repo", "https://example.test/r.git", "main");
    const git = createFakeGitSpawner([
      { writeFiles: { "a.md": "A" } },
      { writeFiles: { "a.md": "A", "c.md": "C" } },
    ]);

    await acquireSource(src, ctx(root, git));
    await acquireSource(src, ctx(root, git)); // second swap must drop the superseded generation

    const entries = readdirSync(join(root, "repo"));
    const gens = entries.filter((n) => n.startsWith("gen-"));
    expect(gens).toHaveLength(1); // exactly one generation at rest
    expect(entries).toContain("current");
    expect(entries.some((n) => n.includes(".tmp-"))).toBe(false); // no leftover temp symlink
  });

  it("pruneOrphanSources releases undeclared source dirs and preserves declared ones", async () => {
    const root = cache();
    mkdirSync(join(root, "kept"));
    mkdirSync(join(root, "orphan"));
    writeFileSync(join(root, "orphan", "stale.md"), "old");

    await pruneOrphanSources(root, ["kept"]);

    const remaining = readdirSync(root);
    expect(remaining).toContain("kept");
    expect(remaining).not.toContain("orphan");
  });
});

// --- Failure classification (REQ-FRESH-02/03) -----------------------------------------

describe("acquireSource — failure classification", () => {
  it("a non-zero clone exit → SOURCE_UNAVAILABLE", async () => {
    const root = cache();
    const git = createFakeGitSpawner({ exitCode: 1, stderr: ["fatal: could not read from remote\n"] });
    const err = await acquireSource(gitSource("repo", "https://example.test/r.git"), ctx(root, git)).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SourceFailure);
    expect(err.code).toBe("SOURCE_UNAVAILABLE");
  });

  it("a spawn throw (git absent / ENOENT) → SOURCE_UNAVAILABLE", async () => {
    const root = cache();
    const git = createFakeGitSpawner({ throwOnSpawn: gitAbsentError() });
    const err = await acquireSource(gitSource("repo", "https://example.test/r.git"), ctx(root, git)).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SourceFailure);
    expect(err.code).toBe("SOURCE_UNAVAILABLE");
  });

  it("an aborted signal → ACQUIRE_TIMEOUT", async () => {
    const root = cache();
    const controller = new AbortController();
    controller.abort(); // the registry aborts ctx.signal on the poll timeout
    const git = createFakeGitSpawner({ writeFiles: { "a.md": "A" }, hang: true });
    const err = await acquireSource(
      gitSource("repo", "https://example.test/r.git"),
      ctx(root, git, controller.signal),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SourceFailure);
    expect(err.code).toBe("ACQUIRE_TIMEOUT");
  });

  it("a clone failure leaves an existing current (last-good) intact", async () => {
    const root = cache();
    const src = gitSource("repo", "https://example.test/r.git", "main");
    const git = createFakeGitSpawner([
      { writeFiles: { "a.md": "A", "b.md": "B" } }, // poll #1 succeeds
      { exitCode: 1 }, // poll #2 fails
    ]);
    await acquireSource(src, ctx(root, git));
    await expect(acquireSource(src, ctx(root, git))).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });

    // Last-good tree still served.
    expect(await readNames(join(root, "repo", "current"))).toBe("a.md,b.md");
  });
});

/** Poll a synchronous predicate across microtasks until true (bounded). */
async function waitFor(pred: () => boolean, tries = 1000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitFor: predicate never became true");
}

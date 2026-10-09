import { canonicalize } from "../../config/canonical.js";
import type { DeckConfig } from "../../contract/index.js";
import type { RuntimePages, RuntimePageSource } from "../../ui/runtime-pages.js";
import type { RemoteDescribe } from "./describe.js";
import { remotePagesOf } from "./pages.js";

/** Where an integration's contributions render, as its config sets it. */
export interface RemotePageConfig {
  path: string;
  icon?: string;
  nav?: { group: string; label?: string; order?: number };
}

/** Why an integration's describe could not be used (its last good one, if any, still stands). */
export interface RemoteDescribeProblem {
  code: "REMOTE_DESCRIBE_INVALID" | "REMOTE_DESCRIBE_UNREACHABLE";
  message: string;
}

/** One `remote` integration's contributions: its page, its last good describe and its latest problem. */
export interface RemoteContribution {
  /** The integration's id: the provider its widgets read. */
  instance: string;
  /** The integration's title. */
  title: string;
  page: RemotePageConfig;
  /** The last describe that passed every check; absent until one has. */
  describe?: RemoteDescribe;
  /** Notes on the describe in use (it named another id, say). */
  notes?: string[];
  /** Why the latest describe was not used; absent when it was. */
  problem?: RemoteDescribeProblem;
}

/**
 * The `remote` integrations of one module host and what each contributes. Each provider writes
 * its own entry; readers get a sorted snapshot, and listeners hear of a change only when the
 * snapshot's content changed, so a sidecar describing itself the same way churns nothing. It is
 * the module's runtime page source: the UI manifest renders its integrations' pages.
 */
export class RemoteDirectory implements RuntimePageSource {
  private readonly entries = new Map<string, RemoteContribution>();
  private readonly listeners = new Set<() => void>();
  private canonical = canonicalize([] as unknown as DeckConfig);

  /** Declare an integration, before any describe. */
  declare(instance: string, title: string, page: RemotePageConfig): void {
    this.entries.set(instance, { instance, title, page });
    this.changed();
  }

  /** A describe passed every check: it replaces the one in use and clears the problem. */
  accept(instance: string, describe: RemoteDescribe, notes: readonly string[]): void {
    const entry = this.entries.get(instance);
    if (entry === undefined) return;
    const { problem: _cleared, notes: _old, ...rest } = entry;
    this.entries.set(instance, { ...rest, describe, ...(notes.length === 0 ? {} : { notes: [...notes] }) });
    this.changed();
  }

  /** A describe failed: the one in use stays, with the problem beside it. */
  refuse(instance: string, problem: RemoteDescribeProblem): void {
    const entry = this.entries.get(instance);
    if (entry === undefined) return;
    this.entries.set(instance, { ...entry, problem });
    this.changed();
  }

  /** Every integration's contributions, by id. Deep copies. */
  snapshot(): RemoteContribution[] {
    return structuredClone([...this.entries.values()].sort((a, b) => (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0)));
  }

  /** The integrations' pages, nav entries and findings, from the snapshot. */
  current(): RuntimePages {
    return remotePagesOf(this.snapshot());
  }

  /** Hear of each change to the snapshot; the returned function stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    // Key order aside: a sidecar answering the same document reordered changes nothing.
    const next = canonicalize(this.snapshot() as unknown as DeckConfig);
    if (next === this.canonical) return;
    this.canonical = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own; the directory and the other listeners carry on.
      }
    }
  }
}

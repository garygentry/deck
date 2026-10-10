/**
 * The owned-configs entity fragment: the `configs` section on the host and service detail pages.
 *
 * Attached by id on both detail pages (index.ts). The page passes only `{ entity: EntityRef }`,
 * so the fragment fetches its OWN data and freshness. It lists the config files from every
 * file-tree source OWNED by the entity, each linking to its read-only Configs view; when the
 * entity owns nothing it renders its OWN compact accessible empty state (role="status").
 *
 * Because it lists files across MULTIPLE file-tree sources it cannot use the single-active-source
 * browse store (`sources-store.ts` holds one active source). It reads `DeckConfig.sources` via
 * the shell `useConfig`, computes the owning sources, and — per owning source — reads that
 * source's manifest with the store-independent, never-throw `fetchManifest(id, signal?)` into
 * local component state under an AbortController.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { ProviderEnvelope } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import type { SourceManifest, SourceTreeNode } from "../server/types.js";
import { useConfig } from "@/data";
import { EmptyState, ErrorState, FreshnessBadge, List, ListItem, LoadingState } from "@/ui";
import type { EntityRef } from "@/registry/registry.js";
import { fetchManifest, type Source } from "./client.js";
import { configsHref } from "./links.js";

export interface OwnedConfigsFragmentProps {
  /** The entity whose detail page mounts this fragment (host or service). */
  readonly entity: EntityRef;
}

/**
 * File-tree sources owned by `entity`:
 *  - host page (entity.entity === "host"):     owner.host === entity.host
 *  - service page (entity.entity === "service"): owner.host === entity.host
 *                                                AND owner.service === entity.name
 * Declared order is preserved. Pure; exported for tests.
 */
export function ownedFileTreeSources(config: DeckConfig, entity: EntityRef): readonly Source[] {
  return (config.sources ?? []).filter((s) => {
    if (s.kind !== "file-tree" || s.owner === undefined) return false;
    if (s.owner.host !== entity.host) return false;
    if (entity.entity === "service") return s.owner.service === entity.name;
    // On a host page, list host-owned sources whether or not they also name a service.
    return true;
  });
}

/** Flatten a source tree to its file paths (dirs excluded), depth-first. Pure; exported for tests. */
export function collectFilePaths(root: SourceTreeNode): readonly string[] {
  const out: string[] = [];
  const walk = (node: SourceTreeNode): void => {
    if (node.type === "file") out.push(node.path);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

/**
 * The `configs`-section fragment: lists config files from file-tree sources OWNED by this entity,
 * each linking to its read-only Configs view. Renders its OWN compact empty state when the
 * entity owns nothing.
 */
export function OwnedConfigsFragment({ entity }: OwnedConfigsFragmentProps): JSX.Element {
  return (
    <div data-slot="owned-configs" className="flex flex-col gap-2">
      <OwnedConfigsContent entity={entity} />
    </div>
  );
}

function OwnedConfigsContent({ entity }: OwnedConfigsFragmentProps): JSX.Element {
  const config = useConfig();
  if (config.status === "loading") return <LoadingState label="Loading configs…" rows={2} />;
  if (config.status === "error") {
    return <ErrorState compact title="Configs unavailable" message={config.message} />;
  }
  const owned = ownedFileTreeSources(config.config, entity);
  if (owned.length === 0) return <OwnedConfigsEmpty />;
  return (
    <List variant="divided" aria-label="Config files owned by this entity">
      {owned.map((source) => (
        <OwnedSourceGroup key={source.id} source={source} />
      ))}
    </List>
  );
}

/** Local fetch state for one owned source's manifest. */
type GroupState =
  | { status: "loading" }
  | { status: "ready"; envelope: ProviderEnvelope<SourceManifest> }
  | { status: "error"; message: string };

/** Discriminate the never-throw fetchManifest result: an envelope carries a `data` field. */
function isEnvelope(
  result: ProviderEnvelope<SourceManifest> | { message: string; code: string },
): result is ProviderEnvelope<SourceManifest> {
  return "data" in result;
}

/** One owned source: its title + freshness, then each file linking to the Configs view. */
function OwnedSourceGroup({ source }: { readonly source: Source }): JSX.Element {
  const [state, setState] = useState<GroupState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setState({ status: "loading" });
    void fetchManifest(source.id, controller.signal).then((result) => {
      if (!live) return;
      setState(
        isEnvelope(result)
          ? { status: "ready", envelope: result }
          : { status: "error", message: result.message },
      );
    });
    return () => {
      live = false;
      controller.abort();
    };
  }, [source.id]);

  if (state.status === "loading") {
    return <ListItem title={<span role="status">Loading {source.title}…</span>} />;
  }
  if (state.status === "error") {
    return <ListItem title={source.title} description={<span role="alert">Unavailable</span>} />;
  }

  const env = state.envelope;
  const freshness = <FreshnessBadge freshness={env.freshness} />;
  if (env.data === null) {
    // First-ever acquisition failure for this source.
    return (
      <ListItem
        title={source.title}
        meta={freshness}
        description={<span role="alert">Unavailable</span>}
      />
    );
  }
  const paths = collectFilePaths(env.data.tree);
  if (paths.length === 0) {
    // Acquired but empty: still show the source, with a compact per-source empty note.
    return (
      <ListItem
        title={source.title}
        meta={freshness}
        description={<span role="status">No files</span>}
      />
    );
  }
  return (
    <ListItem title={source.title} meta={freshness}>
      <List className="mt-1">
        {paths.map((path) => (
          // Deep link to the read-only Configs view.
          <ListItem
            key={path}
            href={configsHref(source.id, path)}
            title={<span className="font-mono text-xs break-all">{path}</span>}
          />
        ))}
      </List>
    </ListItem>
  );
}

/** Compact, accessible empty state when the entity owns no config files. */
function OwnedConfigsEmpty(): JSX.Element {
  return <EmptyState compact title="No config files are owned by this entity." />;
}

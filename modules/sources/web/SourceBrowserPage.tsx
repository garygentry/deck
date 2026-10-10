/**
 * The source browser: one page component behind both `/docs` (markdown-tree sources, rendered as
 * sanitized prose) and `/configs` (file-tree sources, rendered as highlighted code), parameterized
 * by {@link SourceBrowserKind} (REQ-DOCS-01/02/06, REQ-CFG-01/02/05, REQ-SEC-04, REQ-FRESH-*,
 * REQ-SRC-06, REQ-SEARCH-01/02).
 *
 * Layout: a `PageHeader` (freshness in the meta slot, the source switcher as the action when more
 * than one source of the kind is declared), then two panes — a sidebar with the file-tree filter,
 * the `TreeView` and the content search, and the content pane. The config ladder (loading /
 * error / ready) is `ConfigGateView`; render failures are isolated by `PageErrorBoundary`.
 *
 * The active source and document follow the URL query (`?source=<id>&path=<rel>`); the browse
 * state itself lives in the singleton `sources-store`, driven by the `use-source` load hooks. A
 * binary Configs selection never loads its content as text (REQ-CFG-04): `fileLoadPath` yields
 * null for it, so `useFileLoad` is a no-op and the viewer renders the placeholder from the
 * manifest flag.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { DeckConfig } from "@deck/server";
import type { SourceTreeNode } from "../server/types.js";
import { useConfig } from "@/data";
import { useLocation } from "@/shell/router";
import {
  ConfigGateView,
  EmptyState,
  ErrorState,
  FreshnessBadge,
  LoadingState,
  PageErrorBoundary,
  SearchInput,
  SegmentedControl,
  TreeView,
  useListNavigation,
  type ConfigGateState,
} from "@/ui";
import type { SearchState, Source } from "./client.js";
import { fileLoadPath, findNode, sourceHref } from "./links.js";
import { selectPath, selectSource, setFilter, getSourceBrowse } from "./sources-store.js";
import type { SourceBrowseState } from "./sources-store.js";
import { useFileLoad, useManifestLoad, useSearchLoad, useSourceBrowse } from "./use-source.js";
import { FileViewer } from "./components/FileViewer.js";
import { MarkdownView } from "./components/MarkdownView.js";
import { SearchResults } from "./components/SearchResults.js";
import { VerbatimNotice } from "./components/VerbatimNotice.js";

export type SourceBrowserKind = "docs" | "configs";

interface SourceBrowserSpec {
  /** The `Source.kind` this page browses. */
  readonly sourceKind: "markdown-tree" | "file-tree";
  readonly title: string;
  readonly route: string;
  readonly loadingLabel: string;
  /** No source of this kind is declared. */
  readonly noSources: { readonly title: string; readonly description?: string };
  /** The active source acquired but has no files. */
  readonly emptySource: { readonly title: string; readonly description: string };
  /** Accessible name of the content-search field. */
  readonly searchLabel: string;
  /** The render-failure fallback (PageErrorBoundary). */
  readonly failureTitle: string;
  readonly failureRetry: string;
  /** Show the verbatim / no-redaction notice (REQ-SEC-04). */
  readonly verbatimNotice: boolean;
}

const SPECS: Readonly<Record<SourceBrowserKind, SourceBrowserSpec>> = {
  docs: {
    sourceKind: "markdown-tree",
    title: "Docs",
    route: "/docs",
    loadingLabel: "Loading docs…",
    noSources: { title: "No documentation sources are configured." },
    emptySource: {
      title: "No documents to show",
      description: "This source's include/exclude matched no files.",
    },
    searchLabel: "Search document contents",
    failureTitle: "Docs view could not be displayed",
    failureRetry: "Retry docs view",
    verbatimNotice: false,
  },
  configs: {
    sourceKind: "file-tree",
    title: "Configs",
    route: "/configs",
    loadingLabel: "Loading configs…",
    noSources: {
      title: "No config sources",
      description: "No file-tree sources are declared for this deck instance.",
    },
    emptySource: {
      title: "Nothing to show",
      description: "This source acquired successfully but has no files to show.",
    },
    searchLabel: "Search this source",
    failureTitle: "Configs view could not be displayed",
    failureRetry: "Retry configs view",
    verbatimNotice: true,
  },
};

const FAILURE_MESSAGE = "This display failed independently of the server.";

/** Registered `/docs` route component. */
export function DocsPage(): JSX.Element {
  return <SourceBrowserPage kind="docs" />;
}

/** Registered `/configs` route component. */
export function ConfigsPage(): JSX.Element {
  return <SourceBrowserPage kind="configs" />;
}

export interface SourceBrowserPageProps {
  readonly kind: SourceBrowserKind;
}

/**
 * The page: a `data-slot` root, isolated by a page error boundary, bound to the shell
 * config.
 */
export function SourceBrowserPage({ kind }: SourceBrowserPageProps): JSX.Element {
  const spec = SPECS[kind];
  return (
    <div data-slot="sources-page" data-sources-kind={kind}>
      <PageErrorBoundary
        title={spec.failureTitle}
        message={FAILURE_MESSAGE}
        retryLabel={spec.failureRetry}
      >
        <SourceBrowserGate kind={kind} />
      </PageErrorBoundary>
    </div>
  );
}

/** Retry on a config failure refetches by remounting the `useConfig` loader. */
function SourceBrowserGate({ kind }: SourceBrowserPageProps): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  return (
    <SourceBrowserLoader key={attempt} kind={kind} onRetry={() => setAttempt((n) => n + 1)} />
  );
}

function SourceBrowserLoader({
  kind,
  onRetry,
}: SourceBrowserPageProps & { readonly onRetry: () => void }): JSX.Element {
  const state = useConfig();
  return <SourceBrowserView kind={kind} state={state} onRetry={onRetry} />;
}

export interface SourceBrowserReadyProps extends SourceBrowserPageProps {
  readonly config: DeckConfig;
}

/** The ready page for a given config (render tests drive it with a pre-populated store). */
export function SourceBrowserReady({ kind, config }: SourceBrowserReadyProps): JSX.Element {
  return <SourceBrowserView kind={kind} state={{ status: "ready", config }} />;
}

export interface SourceBrowserViewProps extends SourceBrowserPageProps {
  readonly state: ConfigGateState<DeckConfig>;
  readonly onRetry?: () => void;
}

/**
 * The whole page for one config state. Every hook runs unconditionally (the header's freshness
 * and switcher depend on the browse state), so the loading, error and "no sources" branches stay
 * hook-safe.
 */
export function SourceBrowserView({ kind, state, onRetry }: SourceBrowserViewProps): JSX.Element {
  const spec = SPECS[kind];
  const config = state.status === "ready" ? state.config : null;
  const sources = useMemo<readonly Source[]>(
    () => (config?.sources ?? []).filter((source) => source.kind === spec.sourceKind),
    [config, spec.sourceKind],
  );

  const location = useLocation();
  const querySource = location.query.source;
  const queryPath = location.query.path;

  const activeId = useMemo<string | null>(() => {
    const first = sources[0];
    if (first === undefined) return null;
    if (querySource !== undefined && sources.some((source) => source.id === querySource)) {
      return querySource;
    }
    return first.id;
  }, [sources, querySource]);

  // Sync the store selection with the derived active id + URL path query.
  useEffect(() => {
    if (activeId === null) return;
    if (getSourceBrowse().activeSourceId !== activeId) selectSource(activeId);
    if (queryPath !== undefined && queryPath !== "" && getSourceBrowse().selectedPath !== queryPath) {
      selectPath(queryPath);
    }
  }, [activeId, queryPath]);

  const browse = useSourceBrowse();
  const [searchQuery, setSearchQuery] = useState("");
  const [manifestAttempt, setManifestAttempt] = useState(0);

  // The store is shared with the other browser page: only drive loads (and show the store's
  // state) once it holds this page's active source.
  const liveId = activeId !== null && browse.activeSourceId === activeId ? activeId : null;
  const { manifest } = browse;
  const tree =
    manifest.status === "ready" && manifest.envelope.data !== null
      ? manifest.envelope.data.tree
      : null;
  const selectedNode =
    tree !== null && browse.selectedPath !== null ? findNode(tree, browse.selectedPath) : null;
  // Configs skips the content load for binary nodes (REQ-CFG-04); Docs loads the selected path.
  const loadPath =
    spec.sourceKind === "file-tree"
      ? fileLoadPath(selectedNode, browse.selectedPath)
      : browse.selectedPath;

  useManifestLoad(liveId, manifestAttempt);
  useFileLoad(liveId, loadPath);
  useSearchLoad(liveId, searchQuery);

  const onSwitch = (nextId: string): void => {
    selectSource(nextId);
    setSearchQuery("");
    location.route(sourceHref(spec.route, nextId), true);
  };
  const retryManifest = (id: string): void => {
    selectSource(id);
    setManifestAttempt((n) => n + 1);
  };

  const freshness =
    liveId !== null && manifest.status === "ready" ? (
      <FreshnessBadge freshness={manifest.envelope.freshness} />
    ) : undefined;
  const switcher =
    activeId !== null && sources.length > 1 ? (
      <SegmentedControl
        label="Source"
        options={sources.map((source) => ({ value: source.id, label: source.title || source.id }))}
        value={activeId}
        onValueChange={onSwitch}
        className="max-w-full flex-wrap"
      />
    ) : undefined;

  return (
    <ConfigGateView
      state={state}
      title={spec.title}
      loadingLabel={spec.loadingLabel}
      onRetry={onRetry}
      meta={freshness}
      actions={switcher}
    >
      {() => {
        if (activeId === null) {
          return <EmptyState title={spec.noSources.title} description={spec.noSources.description} />;
        }
        return (
          <>
            {spec.verbatimNotice && <VerbatimNotice surface={kind} />}
            <SourceBrowserBody
              kind={kind}
              spec={spec}
              sourceId={activeId}
              browse={liveId === null ? null : browse}
              selectedNode={selectedNode}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onRetry={() => retryManifest(activeId)}
            />
          </>
        );
      }}
    </ConfigGateView>
  );
}

interface SourceBrowserBodyProps {
  readonly kind: SourceBrowserKind;
  readonly spec: SourceBrowserSpec;
  readonly sourceId: string;
  /** The browse state, or null while the store still holds another page's source. */
  readonly browse: SourceBrowseState | null;
  readonly selectedNode: SourceTreeNode | null;
  readonly searchQuery: string;
  readonly onSearchChange: (query: string) => void;
  readonly onRetry: () => void;
}

function SourceBrowserBody({
  kind,
  spec,
  sourceId,
  browse,
  selectedNode,
  searchQuery,
  onSearchChange,
  onRetry,
}: SourceBrowserBodyProps): JSX.Element {
  if (browse === null || browse.manifest.status === "loading") {
    return <LoadingState label="Loading source…" />;
  }
  const { manifest } = browse;
  if (manifest.status === "error") {
    return (
      <ErrorState
        title="This source could not be loaded"
        message={manifest.error.message}
        onRetry={onRetry}
      />
    );
  }
  const { envelope } = manifest;
  if (envelope.data === null) {
    // First-ever acquisition failure: an explicit error, never the empty state (SC-06 vs SC-15).
    return (
      <ErrorState
        title="This source could not be loaded"
        message={envelope.error?.message ?? "The source is unavailable."}
        onRetry={onRetry}
      />
    );
  }
  if (envelope.data.fileCount === 0) {
    return (
      <EmptyState title={spec.emptySource.title} description={spec.emptySource.description} />
    );
  }

  return (
    // Two panes once the content column (not the viewport: the app sidebar takes its share) is
    // wide enough; stacked below that.
    <div className="@container">
      <div className="grid items-start gap-6 @3xl:grid-cols-[16rem_minmax(0,1fr)]">
        <SourceSidebar
          key={sourceId}
          tree={envelope.data.tree}
          filter={browse.filter}
          selectedPath={browse.selectedPath}
          searchLabel={spec.searchLabel}
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          search={browse.search}
        />
        <div className="min-w-0">
          {kind === "docs" ? (
            <MarkdownView sourceId={sourceId} file={browse.file} selectedPath={browse.selectedPath} />
          ) : (
            <FileViewer node={selectedNode} file={browse.file} />
          )}
        </div>
      </div>
    </div>
  );
}

interface SourceSidebarProps {
  readonly tree: SourceTreeNode;
  readonly filter: string;
  readonly selectedPath: string | null;
  readonly searchLabel: string;
  readonly searchQuery: string;
  readonly onSearchChange: (query: string) => void;
  readonly search: SearchState;
}

const FILTER_SELECTOR = "[data-sources-filter]";
const NO_ITEMS: readonly HTMLElement[] = [];

const nodeId = (node: SourceTreeNode): string => node.path;
const nodeLabel = (node: SourceTreeNode): string => node.name;
const nodeChildren = (node: SourceTreeNode): readonly SourceTreeNode[] | undefined => node.children;
/** An empty folder is still a folder. */
const nodeIsLeaf = (node: SourceTreeNode): boolean => node.type === "file";

/**
 * The navigation pane: the instant client-side path filter (REQ-SEARCH-02), the file tree and the
 * server-side content search (REQ-SEARCH-01). Tree keys are the TreeView's own; this pane adds
 * `/` and Ctrl/Cmd-K (focus the filter) and Escape (clear it).
 */
function SourceSidebar({
  tree,
  filter,
  selectedPath,
  searchLabel,
  searchQuery,
  onSearchChange,
  search,
}: SourceSidebarProps): JSX.Element {
  const paneRef = useRef<HTMLDivElement>(null);

  useListNavigation({
    scope: "element",
    containerRef: paneRef,
    keys: "arrows",
    // The tree navigates itself; this listener only claims the filter shortcuts.
    getItems: () => NO_ITEMS,
    getSearch: () => paneRef.current?.querySelector<HTMLElement>(FILTER_SELECTOR) ?? null,
    onEscape: () => {
      if (getSourceBrowse().filter === "") return false;
      setFilter("");
      return true;
    },
  });

  // A file survives when its path contains the query (a folder survives through its files), so
  // filtering by a folder name keeps that folder's files. Memoized: TreeView keys its
  // collapse-while-filtering state on the predicate's identity.
  const predicate = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return undefined;
    return (node: SourceTreeNode): boolean =>
      node.type === "file" && node.path.toLowerCase().includes(needle);
  }, [filter]);

  return (
    <div ref={paneRef} className="flex min-w-0 flex-col gap-3 @3xl:sticky @3xl:top-20">
      <SearchInput
        label="Filter files"
        placeholder="Filter files"
        value={filter}
        onValueChange={setFilter}
        data-sources-filter=""
      />
      <div className="rounded-lg border bg-card p-1">
        <TreeView
          aria-label="Files"
          nodes={tree.children ?? []}
          getId={nodeId}
          getLabel={nodeLabel}
          getChildren={nodeChildren}
          isLeaf={nodeIsLeaf}
          selectedId={selectedPath}
          onSelect={(node) => selectPath(node.path)}
          filter={predicate}
          empty={`No files match ‘${filter}’.`}
        />
      </div>
      <SearchInput
        label={searchLabel}
        placeholder="Search contents"
        value={searchQuery}
        onValueChange={onSearchChange}
      />
      <SearchResults search={search} query={searchQuery} onOpen={selectPath} />
    </div>
  );
}

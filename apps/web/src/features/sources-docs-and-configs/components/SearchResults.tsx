/**
 * Server-side content+name search results (REQ-SEARCH-01/SC-03).
 *
 * Presentational over the {@link SearchState} the page drives via a debounced `runSearch`. Each
 * result is a whole-row button that opens its file in the same page (`onOpen` → `selectPath`);
 * the component is agnostic to what opens it (Docs → MarkdownView, Configs → FileViewer).
 * Snippets render as plain text — never HTML. Every status conveys meaning by role + text,
 * never colour alone.
 */

import type { SourceSearchMatch } from "@deck/server/sources";
import type { JSX } from "react";
import { Callout, EmptyState, ErrorState, Icon, List, ListItem, LoadingState } from "@/ui";
import type { SearchState } from "../client.js";

export interface SearchResultsProps {
  /** Current search state. "idle" renders nothing. */
  readonly search: SearchState;
  /** The current query text, echoed in the no-match announcement. */
  readonly query: string;
  /** Raised when the operator activates a result → parent calls selectPath(path). */
  readonly onOpen: (path: string) => void;
}

function matchLabel(match: SourceSearchMatch): string {
  return match.kind === "content" ? `${match.path}:${match.line ?? 0}` : match.path;
}

export function SearchResults({ search, query, onOpen }: SearchResultsProps): JSX.Element | null {
  switch (search.status) {
    case "idle":
      return null;
    case "loading":
      return <LoadingState label="Searching…" rows={2} />;
    case "error":
      return <ErrorState compact title="Search failed" message={search.error.message} />;
    case "ready": {
      const { result } = search;
      if (result.matches.length === 0) {
        return <EmptyState compact icon="search-x" title={`No matches for ‘${query}’.`} />;
      }
      return (
        <div className="flex flex-col gap-2">
          <List variant="divided" aria-label="Search results">
            {result.matches.map((match) => (
              <ListItem
                key={`${match.kind}:${match.path}:${match.line ?? 0}`}
                leading={
                  <Icon
                    name={match.kind === "content" ? "search" : "file"}
                    className="text-muted-foreground"
                  />
                }
                title={<span className="font-mono text-xs break-all">{matchLabel(match)}</span>}
                description={
                  match.kind === "content" && match.snippet != null ? (
                    <span className="text-xs break-words">{match.snippet}</span>
                  ) : undefined
                }
                onSelect={() => onOpen(match.path)}
              />
            ))}
          </List>
          {result.truncated === true && (
            <Callout tone="info" role="status" compact>
              Showing the first 200 matches — narrow your query.
            </Callout>
          )}
        </div>
      );
    }
  }
}

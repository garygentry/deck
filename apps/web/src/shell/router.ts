/**
 * The app's routing surface, built on wouter.
 *
 * Features import routing hooks from here rather than from wouter directly, so
 * the router stays swappable and tests can mock one module. The hook shapes
 * (`url`/`path`/`query`/`route` and `params`) are the app's own contract.
 */
import { useMemo } from "react";
import { useLocation as useWouterLocation, useParams, useSearch } from "wouter";

export { Link, Redirect, Route, Router, Switch } from "wouter";

export interface AppLocation {
  /** Path plus search string, e.g. `/drift?severity=error`. */
  url: string;
  /** Path only, e.g. `/drift`. */
  path: string;
  /** Parsed search parameters (last value wins for repeated keys). */
  query: Record<string, string>;
  /** Navigate to `url`; `replace` swaps the current history entry. */
  route: (url: string, replace?: boolean) => void;
}

export interface AppRoute {
  path: string;
  query: Record<string, string>;
  /** Decoded route params; a malformed escape is left as-is. */
  params: Record<string, string>;
}

function parseQuery(search: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) query[key] = value;
  return query;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function useLocation(): AppLocation {
  const [path, navigate] = useWouterLocation();
  const search = useSearch();
  return useMemo(
    () => ({
      url: search ? `${path}?${search}` : path,
      path,
      query: parseQuery(search),
      route: (url: string, replace?: boolean) => navigate(url, { replace: replace === true }),
    }),
    [path, search, navigate],
  );
}

export function useRoute(): AppRoute {
  const [path] = useWouterLocation();
  const search = useSearch();
  const raw = useParams() as Record<string, string | undefined>;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && !/^\d+$/.test(key)) params[key] = safeDecode(value);
  }
  return { path, query: parseQuery(search), params };
}

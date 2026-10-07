import { Suspense, useEffect } from "react";
import { Callout, LoadingState, PageErrorBoundary, useDocumentTitle } from "@/ui";
import { Route, Router, Switch, useLocation } from "./router.js";
import { getPages } from "../registry/registry.js";
import { useRegistryVersion } from "../registry/use-registry.js";
import { AppShell } from "./AppShell.js";
import { useBrandTitle } from "./manifest-slot.js";
import { ModuleNotEnabledPage } from "./ModuleNotEnabledPage.js";
import { matchPage } from "./nav.js";
import { NotFoundPage } from "./NotFoundPage.js";
import { resolveRoutes, type ResolvedRoutes } from "./routes.js";
import { useConfig, useUiManifest } from "../data/index.js";

export function App({ url }: { url?: string } = {}) {
  return (
    <Router ssrPath={url}>
      <LinkInterceptor />
      <Shell />
    </Router>
  );
}

/** The frame around the routed page; reads the location, so it sits inside the Router. */
function Shell() {
  // Re-render when an extension registers late (a lazily loaded module).
  useRegistryVersion();
  const routes = resolveRoutes(useUiManifest(), getPages());
  const { path } = useLocation();
  const config = useConfig();
  const title = (matchPage(routes.routed, path) ?? matchPage(routes.notEnabled, path))?.label;
  useDocumentTitle(title ?? "Not found", useBrandTitle());

  return (
    <AppShell pages={routes.routed} path={path} title={title}>
      {config.status === "error" && (
        <Callout tone="danger" title="Failed to load config" className="mb-4">
          {config.message}
        </Callout>
      )}
      <RoutedContent routes={routes} />
    </AppShell>
  );
}

/**
 * Routes plain same-origin `<a href>` clicks client-side, so ordinary anchors
 * anywhere in the app navigate without a full page reload (and keep in-memory
 * state such as runtime registry entries). Clicks the browser should own are
 * left alone: modified or non-primary clicks, already-handled (default
 * prevented) clicks, cross-origin links, in-page `#` links, links targeting
 * another browsing context, and downloads.
 */
function LinkInterceptor() {
  const { route } = useLocation();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const link = event
        .composedPath()
        .find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && el.href !== "");
      if (!link) return;
      const href = link.getAttribute("href") ?? "";
      if (
        link.origin !== window.location.origin ||
        href.startsWith("#") ||
        !/^(_?self)?$/i.test(link.target) ||
        link.hasAttribute("download")
      ) {
        return;
      }
      event.preventDefault();
      route(link.href.slice(window.location.origin.length));
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [route]);
  return null;
}

/**
 * The routed page area, wrapped in a shell-level error boundary so a render throw
 * in any page degrades to a retryable fallback instead of blanking the whole app
 * (the header and nav stay usable). The boundary resets on route change, keyed by
 * the current path. Rendered inside the Router so it can read the location.
 */
function RoutedContent({ routes }: { routes: ResolvedRoutes }) {
  const { path } = useLocation();
  return (
    <PageErrorBoundary resetKey={path}>
      {/* Heavy pages register lazy components; this covers their first load. */}
      <Suspense fallback={<LoadingState label="Loading page…" />}>
        <Switch>
          {routes.routed.map((page) => (
            <Route key={page.id} path={page.path} component={page.component} />
          ))}
          {/* A disabled module's page: say the module is off, not that nothing is there. */}
          {routes.notEnabled.map((route) => (
            <Route key={route.id} path={route.path}>
              <ModuleNotEnabledPage route={route} />
            </Route>
          ))}
          <Route component={NotFoundPage} />
        </Switch>
      </Suspense>
    </PageErrorBoundary>
  );
}

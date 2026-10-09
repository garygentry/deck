import { UI_CONFIG_MODULE } from "@deck/module-sdk";
import { Suspense, useEffect } from "react";
import { Callout, LoadingState, PageErrorBoundary, useDocumentTitle } from "@/ui";
import { Route, Router, Switch, useLocation } from "./router.js";
import { getPages } from "../registry/registry.js";
import { useRegistryVersion } from "../registry/use-registry.js";
import { AppShell } from "./AppShell.js";
import { bootHome } from "./boot.js";
import { configPageRegistrations } from "./config-page/routes.js";
import { useBrandTitle } from "./manifest-slot.js";
import { ModuleNotEnabledPage } from "./ModuleNotEnabledPage.js";
import { NotFoundPage } from "./NotFoundPage.js";
import { ReloadNotice } from "./ReloadNotice.js";
import { HOME_PATH, resolveRoutes, routeForPath, routeLabel, type ResolvedRoutes } from "./routes.js";
import { useConfig, useUiManifest, type UiManifestState } from "../data/index.js";

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
  const manifest = useUiManifest();
  // Config pages (`ui.pages`) exist only in the manifest; they route like any module's page.
  const routes = resolveRoutes(manifest, [...getPages(), ...configPageRegistrations(manifest)], bootHome());
  const { path } = useLocation();
  const config = useConfig();
  const pending = awaitingConfigPage(manifest, routes, path, bootHome());
  const route = routeForPath(routes, path);
  const title = pending ? "Loading" : route === undefined ? undefined : routeLabel(manifest, route);
  useDocumentTitle(title ?? "Not found", useBrandTitle());

  return (
    <AppShell pages={routes.routed} home={routes.home} path={path} title={title}>
      {config.status === "error" && (
        <Callout tone="danger" title="Failed to load config" className="mb-4">
          {config.message}
        </Callout>
      )}
      <ReloadNotice />
      {pending ? <LoadingState label="Loading page…" /> : <RoutedContent routes={routes} />}
    </AppShell>
  );
}

/**
 * Whether the page at `path` may be a config page the manifest has yet to deliver: while it
 * loads, `/` when the server says the home page is a config page (`page:ui/…`), and any path
 * no registered page matches. Rendering a loading state then, instead of the portal or "not
 * found", keeps a config home page or a deep link to one from flashing the wrong page.
 */
export function awaitingConfigPage(manifest: UiManifestState, routes: ResolvedRoutes, path: string, home: string | null | undefined): boolean {
  if (manifest.status !== "loading") return false;
  if (path === HOME_PATH) return typeof home === "string" && home.startsWith(`page:${UI_CONFIG_MODULE}/`);
  return routeForPath(routes, path) === undefined;
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
          {/* The home page, chosen by id: first, so no page sharing the path can take it. */}
          {routes.home !== undefined && <Route key="home" path={HOME_PATH} component={routes.home.component} />}
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

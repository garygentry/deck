import type { ReactNode } from "react";
import { SidebarInset, SidebarProvider, TooltipProvider } from "@/ui";
import type { PageRegistration } from "../registry/registry-types.js";
import { AppSidebar } from "./AppSidebar.js";
import { Topbar } from "./Topbar.js";

const SIDEBAR_COOKIE = "sidebar_state";

/** The sidebar remembers open/collapsed in a cookie (written by SidebarProvider). */
function sidebarDefaultOpen(): boolean {
  if (typeof document === "undefined") return true;
  const match = document.cookie.match(new RegExp(`(?:^|; )${SIDEBAR_COOKIE}=(true|false)`));
  return match ? match[1] === "true" : true;
}

/**
 * The application frame: skip link, sidebar navigation, top bar, and exactly one
 * `<main id="main">`.
 */
export function AppShell({
  pages,
  home,
  path,
  title,
  children,
}: {
  pages: readonly PageRegistration[];
  /** The page `/` renders. */
  home?: PageRegistration;
  path: string;
  title: string | undefined;
  children: ReactNode;
}) {
  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen()}>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-[3px] focus:ring-ring/50"
      >
        Skip to content
      </a>
      <AppSidebar pages={pages} home={home} path={path} />
      {/* min-w-0: let wide page content wrap or scroll instead of widening the column. */}
      <SidebarInset className="min-w-0">
        <TooltipProvider>
          <Topbar title={title} />
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none md:px-6"
          >
            {children}
          </main>
        </TooltipProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}

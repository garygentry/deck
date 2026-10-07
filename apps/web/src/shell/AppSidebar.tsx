import { useEffect } from "react";
import {
  Icon,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/ui";
import type { PageRegistration } from "../registry/registry-types.js";
import { groupNavPages, isNavActive } from "./nav.js";

/**
 * The primary navigation, built from the page registry: grouped, with icons, and
 * the current section marked `aria-current="page"` (detail routes keep their
 * list page active). Collapses to icons on desktop; a sheet below `md`.
 */
export function AppSidebar({ pages, path }: { pages: readonly PageRegistration[]; path: string }) {
  // Nav links route in-app, so nothing unmounts the mobile sheet: close it on
  // every navigation or it keeps covering the page just chosen.
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [path, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Deck">
              <a href="/">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                  D
                </span>
                <span className="text-base font-semibold">Deck</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Primary">
          {groupNavPages(pages).map(({ label, pages: groupPages }) => (
            <SidebarGroup key={label ?? "_ungrouped"}>
              {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {groupPages.map((page) => {
                    const active = isNavActive(page.path, path);
                    return (
                      <SidebarMenuItem key={page.id}>
                        <SidebarMenuButton asChild isActive={active} tooltip={page.label}>
                          <a href={page.path} aria-current={active ? "page" : undefined}>
                            <Icon name={page.icon ?? "circle"} />
                            <span>{page.label}</span>
                          </a>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

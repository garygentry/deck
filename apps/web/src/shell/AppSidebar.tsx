import { useEffect, useState } from "react";
import {
  APP_TITLE,
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
import { useUiManifest } from "../data/index.js";
import type { PageRegistration } from "../registry/registry-types.js";
import { brandInitial, brandMark, brandTitle, type BrandMark } from "./manifest-slot.js";
import { isLinkActive, resolveNav } from "./nav.js";

/**
 * The brand and the primary navigation, both from the UI manifest: grouped, with icons, and
 * the current section marked `aria-current="page"` (detail routes keep their list page
 * active). Collapses to icons on desktop; a sheet below `md`.
 */
export function AppSidebar({
  pages,
  home,
  path,
}: {
  pages: readonly PageRegistration[];
  /** The page `/` renders: its nav entry links to `/`. */
  home?: PageRegistration;
  path: string;
}) {
  const manifest = useUiManifest();
  const brand = brandTitle(manifest);
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
            <SidebarMenuButton asChild size="lg" tooltip={brand}>
              {/* A stable name even before the manifest (and so the brand) has loaded. */}
              <a href="/" aria-label={brand ?? APP_TITLE}>
                <BrandMarkView mark={brandMark(manifest)} brand={brand} />
                <span className="truncate text-base font-semibold">{brand}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Primary">
          {resolveNav(manifest, pages, home).map(({ id, label, links }) => (
            <SidebarGroup key={id ?? "_ungrouped"}>
              {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {links.map((link) => {
                    const active = isLinkActive(link, path);
                    return (
                      <SidebarMenuItem key={link.id}>
                        <SidebarMenuButton asChild isActive={active} tooltip={link.label}>
                          <a href={link.href} aria-current={active ? "page" : undefined}>
                            <Icon name={link.icon ?? "circle"} />
                            <span>{link.label}</span>
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

/**
 * The brand's square mark, decorative (the link carries the name): the logo image, else the
 * icon, else the title's initial. A logo that fails to load falls back to the initial.
 */
function BrandMarkView({ mark, brand }: { mark: BrandMark; brand: string | undefined }) {
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  if (mark.kind === "logo" && mark.url !== failedUrl) {
    return (
      <img
        src={mark.url}
        alt=""
        aria-hidden="true"
        data-brand-mark="logo"
        className="size-8 shrink-0 rounded-md object-contain"
        onError={() => setFailedUrl(mark.url)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-brand-mark={mark.kind === "icon" ? "icon" : "initial"}
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground"
    >
      {mark.kind === "icon" ? <Icon name={mark.name} size={18} /> : brandInitial(brand)}
    </span>
  );
}

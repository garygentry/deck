import { Separator, SidebarTrigger } from "@/ui";
import { HealthHeaderRegion } from "./health-header/HealthHeaderRegion.js";
import { ThemeMenu } from "./ThemeMenu.js";

/** The sticky top bar: sidebar toggle, current page, health pills, theme menu. */
export function Topbar({ title }: { title: string | undefined }) {
  return (
    <header
      aria-label="Deck"
      className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-4"
    >
      <SidebarTrigger aria-label="Toggle navigation" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
      {title && <span className="hidden truncate text-sm font-medium sm:inline">{title}</span>}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <HealthHeaderRegion />
        <ThemeMenu />
      </div>
    </header>
  );
}

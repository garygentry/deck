import { ToggleGroup, ToggleGroupItem, TooltipProvider } from "@/ui";
import type { ThemeMode } from "@deck/contract";
import { useThemeMode } from "../../shell/use-theme.js";
import { SECTIONS } from "./sections/index.js";

/** The toggle's display order of the contract's modes. */
const MODES = ["light", "dark", "system"] as const satisfies readonly ThemeMode[];

/**
 * The dev-only component workbench: every `@/ui` component in every state, one
 * section per catalogue group, in light and dark. Visual snapshots of this page
 * are the library's regression baseline.
 */
export function UiWorkbench() {
  const [mode, setMode] = useThemeMode();

  // Tooltips need a provider; the app root gains one with the new shell (P4).
  return (
    <TooltipProvider>
      <div data-slot="ui-workbench" className="mx-auto flex max-w-6xl flex-col gap-8 p-4 md:p-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">UI workbench</h1>
            <p className="text-sm text-muted-foreground">
              Every <code className="font-mono">@/ui</code> component, in every state.
            </p>
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            aria-label="Theme"
            value={mode}
            onValueChange={(next) => next && setMode(next as ThemeMode)}
          >
            {MODES.map((m) => (
              <ToggleGroupItem key={m} value={m} className="px-3 capitalize">
                {m}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </header>

        <nav aria-label="Workbench sections">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-primary underline-offset-4 hover:underline">
                  {section.catalogue ? `${section.catalogue}. ` : ""}
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {SECTIONS.map(({ id, title, catalogue, Demo }) => (
          <section key={id} id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
            <h2 id={`${id}-title`} className="text-lg font-semibold">
              {catalogue ? `${catalogue}. ` : ""}
              {title}
            </h2>
            <Demo />
          </section>
        ))}
      </div>
    </TooltipProvider>
  );
}

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Icon,
  type IconName,
} from "@/ui";
import type { ThemeMode } from "@deck/contract";
import { useThemeMode } from "./use-theme.js";

const MODES: readonly { mode: ThemeMode; label: string; icon: IconName }[] = [
  { mode: "light", label: "Light", icon: "sun" },
  { mode: "dark", label: "Dark", icon: "moon" },
  { mode: "system", label: "System", icon: "monitor" },
];

/** Top-bar theme picker: the trigger names the current preference ("Theme: dark"). */
export function ThemeMenu() {
  const [mode, setMode] = useThemeMode();
  const current = MODES.find((m) => m.mode === mode) ?? MODES[2]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${mode}`}>
          <Icon name={current.icon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(next) => setMode(next as ThemeMode)}>
          {MODES.map(({ mode: value, label, icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon name={icon} />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
